/**
 * Per-source video frame extractor for the export pipeline.
 *
 * Pipeline: File bytes → mp4box (demux samples) → VideoDecoder (decode to
 * VideoFrames) → frame lookup by source-time.
 *
 * The compositor advances through timeline-time monotonically, so for each
 * clip the requested source-time advances monotonically too (modulo speed).
 * We exploit that: we keep a small ring of recent frames and a queue of
 * pending samples to feed the decoder just-in-time. As source-time advances
 * past a frame we `.close()` it to free GPU memory.
 *
 * Non-MP4 sources fall back to HTMLVideoElement + seek-and-grab in
 * `FallbackVideoSourceDecoder`. Slower but works for WebM, MOV-with-non-
 * H.264, etc.
 */

import { createFile, type ISOFile, type MP4BoxBuffer, type Track, type VisualSampleEntry } from 'mp4box';

export interface VideoSourceDecoder {
  /** Returns the most-recently-decoded frame whose source time ≤ `sourceTime`.
   *  Advances decode as needed. Null if past the end of the source. */
  frameAt(sourceTime: number): Promise<VideoFrame | null>;
  /** Free all resources. Closes any pending frames. */
  close(): Promise<void>;
}

/** Open a decoder for a given media file. Tries MP4+WebCodecs first; falls
 *  back to HTMLVideoElement extraction on non-MP4 containers. */
export async function openVideoSource(file: File): Promise<VideoSourceDecoder> {
  // Quick magic-byte sniff for MP4. ftyp box starts at offset 4.
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isMp4 = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70; // 'ftyp'

  if (isMp4) {
    try {
      return await Mp4WebCodecsDecoder.open(file);
    } catch (e) {
      console.warn('mp4box/WebCodecs decode failed, falling back to HTMLVideoElement:', e);
    }
  }
  // Non-MP4 or MP4-with-unsupported-codec: HTMLVideoElement seek-and-grab.
  return FallbackVideoSourceDecoder.open(file);
}

/** How many frames AHEAD of the current sourceTime we keep decoded and
 *  ready in memory. Each VideoFrame holds GPU memory (~6MB @ 1080p) so we
 *  don't want this big. But we MUST keep enough lookahead to absorb B-frame
 *  reordering — the decoder can hold a sub-GOP internally before it can
 *  emit display-ordered frames, and we don't want to throttle that work. */
const LOOKAHEAD_FRAMES = 16;
/** Hard ceiling on the ring just in case something goes off the rails.
 *  Past sourceTime we shouldn't normally store frames — `frameAt` evicts
 *  as it moves forward — but if the caller calls frameAt non-monotonically
 *  without triggering the seek-back path, this prevents runaway memory. */
const RING_HARD_CAP = 64;

class Mp4WebCodecsDecoder implements VideoSourceDecoder {
  private decoder!: VideoDecoder;
  private decoderConfig!: VideoDecoderConfig;
  private readonly timescale: number;
  private readonly samples: Array<{ data: Uint8Array; cts: number; dts: number; isSync: boolean; duration: number }> = [];
  private nextSampleIdx = 0;
  /** Decoded frames sorted ascending by source time (seconds). */
  private frames: VideoFrame[] = [];
  private closed = false;
  private decoderError: Error | null = null;
  /** Highest sourceTime we've satisfied. If a caller asks for something
   *  earlier we need to seek back to a keyframe and re-decode forward. */
  private lastServedTime = -Infinity;

  private constructor(timescale: number) {
    this.timescale = timescale;
  }

  static async open(file: File): Promise<Mp4WebCodecsDecoder> {
    const iso = createFile();
    type SampleEntry = { data: Uint8Array; cts: number; dts: number; isSync: boolean; duration: number };
    const collectedSamples: SampleEntry[] = [];
    let videoTrackId = -1;

    // Wire ALL callbacks before appendBuffer. Critically, set up extraction
    // (setExtractionOptions + onSamples) INSIDE onReady so it's active when
    // mp4box parses the mdat data immediately after the moov box.
    // Previously we set extraction after appendBuffer returned — by then
    // mp4box had already finished parsing and no samples ever reached
    // onSamples. Symptom: video frames silently missing from the export
    // while audio still rendered (audio path is main-thread Web Audio).
    const readyPromise = new Promise<{ codec: string; codedWidth: number; codedHeight: number; description: Uint8Array; timescale: number }>((resolve, reject) => {
      iso.onError = (e) => reject(new Error(e));
      iso.onSamples = (id, _user, samples) => {
        if (id !== videoTrackId) return;
        for (const s of samples) {
          if (!s.data || s.data.byteLength === 0) continue;
          // Copy via fresh Uint8Array to guarantee:
          //   - Plain ArrayBuffer (not SharedArrayBuffer that some Chromium
          //     builds reject in EncodedVideoChunk).
          //   - Bytes belong to this sample alone, not aliased with mp4box's
          //     internal storage that may be reused.
          // Store as Uint8Array view; EncodedVideoChunk accepts any
          // BufferSource and the typed-array form avoids ArrayBuffer.slice
          // quirks across mp4box buffer types.
          const copy = new Uint8Array(s.data.byteLength);
          copy.set(s.data);
          collectedSamples.push({
            data: copy,
            cts: s.cts,
            dts: s.dts,
            isSync: !!s.is_sync,
            duration: s.duration,
          });
        }
      };
      iso.onReady = (info) => {
        const videoTrack = info.tracks.find((t: Track) => t.type === 'video');
        if (!videoTrack) {
          reject(new Error('No video track in source'));
          return;
        }
        try {
          const description = extractAvcCDescription(iso, videoTrack.id);
          videoTrackId = videoTrack.id;
          iso.setExtractionOptions(videoTrack.id, null, { nbSamples: 200 });
          iso.start();
          resolve({
            codec: videoTrack.codec,
            codedWidth: (videoTrack as Track & { video?: { width: number; height: number } }).video?.width ?? 0,
            codedHeight: (videoTrack as Track & { video?: { width: number; height: number } }).video?.height ?? 0,
            description,
            timescale: videoTrack.timescale,
          });
        } catch (err) {
          reject(err);
        }
      };
    });

    // Feed the entire file to mp4box. (Streaming would be a micro-optimization;
    // a 100MB MP4 is fine to load fully.) onReady fires synchronously when
    // the moov is parsed; setExtractionOptions runs immediately so onSamples
    // captures every sample as mp4box continues through the mdat.
    const buf = await file.arrayBuffer() as ArrayBuffer & { fileStart?: number };
    (buf as MP4BoxBuffer).fileStart = 0;
    iso.appendBuffer(buf as MP4BoxBuffer);
    iso.flush();

    const trackInfo = await readyPromise;

    const inst = new Mp4WebCodecsDecoder(trackInfo.timescale);
    // NOTE on codedWidth/codedHeight: mp4box reports the *visual* dimensions
    // from the track header (tkhd). H.264's *coded* dimensions are
    // macroblock-aligned (multiples of 16) and live inside the SPS, which is
    // already in `description`. If we tell the decoder a coded size that
    // doesn't match the SPS-derived one, it rejects with a generic
    // "Decoding error". Omit them — the decoder reads the real coded dims
    // from the SPS.
    //
    // Try software decoding first — Linux Chromium often lacks GPU H.264
    // decode, and even when present hardware decoders are stricter about
    // unusual SPS shapes (custom display windows, non-standard aspect ratios,
    // odd visual dimensions like 1514×712). Software decoders accept those.
    const baseConfig: VideoDecoderConfig = {
      codec: trackInfo.codec,
      description: trackInfo.description,
    };

    const candidates: VideoDecoderConfig[] = [
      { ...baseConfig, hardwareAcceleration: 'prefer-software' },
      { ...baseConfig, hardwareAcceleration: 'no-preference' },
      { ...baseConfig, hardwareAcceleration: 'prefer-hardware' },
    ];

    // Active probe: try to actually decode the first keyframe with each
    // candidate config. `isConfigSupported` can lie (especially in
    // Chromium-Linux: claims support, then actual decode fires
    // EncodingError). Active probe catches that.
    const firstKeyframe = collectedSamples.find((s) => s.isSync);
    if (!firstKeyframe) {
      throw new Error('Source has no keyframe — cannot decode');
    }

    let chosenConfig: VideoDecoderConfig | null = null;
    let lastReason = '';
    for (const cfg of candidates) {
      try {
        const probe = await VideoDecoder.isConfigSupported(cfg);
        if (!probe.supported) {
          lastReason = `isConfigSupported false (hwAccel=${cfg.hardwareAcceleration})`;
          continue;
        }
        const probedCfg = probe.config ?? cfg;
        const decodeResult = await activeDecodeProbe(probedCfg, firstKeyframe);
        if (decodeResult === 'ok') {
          chosenConfig = probedCfg;
          break;
        }
        lastReason = `actual decode failed (hwAccel=${cfg.hardwareAcceleration}): ${decodeResult}`;
      } catch (e) {
        lastReason = e instanceof Error ? e.message : String(e);
      }
    }
    if (!chosenConfig) {
      throw new Error(
        `Browser cannot decode this H.264 source. ` +
        `codec=${trackInfo.codec}, visual ${trackInfo.codedWidth}x${trackInfo.codedHeight}, ` +
        `${trackInfo.description.byteLength}-byte avcC. ` +
        `Last probe: ${lastReason}. ` +
        `Likely cause: this browser ships without an H.264 decoder (common on Linux Chromium). ` +
        `Workarounds: use Chrome/Edge on Windows/macOS, or re-encode the source as Baseline/Main profile MP4.`,
      );
    }
    inst.decoderConfig = chosenConfig;

    inst.decoder = new VideoDecoder({
      output: (frame) => inst.handleDecodedFrame(frame),
      error: (e) => {
        const name = (e as { name?: string })?.name ?? 'DecoderError';
        const message = (e as { message?: string })?.message ?? String(e);
        inst.decoderError = new Error(
          `VideoDecoder ${name}: ${message} ` +
          `(codec=${trackInfo.codec}, visual ${trackInfo.codedWidth}x${trackInfo.codedHeight}, ` +
          `${trackInfo.description.byteLength}-byte avcC, hwAccel=${inst.decoderConfig.hardwareAcceleration}). ` +
          `If repeatable: re-encode the source as standard H.264 Baseline/Main/High at a common resolution.`,
        );
      },
    });
    try {
      inst.decoder.configure(inst.decoderConfig);
    } catch (e) {
      throw new Error(`VideoDecoder.configure failed for codec ${trackInfo.codec}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Sort samples ascending by dts (decode order). The collected array is
    // mostly in dts order already but mp4box can emit them in chunks that
    // jump back during fragment boundaries.
    collectedSamples.sort((a, b) => a.dts - b.dts);
    inst.samples.push(...collectedSamples);

    if (inst.samples.length === 0) {
      throw new Error('mp4box extracted zero video samples — source may not contain H.264 or the moov box is at the end of the file');
    }

    return inst;
  }

  private handleDecodedFrame(frame: VideoFrame): void {
    if (this.closed) {
      frame.close();
      return;
    }
    // Insert sorted ascending by timestamp.
    const ts = frame.timestamp / 1_000_000;
    let i = this.frames.length;
    while (i > 0 && (this.frames[i - 1].timestamp / 1_000_000) > ts) i--;
    this.frames.splice(i, 0, frame);

    // Hard cap is a runaway-protection only. Normally frameAt evicts as
    // sourceTime advances. Critically, we DON'T evict by count when we're
    // under the hard cap — earlier versions dropped the oldest frame here,
    // which on a fast hardware decoder evicted the frames near t=0 before
    // the caller could read them (the user observed framesInRing=16 at
    // t≈5.7s while requesting t=0.027). Eviction must be sourceTime-driven.
    while (this.frames.length > RING_HARD_CAP) {
      // Drop the NEWEST when the runaway cap is hit. Newest frames mean we
      // got way ahead — we want to keep frames near the current request.
      const dropped = this.frames.pop();
      dropped?.close();
    }
  }

  /** Seek to the latest keyframe at or before the given source time.
   *  Resets the decoder, reconfigures, clears frame state, and rewinds
   *  `nextSampleIdx` so the next frameAt() call decodes forward from there. */
  private seekBackTo(sourceTime: number): void {
    const targetCts = sourceTime * this.timescale;
    let kfIdx = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.cts > targetCts) break;
      if (s.isSync) kfIdx = i;
    }
    try {
      this.decoder.reset();
      this.decoder.configure(this.decoderConfig);
    } catch (e) {
      this.decoderError = e instanceof Error ? e : new Error(String(e));
      return;
    }
    for (const f of this.frames) f.close();
    this.frames = [];
    this.nextSampleIdx = kfIdx;
    this.lastServedTime = -Infinity;
  }

  async frameAt(sourceTime: number): Promise<VideoFrame | null> {
    if (this.closed) return null;
    if (this.decoderError) throw this.decoderError;

    // Seek-back when the caller asks for an earlier time than we've already
    // decoded past. Happens when two clips share the same media but their
    // source ranges are reordered on the timeline. We allow a small slack
    // to absorb floating-point jitter without triggering a re-seek.
    const SLACK = 0.05;
    if (sourceTime < this.lastServedTime - SLACK) {
      this.seekBackTo(sourceTime);
    }

    // The first sample we feed to the decoder after open or seek MUST be a
    // keyframe; otherwise VideoDecoder rejects with a generic "Decoding error".
    if (this.nextSampleIdx === 0 && this.samples.length > 0 && !this.samples[0].isSync) {
      let i = 0;
      while (i < this.samples.length && !this.samples[i].isSync) i++;
      if (i >= this.samples.length) {
        throw new Error('No keyframes found in source video — file may be corrupt');
      }
      this.nextSampleIdx = i;
    }

    // Sample pushing is throttled three ways:
    //   1. Don't push if decoder's internal queue has > 32 unprocessed chunks.
    //   2. Don't push if we already have LOOKAHEAD_FRAMES ready frames whose
    //      timestamp is ≥ sourceTime (we're ahead enough).
    //   3. Don't push if the ring is at the hard cap.
    // Pre-fast-decoder hardware can output frames many times faster than we
    // consume them. Without throttling, the ring fills past sourceTime, the
    // decoder keeps outputting, and frames around the current sourceTime
    // get evicted.
    const framesAheadOf = (t: number): number => {
      let n = 0;
      for (const f of this.frames) {
        if (f.timestamp / 1_000_000 >= t) n++;
      }
      return n;
    };
    const pushAvailable = () => {
      while (
        this.nextSampleIdx < this.samples.length &&
        this.decoder.decodeQueueSize < 32 &&
        framesAheadOf(sourceTime) < LOOKAHEAD_FRAMES &&
        this.frames.length < RING_HARD_CAP
      ) {
        const s = this.samples[this.nextSampleIdx++];
        try {
          this.decoder.decode(new EncodedVideoChunk({
            type: s.isSync ? 'key' : 'delta',
            timestamp: Math.round((s.cts * 1_000_000) / this.timescale),
            ...(s.duration > 0 ? { duration: Math.round((s.duration * 1_000_000) / this.timescale) } : {}),
            data: s.data,
          }));
        } catch (e) {
          throw new Error(`VideoDecoder.decode threw at sample ${this.nextSampleIdx - 1} (type=${s.isSync ? 'key' : 'delta'}, ${s.data.byteLength} bytes): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };

    pushAvailable();

    // Wait for a usable frame.
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      // Drop any frame older than the next one if both ≤ sourceTime.
      while (this.frames.length > 1 && (this.frames[1].timestamp / 1_000_000) <= sourceTime) {
        const dropped = this.frames.shift();
        dropped?.close();
      }
      // Case A: we have a frame at or before sourceTime → return the latest
      // such frame, provided we know what comes next (a frame past
      // sourceTime, or end of stream).
      if (this.frames.length > 0 && (this.frames[0].timestamp / 1_000_000) <= sourceTime) {
        if (
          this.frames.length > 1 ||
          (this.nextSampleIdx >= this.samples.length && this.decoder.decodeQueueSize === 0)
        ) {
          this.lastServedTime = sourceTime;
          return this.frames[0];
        }
      }
      // Case B: sourceTime falls BEFORE the source's first decoded frame
      // (the source has an edit list, the user trimmed before t=0, or the
      // source genuinely starts at a non-zero timestamp). Return the
      // earliest available frame — the alternative is a black frame or
      // throwing, both worse than "show the closest content we have".
      if (
        this.frames.length > 0 &&
        (this.frames[0].timestamp / 1_000_000) > sourceTime &&
        this.frames.length >= Math.min(LOOKAHEAD_FRAMES, 4)
      ) {
        // Enough lookahead present that we're confident the decoder isn't
        // mid-flush; the earliest frame really is the source's earliest.
        this.lastServedTime = sourceTime;
        return this.frames[0];
      }
      if (this.decoderError) throw this.decoderError;
      if (this.nextSampleIdx >= this.samples.length && this.decoder.decodeQueueSize === 0) {
        // End of stream — return whatever we have.
        this.lastServedTime = sourceTime;
        return this.frames.length > 0 ? this.frames[this.frames.length - 1] : null;
      }
      pushAvailable();
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    // Timeout. Surface enough state to diagnose what went wrong.
    const stats =
      `lastServed=${this.lastServedTime.toFixed(3)}s, ` +
      `samplesFed=${this.nextSampleIdx}/${this.samples.length}, ` +
      `framesInRing=${this.frames.length}, ` +
      `decodeQueueSize=${this.decoder.decodeQueueSize}` +
      (this.frames.length > 0
        ? `, ringSpan=[${(this.frames[0].timestamp / 1_000_000).toFixed(3)}..${(this.frames[this.frames.length - 1].timestamp / 1_000_000).toFixed(3)}]s`
        : '');
    throw new Error(`VideoDecoder produced no frame for sourceTime=${sourceTime.toFixed(3)}s within 3s. ${stats}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.decoder.flush().catch(() => {});
      this.decoder.close();
    } catch {
      // ignore
    }
    for (const f of this.frames) f.close();
    this.frames = [];
  }
}

/** Spin up a throwaway VideoDecoder with the given config and try to decode
 *  one keyframe. Returns 'ok' if a VideoFrame comes out, or the error
 *  message if the decoder errors or times out. Used to validate that
 *  isConfigSupported's optimism actually holds. */
async function activeDecodeProbe(
  config: VideoDecoderConfig,
  keyframe: { data: Uint8Array; cts: number },
): Promise<'ok' | string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: 'ok' | string) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const decoder = new VideoDecoder({
      output: (frame) => {
        frame.close();
        settle('ok');
        try { decoder.close(); } catch { /* ignore */ }
      },
      error: (e) => {
        const msg = (e as { message?: string })?.message ?? String(e);
        settle(msg);
        try { decoder.close(); } catch { /* ignore */ }
      },
    });
    try {
      decoder.configure(config);
      // Pass a fresh copy of the keyframe bytes so any quirky implementation
      // that detaches BufferSources doesn't ruin the real decoder's chunk.
      decoder.decode(new EncodedVideoChunk({
        type: 'key',
        timestamp: 0,
        data: new Uint8Array(keyframe.data),
      }));
      decoder.flush().catch(() => {});
    } catch (e) {
      settle(e instanceof Error ? e.message : String(e));
      try { decoder.close(); } catch { /* ignore */ }
    }
    // Timeout — shouldn't fire in normal operation; protects against
    // decoders that neither output nor error.
    setTimeout(() => settle('timed out after 2s'), 2000);
  });
}

/** Build the AVCDecoderConfigurationRecord bytes (`description` for
 *  VideoDecoder.configure) directly from mp4box's parsed avcC fields.
 *
 *  Previously we serialized the box via mp4box's `write()` and stripped the
 *  8-byte header. That works in the canonical Google demo but produced bytes
 *  that VideoDecoder rejected with a generic "Decoding error" on some
 *  sources in this project. Reading the fields and laying out the bytes
 *  ourselves removes the serialization layer from the trust chain.
 *
 *  Layout (ISO/IEC 14496-15 §5.2.4):
 *    1 byte: configurationVersion (= 1)
 *    1 byte: AVCProfileIndication (from SPS profile_idc)
 *    1 byte: profile_compatibility (constraint_set flags)
 *    1 byte: AVCLevelIndication (from SPS level_idc)
 *    1 byte: 0xFC | (lengthSizeMinusOne & 0x03)
 *    1 byte: 0xE0 | (numSPS & 0x1F)
 *    for each SPS: 2 bytes BE length, then SPS NALU
 *    1 byte: numPPS
 *    for each PPS: 2 bytes BE length, then PPS NALU
 *    [optional `ext` bytes for High profiles] */
function extractAvcCDescription(file: ISOFile, trackId: number): Uint8Array {
  const trak = (file as unknown as { getTrackById: (id: number) => unknown }).getTrackById(trackId) as {
    mdia: { minf: { stbl: { stsd: { entries: VisualSampleEntry[] } } } };
  };
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries) throw new Error('Unable to read sample entries');
  for (const entry of entries) {
    const avcC = (entry as VisualSampleEntry & { avcC?: AvcCBoxShape }).avcC;
    if (!avcC) continue;
    return buildAvcCDescription(avcC);
  }
  throw new Error('No avcC sample entry found — source may be HEVC or use a codec we do not yet decode');
}

interface AvcCBoxShape {
  configurationVersion: number;
  AVCProfileIndication: number;
  profile_compatibility: number;
  AVCLevelIndication: number;
  lengthSizeMinusOne: number;
  SPS: Array<{ data: Uint8Array }>;
  PPS: Array<{ data: Uint8Array }>;
  ext?: Uint8Array;
}

function buildAvcCDescription(avcC: AvcCBoxShape): Uint8Array {
  let totalLen = 7; // 6 fixed bytes + 1 for numPPS
  for (const nalu of avcC.SPS) totalLen += 2 + nalu.data.byteLength;
  for (const nalu of avcC.PPS) totalLen += 2 + nalu.data.byteLength;
  if (avcC.ext) totalLen += avcC.ext.byteLength;

  const out = new Uint8Array(totalLen);
  let pos = 0;
  out[pos++] = avcC.configurationVersion ?? 1;
  out[pos++] = avcC.AVCProfileIndication;
  out[pos++] = avcC.profile_compatibility;
  out[pos++] = avcC.AVCLevelIndication;
  out[pos++] = 0xFC | (avcC.lengthSizeMinusOne & 0x03);
  out[pos++] = 0xE0 | (avcC.SPS.length & 0x1F);
  for (const nalu of avcC.SPS) {
    const len = nalu.data.byteLength;
    out[pos++] = (len >> 8) & 0xFF;
    out[pos++] = len & 0xFF;
    out.set(nalu.data, pos);
    pos += len;
  }
  out[pos++] = avcC.PPS.length & 0xFF;
  for (const nalu of avcC.PPS) {
    const len = nalu.data.byteLength;
    out[pos++] = (len >> 8) & 0xFF;
    out[pos++] = len & 0xFF;
    out.set(nalu.data, pos);
    pos += len;
  }
  if (avcC.ext && avcC.ext.byteLength > 0) {
    out.set(avcC.ext, pos);
    pos += avcC.ext.byteLength;
  }
  return out.subarray(0, pos);
}

/** Fallback: HTMLVideoElement + seek-and-grab. Slow (one seek per output
 *  frame) but works for any browser-playable codec. */
class FallbackVideoSourceDecoder implements VideoSourceDecoder {
  private readonly video: HTMLVideoElement;
  private readonly objectUrl: string;
  private cached: { time: number; frame: VideoFrame } | null = null;

  private constructor(video: HTMLVideoElement, objectUrl: string) {
    this.video = video;
    this.objectUrl = objectUrl;
  }

  static async open(file: File): Promise<FallbackVideoSourceDecoder> {
    if (typeof document === 'undefined') {
      throw new Error('Non-MP4 source detected; HTMLVideoElement fallback unavailable in worker context. Convert the source to MP4 (H.264) and retry.');
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Fallback video failed to load'));
    });
    return new FallbackVideoSourceDecoder(video, url);
  }

  async frameAt(sourceTime: number): Promise<VideoFrame | null> {
    if (Math.abs(this.video.currentTime - sourceTime) > 0.01) {
      await new Promise<void>((resolve) => {
        const onSeeked = () => { this.video.removeEventListener('seeked', onSeeked); resolve(); };
        this.video.addEventListener('seeked', onSeeked);
        this.video.currentTime = sourceTime;
      });
    }
    this.cached?.frame.close();
    const frame = new VideoFrame(this.video, { timestamp: Math.round(sourceTime * 1_000_000) });
    this.cached = { time: sourceTime, frame };
    return frame;
  }

  async close(): Promise<void> {
    this.cached?.frame.close();
    this.cached = null;
    this.video.src = '';
    URL.revokeObjectURL(this.objectUrl);
  }
}

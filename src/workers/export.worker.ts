/// <reference lib="webworker" />
/**
 * WebCodecs export worker. Replaces the FFmpeg.wasm worker.
 *
 * Inputs: a serialized project (clips, tracks, mediaFiles with File blobs),
 *         canvas dimensions, quality preset, and the pre-probed video codec.
 * Outputs: a fragmented MP4 ArrayBuffer.
 *
 * Pipeline per frame at t = frameIdx / FPS:
 *   1. Find active clips at t (sorted bottom→top by zIndex/track/start).
 *   2. For each clip:
 *        - video → pull most-recent decoded VideoFrame from its source decoder.
 *        - image → drawImageBitmap from pre-decoded bitmap.
 *        - text  → drawText (fonts pre-loaded).
 *   3. Wrap the OffscreenCanvas as a new VideoFrame and hand it to VideoEncoder.
 *   4. Close the VideoFrame immediately after encode (GPU memory!).
 *   5. Backpressure if encoder.encodeQueueSize > 30.
 *
 * Phase C: video-only. Audio comes in Phase D.
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import {
  computeClipAlpha,
  drawImageBitmap as drawImageBitmapClip,
  drawTextClip,
  drawVideoFrame,
  findActiveClipsAtTime,
} from '../services/canvasCompositor';
import type { Clip, ImageClip, ProjectState, TextClip, Track, VideoClip } from '../types/project';
import { FONT_FAMILIES, clipDuration, compareClipsForDrawing } from '../types/project';
import { openVideoSource, type VideoSourceDecoder } from '../services/videoSourceDecoder';
import { encodePcm, type PcmPayload } from '../services/audioGraphBuilder';
import { applyTransition } from '../services/transitionEffects';

export type QualityPreset = 'fast' | 'balanced' | 'quality';

export interface SerializedMediaFile {
  id: string;
  width: number;
  height: number;
  duration: number;
  kind: 'video' | 'image';
  hasAudio: boolean;
  file: File;
}

export interface ExportRequest {
  type: 'export';
  clips: Record<string, Clip>;
  tracks: Record<string, Track>;
  trackOrder: string[];
  mediaFiles: Record<string, SerializedMediaFile>;
  canvas: { width: number; height: number };
  quality: QualityPreset;
  videoCodec: string;
  /** Muxer-level audio codec ('aac' or 'opus'). null = export silent video. */
  audioCodec: 'aac' | 'opus' | null;
  /** WebCodecs-level audio encoder codec string (e.g. 'mp4a.40.2' or 'opus'). */
  audioEncoderCodec: string | null;
  /** Pre-rendered PCM (main thread rendered via OfflineAudioContext, since
   *  Web Audio isn't available in Workers on Firefox or older Chromium).
   *  null = no audio track. */
  audioPcm: PcmPayload | null;
  fps: number;
}

export type ExportMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; output: ArrayBuffer }
  | { type: 'error'; message: string }
  | { type: 'aborted' };

export type ExportControlMessage =
  | ExportRequest
  | { type: 'abort' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let aborted = false;

ctx.onmessage = async (ev: MessageEvent<ExportControlMessage>) => {
  if (ev.data.type === 'abort') {
    aborted = true;
    return;
  }
  aborted = false;
  try {
    const blob = await runExport(ev.data);
    if (aborted) {
      ctx.postMessage({ type: 'aborted' } satisfies ExportMessage);
      return;
    }
    ctx.postMessage({ type: 'done', output: blob } satisfies ExportMessage, { transfer: [blob] });
  } catch (e) {
    if (aborted) {
      ctx.postMessage({ type: 'aborted' } satisfies ExportMessage);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    ctx.postMessage({ type: 'error', message } satisfies ExportMessage);
  }
};

/** End-to-end orchestration for one export. */
async function runExport(req: ExportRequest): Promise<ArrayBuffer> {
  const { canvas, quality, videoCodec, fps } = req;
  const W = canvas.width;
  const H = canvas.height;

  // Build a ProjectState-like shape for the compositor helpers (they reach
  // into trackOrder/tracks/clips/mediaFiles).
  const projectState: ProjectState = {
    projectName: '',
    mediaFiles: Object.fromEntries(
      Object.entries(req.mediaFiles).map(([id, m]) => [
        id,
        {
          id: m.id,
          name: '',
          objectUrl: '',
          file: m.file,
          duration: m.duration,
          width: m.width,
          height: m.height,
          status: 'ready' as const,
          hasAudio: m.hasAudio,
          kind: m.kind,
        },
      ]),
    ),
    tracks: req.tracks,
    clips: req.clips,
    trackOrder: req.trackOrder,
    playheadPosition: 0,
    isPlaying: false,
    zoomLevel: 1,
    selectedClipIds: [],
    canvas: { width: W, height: H },
  };

  await loadFonts();

  const totalDuration = computeTimelineDuration(req.clips);
  if (totalDuration <= 0) throw new Error('Timeline is empty');
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));

  // Pre-decode image clips (one ImageBitmap per unique image media).
  const imageBitmaps = new Map<string, ImageBitmap>();
  for (const [id, m] of Object.entries(req.mediaFiles)) {
    if (m.kind === 'image') {
      imageBitmaps.set(id, await createImageBitmap(m.file));
    }
  }

  // Open a VideoSourceDecoder per unique video media.
  const videoDecoders = new Map<string, VideoSourceDecoder>();
  for (const [id, m] of Object.entries(req.mediaFiles)) {
    if (m.kind === 'video') {
      videoDecoders.set(id, await openVideoSource(m.file));
    }
  }

  // Audio track only if the main thread pre-rendered PCM AND the browser has
  // a working audio encoder. Chromium-Linux often lacks AAC; we'd fall back
  // to Opus or, failing that, no audio.
  const hasAudio = req.audioPcm !== null && req.audioCodec !== null && req.audioEncoderCodec !== null;
  const AUDIO_SAMPLE_RATE = req.audioPcm?.sampleRate ?? 48_000;

  // Configure VideoEncoder + mp4-muxer.
  const bitrate = computeBitrate(W, H, quality);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: W,
      height: H,
      frameRate: fps,
    },
    audio: hasAudio
      ? {
          codec: req.audioCodec as 'aac' | 'opus',
          numberOfChannels: 2,
          sampleRate: AUDIO_SAMPLE_RATE,
        }
      : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: videoCodec,
    width: W,
    height: H,
    bitrate,
    framerate: fps,
    latencyMode: 'quality',
  });

  // Composite canvas + two scratches for transition rendering.
  const offscreen = new OffscreenCanvas(W, H);
  const ctx2d = offscreen.getContext('2d');
  if (!ctx2d) throw new Error('OffscreenCanvas 2D context unavailable');
  const scratchPrev = new OffscreenCanvas(W, H);
  const scratchNext = new OffscreenCanvas(W, H);
  const sctxPrev = scratchPrev.getContext('2d');
  const sctxNext = scratchNext.getContext('2d');
  if (!sctxPrev || !sctxNext) throw new Error('Scratch canvas 2D context unavailable');

  // Pre-compute transition pairs and singleton orphans.
  const pairs = computeTransitionPairs(projectState);
  const orphans = computeSingletonOrphans(projectState, pairs);

  // Frame loop.
  const keyframeIntervalFrames = fps * 2; // 1 keyframe every 2s
  let lastProgressSent = 0;

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    if (aborted) throw new Error('Export aborted');
    if (encoderError) throw encoderError;

    const t = frameIdx / fps;

    // Clear to black.
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.globalAlpha = 1;

    // Active pairs + orphans at time t.
    const activePairsAtT = pairs.filter((p) => t >= p.windowStart && t < p.windowEnd);
    const activeOrphansAtT = orphans.filter((o) => t >= o.windowStart && t < o.windowEnd);
    const pairMembers = new Set<string>();
    for (const p of activePairsAtT) {
      pairMembers.add(p.prev.id);
      pairMembers.add(p.next.id);
    }
    const orphanMembers = new Set<string>();
    for (const o of activeOrphansAtT) {
      orphanMembers.add(o.clip.id);
    }

    // Compose layers in z-order. A "layer" is either a single clip, a pair,
    // or a singleton orphan. Members of pairs/orphans are suppressed from
    // the normal clip list so we don't double-draw.
    const layers: Layer[] = [];
    for (const clip of findActiveClipsAtTime(projectState, t)) {
      if (pairMembers.has(clip.id)) continue;
      if (orphanMembers.has(clip.id)) continue;
      layers.push({ kind: 'clip', clip });
    }
    for (const pair of activePairsAtT) {
      layers.push({ kind: 'pair', pair });
    }
    for (const orphan of activeOrphansAtT) {
      layers.push({ kind: 'orphan', orphan });
    }
    layers.sort((a, b) => compareClipsForDrawing(layerSortKey(a), layerSortKey(b), projectState.trackOrder));

    for (const layer of layers) {
      if (layer.kind === 'clip') {
        const alpha = computeClipAlpha(projectState, layer.clip, t);
        if (alpha <= 0.001) continue;
        ctx2d.globalAlpha = alpha;
        if (layer.clip.kind === 'video') {
          await drawClipVideo(ctx2d, layer.clip, t, videoDecoders, W, H);
        } else if (layer.clip.kind === 'image') {
          drawClipImage(ctx2d, layer.clip, imageBitmaps, W, H);
        } else {
          drawTextClip(ctx2d, layer.clip as TextClip, W, H);
        }
      } else if (layer.kind === 'pair') {
        await renderTransitionLayer(layer.pair, t, ctx2d, scratchPrev, sctxPrev, scratchNext, sctxNext, videoDecoders, W, H);
      } else {
        await renderOrphanLayer(layer.orphan, t, ctx2d, scratchPrev, sctxPrev, scratchNext, sctxNext, videoDecoders, imageBitmaps, W, H);
      }
    }
    ctx2d.globalAlpha = 1;

    // Encode + close. Build the VideoFrame from the OffscreenCanvas snapshot.
    await encodeAndClose(encoder, offscreen, Math.round((frameIdx * 1_000_000) / fps), frameIdx % keyframeIntervalFrames === 0);

    // Backpressure: don't let queued frames pile up.
    while (encoder.encodeQueueSize > 30) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    // Progress emit (≤ once per 1% of total).
    const frac = (frameIdx + 1) / totalFrames;
    if (frac - lastProgressSent >= 0.01) {
      lastProgressSent = frac;
      ctx.postMessage({ type: 'progress', fraction: frac } satisfies ExportMessage);
    }
  }

  await encoder.flush();
  if (encoderError) throw encoderError;
  encoder.close();

  // Audio pass — encode the PCM that the main thread already rendered.
  // (Web Audio isn't available in some workers, so rendering had to happen
  // up there. We just turn samples into AAC/Opus chunks here.)
  if (hasAudio && req.audioPcm) {
    let audioError: Error | null = null;
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { audioError = e instanceof Error ? e : new Error(String(e)); },
    });
    audioEncoder.configure({
      codec: req.audioEncoderCodec!,
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: req.audioPcm.channels.length,
      bitrate: 128_000,
    });

    await encodePcm(req.audioPcm, audioEncoder);
    await audioEncoder.flush();
    if (audioError) throw audioError;
    audioEncoder.close();
  }

  muxer.finalize();
  const target = muxer.target as ArrayBufferTarget;
  const out = target.buffer;

  // Cleanup.
  for (const bm of imageBitmaps.values()) bm.close();
  await Promise.all(Array.from(videoDecoders.values()).map((d) => d.close()));

  return out;
}

/** Build all transition pairs in the project. A pair is two adjacent video
 *  clips on the same track where the first has `transitionOut`, both are
 *  non-free fit, and they share the same zIndex. Mirrors the run-grouping
 *  in the old `filterGraph.ts:299-342`. */
interface TransitionPair {
  prev: VideoClip;
  next: VideoClip;
  /** Transition duration (= `prev.transitionOut.duration` clamped to clip lengths). */
  D: number;
  /** Junction point on the timeline (= prev's tlEnd = next's tlStart). */
  T: number;
  /** Inclusive start of the transition window in timeline seconds. */
  windowStart: number;
  /** Exclusive end. */
  windowEnd: number;
}

function computeTransitionPairs(state: ProjectState): TransitionPair[] {
  const ADJ_EPS = 0.005;
  const pairs: TransitionPair[] = [];
  for (const trackId of state.trackOrder) {
    const track = state.tracks[trackId];
    if (!track) continue;
    const sorted = track.clips
      .map((cid) => state.clips[cid])
      .filter((c): c is Clip => Boolean(c))
      .sort((a, b) => a.timelineStart - b.timelineStart);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (prev.kind !== 'video' || next.kind !== 'video') continue;
      if (!prev.transitionOut || prev.transitionOut.duration <= 0) continue;
      // No free-fit exclusion: the FFmpeg path needed yuv420p (no alpha),
      // but the Canvas2D scratch+blend approach handles alpha cleanly.
      if (prev.zIndex !== next.zIndex) continue;
      const prevEnd = prev.timelineStart + clipDuration(prev);
      if (Math.abs(next.timelineStart - prevEnd) > ADJ_EPS) continue;
      const D = Math.min(prev.transitionOut.duration, clipDuration(prev), clipDuration(next));
      const halfD = D / 2;
      pairs.push({
        prev,
        next,
        D,
        T: prevEnd,
        windowStart: prevEnd - halfD,
        windowEnd: prevEnd + halfD,
      });
    }
  }
  return pairs;
}

/** Singleton orphan: a clip with `transitionOut` or `transitionIn` that
 *  has no matching pair. 'tail' side transitions clip→black, 'head' side
 *  transitions black→clip. Mirrors `previewSingletonOrphans`. */
interface SingletonOrphan {
  clip: Clip;
  D: number;
  windowStart: number;
  windowEnd: number;
  side: 'head' | 'tail';
}

function computeSingletonOrphans(
  state: ProjectState,
  pairs: TransitionPair[],
): SingletonOrphan[] {
  const prevInPair = new Set<string>();
  const nextInPair = new Set<string>();
  for (const p of pairs) {
    prevInPair.add(p.prev.id);
    nextInPair.add(p.next.id);
  }
  const orphans: SingletonOrphan[] = [];
  for (const clip of Object.values(state.clips)) {
    const dur = clipDuration(clip);
    if (clip.transitionOut && clip.transitionOut.duration > 0 && !prevInPair.has(clip.id)) {
      const D = Math.min(clip.transitionOut.duration, dur);
      const tlEnd = clip.timelineStart + dur;
      orphans.push({ clip, D, windowStart: tlEnd - D / 2, windowEnd: tlEnd, side: 'tail' });
    }
    if (clip.transitionIn && clip.transitionIn.duration > 0 && !nextInPair.has(clip.id)) {
      const D = Math.min(clip.transitionIn.duration, dur);
      orphans.push({
        clip,
        D,
        windowStart: clip.timelineStart,
        windowEnd: clip.timelineStart + D / 2,
        side: 'head',
      });
    }
  }
  return orphans;
}

type Layer =
  | { kind: 'clip'; clip: Clip }
  | { kind: 'pair'; pair: TransitionPair }
  | { kind: 'orphan'; orphan: SingletonOrphan };

function layerSortKey(layer: Layer): Clip {
  // compareClipsForDrawing reads zIndex, trackId, timelineStart from a Clip.
  // For pairs, the prev clip is representative (same zIndex/track as next).
  if (layer.kind === 'clip') return layer.clip;
  if (layer.kind === 'pair') return layer.pair.prev;
  return layer.orphan.clip;
}

async function renderTransitionLayer(
  pair: TransitionPair,
  t: number,
  destCtx: OffscreenCanvasRenderingContext2D,
  scratchPrev: OffscreenCanvas,
  sctxPrev: OffscreenCanvasRenderingContext2D,
  scratchNext: OffscreenCanvas,
  sctxNext: OffscreenCanvasRenderingContext2D,
  videoDecoders: Map<string, VideoSourceDecoder>,
  W: number,
  H: number,
): Promise<void> {
  // Each clip's natural source time, clamped to its own [sourceStart,sourceEnd]
  // so the "phantom" frame outside the clip's normal window is a held still
  // (last/first frame). This matches what users intuitively want: during the
  // overlap, both clips' content is present.
  const prevClip = pair.prev;
  const nextClip = pair.next;
  const tPrevClamped = Math.min(t, prevClip.timelineStart + clipDuration(prevClip));
  const tNextClamped = Math.max(t, nextClip.timelineStart);

  // Composite scene + each clip into the scratch buffers so the transition
  // blends scene+clipPrev ↔ scene+clipNext, keeping clips on other tracks
  // visible throughout the window. Without this baseline the pair's opaque
  // output wipes any track at a lower z-index. Mirrors the preview path.
  sctxPrev.globalAlpha = 1;
  sctxPrev.drawImage(destCtx.canvas, 0, 0);
  await drawClipVideo(sctxPrev, prevClip, tPrevClamped, videoDecoders, W, H);

  sctxNext.globalAlpha = 1;
  sctxNext.drawImage(destCtx.canvas, 0, 0);
  await drawClipVideo(sctxNext, nextClip, tNextClamped, videoDecoders, W, H);

  // Transitions assume a clean alpha state. The clip layer that ran before
  // us may have left globalAlpha at some fade value, and the transition
  // shouldn't compound with that.
  destCtx.globalAlpha = 1;
  const progress = (t - pair.windowStart) / pair.D;
  const kind = prevClip.transitionOut?.kind ?? 'fade';
  applyTransition(kind, destCtx, scratchPrev, scratchNext, progress, W, H);
  destCtx.globalAlpha = 1;
}

/** Render a singleton-orphan clip's tail with its chosen transition kind,
 *  transitioning to BLACK. Mirrors `renderPreviewSingletonOrphan` so preview
 *  and export show identical visuals for a singleton "wipe-out", etc. */
async function renderOrphanLayer(
  orphan: SingletonOrphan,
  t: number,
  destCtx: OffscreenCanvasRenderingContext2D,
  scratchPrev: OffscreenCanvas,
  sctxPrev: OffscreenCanvasRenderingContext2D,
  scratchNext: OffscreenCanvas,
  sctxNext: OffscreenCanvasRenderingContext2D,
  videoDecoders: Map<string, VideoSourceDecoder>,
  imageBitmaps: Map<string, ImageBitmap>,
  W: number,
  H: number,
): Promise<void> {
  const clip = orphan.clip;
  // Clip pixels go on scratchPrev for tail (clip → scene), on scratchNext
  // for head (scene → clip). The "other side" is a snapshot of the
  // currently-rendered frame — other-track clips already painted at lower
  // z-indexes. Without this baseline (an opaque-black buffer was used
  // before), the transition would wipe those tracks to solid black during
  // the window. Mirrors the preview path.
  const sctxClip = orphan.side === 'tail' ? sctxPrev : sctxNext;
  const sctxScene = orphan.side === 'tail' ? sctxNext : sctxPrev;

  sctxClip.clearRect(0, 0, W, H);
  sctxClip.globalAlpha = 1;
  if (clip.kind === 'video') {
    await drawClipVideo(sctxClip, clip, t, videoDecoders, W, H);
  } else if (clip.kind === 'image') {
    drawClipImage(sctxClip, clip, imageBitmaps, W, H);
  } else {
    drawTextClip(sctxClip, clip as TextClip, W, H);
  }

  sctxScene.clearRect(0, 0, W, H);
  sctxScene.globalAlpha = 1;
  sctxScene.drawImage(destCtx.canvas, 0, 0);

  destCtx.globalAlpha = 1;
  const progress = (t - orphan.windowStart) / orphan.D;
  const kind = (orphan.side === 'tail' ? clip.transitionOut : clip.transitionIn)?.kind ?? 'fade';
  applyTransition(kind, destCtx, scratchPrev, scratchNext, progress, W, H);
  destCtx.globalAlpha = 1;
}

async function drawClipVideo(
  ctx2d: OffscreenCanvasRenderingContext2D,
  clip: VideoClip,
  t: number,
  videoDecoders: Map<string, VideoSourceDecoder>,
  W: number,
  H: number,
): Promise<void> {
  const decoder = videoDecoders.get(clip.mediaFileId);
  if (!decoder) return;
  const speed = Math.max(0.01, clip.speed);
  const sourceTime = clip.sourceStart + (t - clip.timelineStart) * speed;
  const frame = await decoder.frameAt(sourceTime);
  if (!frame) return;
  drawVideoFrame(ctx2d, frame, clip, W, H);
}

function drawClipImage(
  ctx2d: OffscreenCanvasRenderingContext2D,
  clip: ImageClip,
  imageBitmaps: Map<string, ImageBitmap>,
  W: number,
  H: number,
): void {
  const bm = imageBitmaps.get(clip.mediaFileId);
  if (!bm) return;
  drawImageBitmapClip(ctx2d, bm, clip, W, H);
}

/** Build a VideoFrame from the OffscreenCanvas, hand it to the encoder, and
 *  close it. Splitting this would invite forgetting the close() — and an
 *  unclosed VideoFrame holds GPU memory until the next GC. 1800 frames in a
 *  60s 1080p export = OOM. */
async function encodeAndClose(
  encoder: VideoEncoder,
  canvas: OffscreenCanvas,
  timestampMicros: number,
  keyFrame: boolean,
): Promise<void> {
  const frame = new VideoFrame(canvas, { timestamp: timestampMicros });
  try {
    encoder.encode(frame, { keyFrame });
  } finally {
    frame.close();
  }
}

function computeTimelineDuration(clips: Record<string, Clip>): number {
  let max = 0;
  for (const clip of Object.values(clips)) {
    const end = clip.timelineStart + clipDuration(clip);
    if (end > max) max = end;
  }
  return max;
}

/** Bitrate budget heuristic. Scales linearly with pixel count from the
 *  1080p anchor: fast=1.5 / balanced=4 / quality=7 Mbps. */
function computeBitrate(W: number, H: number, quality: QualityPreset): number {
  const baseBitrate = quality === 'fast' ? 1_500_000 : quality === 'balanced' ? 4_000_000 : 7_000_000;
  const scale = (W * H) / (1920 * 1080);
  return Math.max(500_000, Math.round(baseBitrate * scale));
}

/** Load the bundled TTF font families into the worker's font set so
 *  ctx.font / fillText resolves them. Without this the worker has no DOM
 *  CSS context — text would silently fall back to a generic sans-serif. */
async function loadFonts(): Promise<void> {
  const families: Array<{ name: string; url: string }> = [
    { name: 'Aether Sans', url: '/fonts/sans.ttf' },
    { name: 'Aether Serif', url: '/fonts/serif.ttf' },
    { name: 'Aether Mono', url: '/fonts/mono.ttf' },
    { name: 'Aether Display', url: '/fonts/display.ttf' },
    { name: 'Aether Handwriting', url: '/fonts/handwriting.ttf' },
  ];
  // FontFace + (self as WorkerGlobalScope).fonts.add — works in dedicated workers.
  const fontsApi = (ctx as DedicatedWorkerGlobalScope & { fonts?: FontFaceSet }).fonts;
  if (!fontsApi) {
    // Older browsers without WorkerGlobalScope.fonts — fall back silently.
    // ctx.font will use the system default. The export still runs.
    return;
  }
  // Reference FONT_FAMILIES so the import isn't unused (keeps imports lean
  // when we add more font families later).
  void FONT_FAMILIES;
  for (const f of families) {
    try {
      const ff = new FontFace(f.name, `url(${f.url})`);
      await ff.load();
      fontsApi.add(ff);
    } catch (e) {
      // Non-fatal: text will fall back to system default for this family.
      console.warn(`Failed to load font ${f.name}:`, e);
    }
  }
}

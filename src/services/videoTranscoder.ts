/**
 * Non-MP4 → MP4 (H.264 + AAC/Opus) transcoder, main-thread only.
 *
 * The export worker can't use HTMLVideoElement (no `document`), so non-MP4
 * sources (MOV, WebM, MKV, AVI, …) currently bail out at export time. We
 * sidestep that by transcoding incompatible sources at IMPORT time on the
 * main thread, where HTMLVideoElement works. The MP4 result is what the
 * project actually stores and what the export worker sees.
 *
 * Pipeline: HTMLVideoElement seeks frame-by-frame → drawn to OffscreenCanvas →
 *   VideoFrame → VideoEncoder (H.264) → mp4-muxer. Audio: decodeAudioData on
 *   the full file → AudioEncoder (AAC, Opus fallback) → mp4-muxer.
 *
 * Tradeoffs: re-encoding is lossy and ~realtime-ish (one seek per frame). For
 * already-MP4 files the caller skips this path entirely.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { AudioCodec } from './browserSupport';

const VIDEO_FPS = 30;
const AUDIO_CHUNK_SAMPLES = 1024;

const VIDEO_CODEC_LADDER = [
  'avc1.640034', // High 5.2 — up to ~4K@60
  'avc1.640033', // High 5.1 — 4K@30
  'avc1.640028', // High 4.0 — 1080p@30
  'avc1.42E028', // Constrained Baseline 4.0 — 1080p, broader software compat
  'avc1.42001f', // Baseline 3.1 — 720p only
];

const AUDIO_CODEC_LADDER: Array<{ muxer: AudioCodec; encoder: string }> = [
  { muxer: 'aac', encoder: 'mp4a.40.2' },
  { muxer: 'opus', encoder: 'opus' },
];

export interface TranscodeOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Sniff the first 12 bytes for an `ftyp` box. MP4-family containers all
 *  start with one (ISO BMFF). Files marked `video/mp4` by the browser don't
 *  need the sniff but file.type is unreliable (empty, "video/quicktime"
 *  for QT-flavored MP4, etc.) so we check the bytes too. */
export async function isMp4(file: File): Promise<boolean> {
  if (file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
}

async function probeVideoCodec(width: number, height: number): Promise<string | null> {
  const bitrate = Math.max(1_000_000, Math.round(width * height * 0.1));
  for (const codec of VIDEO_CODEC_LADDER) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate, framerate: VIDEO_FPS,
      });
      if (res.supported) return codec;
    } catch { /* try next */ }
  }
  return null;
}

async function probeAudioCodec(
  sampleRate: number, channels: number,
): Promise<{ muxer: AudioCodec; encoder: string } | null> {
  for (const entry of AUDIO_CODEC_LADDER) {
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: entry.encoder,
        sampleRate,
        numberOfChannels: channels,
        bitrate: 128_000,
      });
      if (res.supported) return entry;
    } catch { /* try next */ }
  }
  return null;
}

/** Decode the file's audio track via Web Audio. Returns null if the file has
 *  no audio or the audio codec isn't supported by the browser's decoder. */
async function decodeAudio(file: File): Promise<AudioBuffer | null> {
  try {
    const buf = await file.arrayBuffer();
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new Ctx();
    // Some browsers throw on decode rather than rejecting cleanly; catch both.
    const audio = await ctx.decodeAudioData(buf.slice(0));
    await ctx.close();
    return audio;
  } catch (e) {
    console.warn('Audio decode failed (file may have no audio track):', e);
    return null;
  }
}

export async function transcodeToMp4(
  file: File,
  options: TranscodeOptions = {},
): Promise<Blob> {
  const { onProgress, signal } = options;
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException('Transcode aborted', 'AbortError');
  };

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.src = url;

  try {
    // Load metadata.
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not load source video'));
    });
    checkAbort();

    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) throw new Error('Source video has no dimensions');
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      // Stream end-time trick: seek past the end so the browser computes the
      // real duration on the timeupdate that follows. Same workaround used in
      // the Sidebar import path for VP8/9 WebM streams.
      await new Promise<void>((resolve) => {
        const onTimeUpdate = () => {
          video.removeEventListener('timeupdate', onTimeUpdate);
          duration = video.duration;
          video.currentTime = 0;
          resolve();
        };
        video.addEventListener('timeupdate', onTimeUpdate);
        try { video.currentTime = Number.MAX_SAFE_INTEGER; } catch { resolve(); }
      });
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Could not determine source video duration');
      }
    }

    const videoCodec = await probeVideoCodec(W, H);
    if (!videoCodec) throw new Error('No supported H.264 encoder for this resolution');

    // Audio first — its presence changes muxer config.
    const audioBuffer = await decodeAudio(file);
    let audioCodec: { muxer: AudioCodec; encoder: string } | null = null;
    if (audioBuffer && audioBuffer.numberOfChannels > 0) {
      audioCodec = await probeAudioCodec(audioBuffer.sampleRate, Math.min(2, audioBuffer.numberOfChannels));
      if (!audioCodec) console.warn('No supported audio encoder; transcoded MP4 will be silent.');
    }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: W,
        height: H,
        frameRate: VIDEO_FPS,
      },
      audio: audioCodec && audioBuffer
        ? {
            codec: audioCodec.muxer,
            numberOfChannels: Math.min(2, audioBuffer.numberOfChannels),
            sampleRate: audioBuffer.sampleRate,
          }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    let videoErr: Error | null = null;
    const videoEnc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { videoErr = e instanceof Error ? e : new Error(String(e)); },
    });
    const videoBitrate = Math.min(20_000_000, Math.max(2_000_000, Math.round(W * H * 0.12)));
    videoEnc.configure({
      codec: videoCodec,
      width: W,
      height: H,
      bitrate: videoBitrate,
      framerate: VIDEO_FPS,
      latencyMode: 'quality',
    });

    // Video pass.
    const offscreen = new OffscreenCanvas(W, H);
    const ctx = offscreen.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context for transcode');
    const totalFrames = Math.max(1, Math.round(duration * VIDEO_FPS));
    const keyframeInterval = VIDEO_FPS * 2;
    for (let i = 0; i < totalFrames; i++) {
      checkAbort();
      if (videoErr) throw videoErr;
      const t = i / VIDEO_FPS;
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, W, H);
      const frame = new VideoFrame(offscreen, {
        timestamp: Math.round((i * 1_000_000) / VIDEO_FPS),
        duration: Math.round(1_000_000 / VIDEO_FPS),
      });
      videoEnc.encode(frame, { keyFrame: i % keyframeInterval === 0 });
      frame.close();
      while (videoEnc.encodeQueueSize > 30) {
        await new Promise<void>((r) => setTimeout(r, 5));
      }
      if (onProgress && (i % 4 === 0 || i === totalFrames - 1)) {
        // Reserve last 10% of the progress bar for audio + flush.
        onProgress(((i + 1) / totalFrames) * (audioCodec ? 0.85 : 0.95));
      }
    }
    await videoEnc.flush();
    if (videoErr) throw videoErr;
    videoEnc.close();

    // Audio pass.
    if (audioCodec && audioBuffer) {
      let audioErr: Error | null = null;
      const audioEnc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => { audioErr = e instanceof Error ? e : new Error(String(e)); },
      });
      const channels = Math.min(2, audioBuffer.numberOfChannels);
      audioEnc.configure({
        codec: audioCodec.encoder,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: channels,
        bitrate: 128_000,
      });
      // Pack channels into a single interleaved Float32 buffer per chunk.
      const total = audioBuffer.length;
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = channels > 1 ? audioBuffer.getChannelData(1) : ch0;
      const chunkFrames = AUDIO_CHUNK_SAMPLES;
      for (let s = 0; s < total; s += chunkFrames) {
        checkAbort();
        if (audioErr) throw audioErr;
        const frames = Math.min(chunkFrames, total - s);
        const interleaved = new Float32Array(frames * channels);
        for (let i = 0; i < frames; i++) {
          interleaved[i * channels] = ch0[s + i];
          if (channels > 1) interleaved[i * channels + 1] = ch1[s + i];
        }
        const data = new AudioData({
          format: 'f32',
          sampleRate: audioBuffer.sampleRate,
          numberOfFrames: frames,
          numberOfChannels: channels,
          timestamp: Math.round((s * 1_000_000) / audioBuffer.sampleRate),
          data: interleaved,
        });
        audioEnc.encode(data);
        data.close();
        while (audioEnc.encodeQueueSize > 30) {
          await new Promise<void>((r) => setTimeout(r, 2));
        }
        if (onProgress && (s % (chunkFrames * 20) === 0)) {
          const frac = 0.85 + 0.1 * (s / total);
          onProgress(Math.min(0.95, frac));
        }
      }
      await audioEnc.flush();
      if (audioErr) throw audioErr;
      audioEnc.close();
    }

    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    onProgress?.(1);
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const clamped = Math.max(0, Math.min(video.duration - 0.0001, t));
    if (Math.abs(video.currentTime - clamped) < 0.001) { resolve(); return; }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      reject(new Error('Seek failed'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try {
      video.currentTime = clamped;
    } catch (e) {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      reject(e instanceof Error ? e : new Error('Seek threw'));
    }
  });
}

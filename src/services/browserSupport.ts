/**
 * WebCodecs export feature detection. Probes the browser at app-load time
 * so the export button can be gated cleanly instead of failing mid-render.
 *
 * Three checks:
 *   1. The required APIs exist (`VideoEncoder`, `AudioEncoder`, `OffscreenCanvas`).
 *   2. A codec config we'd actually use is supported (`avc1.*` + AAC).
 *   3. `ctx.filter` works inside an OffscreenCanvas 2D context (paranoia —
 *      every browser supporting (1) should support (3), but historic Safari
 *      and Firefox have had quiet regressions and our color pipeline depends
 *      on it).
 */

export type AudioCodec = 'aac' | 'opus';

export interface ExportSupport {
  supported: boolean;
  reason: string | null;
  videoCodec: string | null;
  /** Muxer-level audio codec name (passed to mp4-muxer). null = no
   *  supported audio encoder; export proceeds video-only with a warning. */
  audioCodec: AudioCodec | null;
  /** WebCodecs-level codec string for the AudioEncoder. */
  audioEncoderCodec: string | null;
  filterSupported: boolean;
}

/** H.264 codec strings tried in descending order of capability. The first one
 *  that `VideoEncoder.isConfigSupported` accepts at the target dims+bitrate
 *  wins. Different profile/level combinations cover different resolution
 *  ranges — see Annex A of the H.264 spec. */
const CODEC_LADDER = [
  'avc1.640034', // High 5.2  — up to ~4K@60
  'avc1.640033', // High 5.1  — 4K@30
  'avc1.640028', // High 4.0  — 1080p@30 (widest hardware support at this res)
  'avc1.42E028', // Constrained Baseline 4.0 — 1080p, broader software compat
  'avc1.42001f', // Baseline 3.1 — 720p only
];

/** Audio codec ladder. AAC plays everywhere but Chromium-Linux often ships
 *  without an AAC encoder (licensing). Opus is royalty-free, playable in
 *  Chrome/Firefox/VLC, and supported by mp4-muxer inside MP4 containers
 *  (Safari is the only major player that struggles with MP4-Opus). */
const AUDIO_LADDER: Array<{ muxer: AudioCodec; encoder: string }> = [
  { muxer: 'aac', encoder: 'mp4a.40.2' },
  { muxer: 'opus', encoder: 'opus' },
];

/** Probe encoders + codec ladder + ctx.filter. Cached per canvas size — the
 *  codec ladder picks profile/level based on dimensions, so 1080p and 4K can
 *  legitimately return different `videoCodec`s. Caching globally would hand
 *  the 1080p answer to a 4K caller. */
const cache = new Map<string, Promise<ExportSupport>>();

export function checkExportSupport(
  canvas: { width: number; height: number } = { width: 1920, height: 1080 },
): Promise<ExportSupport> {
  const key = `${canvas.width}x${canvas.height}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = (async () => {
    if (typeof VideoEncoder === 'undefined') {
      return mkUnsupported('Your browser is missing the VideoEncoder API. Use Chrome/Edge, Firefox 130+, or Safari 17.4+.');
    }
    if (typeof AudioEncoder === 'undefined') {
      return mkUnsupported('Your browser is missing the AudioEncoder API. Use Chrome/Edge, Firefox 130+, or Safari 17.4+.');
    }
    if (typeof OffscreenCanvas === 'undefined') {
      return mkUnsupported('Your browser is missing OffscreenCanvas. Use Chrome/Edge, Firefox 130+, or Safari 17.4+.');
    }

    const videoCodec = await probeVideoCodec(canvas.width, canvas.height);
    if (!videoCodec) {
      return mkUnsupported(`No supported H.264 codec for ${canvas.width}×${canvas.height} at the target bitrate.`);
    }

    const audio = await probeAudioCodec();
    // No audio encoder isn't fatal — we'll export video-only. Useful on
    // Chromium-Linux which often lacks an AAC encoder.

    const filterSupported = await probeFilterOnOffscreen();

    return {
      supported: true,
      reason: null,
      videoCodec,
      audioCodec: audio?.muxer ?? null,
      audioEncoderCodec: audio?.encoder ?? null,
      filterSupported,
    };
  })();
  cache.set(key, promise);
  return promise;
}

function mkUnsupported(reason: string): ExportSupport {
  return {
    supported: false,
    reason,
    videoCodec: null,
    audioCodec: null,
    audioEncoderCodec: null,
    filterSupported: false,
  };
}

async function probeVideoCodec(width: number, height: number): Promise<string | null> {
  // Heuristic bitrate for the probe; the actual export config recalculates from quality preset.
  const bitrate = Math.max(1_000_000, Math.round(width * height * 0.1));
  for (const codec of CODEC_LADDER) {
    try {
      const res = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: 30,
      });
      if (res.supported) return codec;
    } catch {
      // isConfigSupported can throw on malformed codec strings; just try the next one.
    }
  }
  return null;
}

async function probeAudioCodec(): Promise<{ muxer: AudioCodec; encoder: string } | null> {
  for (const entry of AUDIO_LADDER) {
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: entry.encoder,
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128_000,
      });
      if (res.supported) return entry;
    } catch {
      // try next
    }
  }
  return null;
}

/** Smoke-test ctx.filter on a worker OffscreenCanvas. Spawns a one-off
 *  classic worker (same-origin blob URL — no nested-worker issues here),
 *  paints two pixels with and without `brightness(2)`, reads them back, and
 *  confirms the second is brighter. */
async function probeFilterOnOffscreen(): Promise<boolean> {
  const source = `
    self.onmessage = () => {
      try {
        const canvas = new OffscreenCanvas(2, 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) { self.postMessage(false); return; }
        ctx.fillStyle = 'rgb(80, 80, 80)';
        ctx.fillRect(0, 0, 1, 1);
        ctx.filter = 'brightness(2)';
        ctx.fillStyle = 'rgb(80, 80, 80)';
        ctx.fillRect(1, 0, 1, 1);
        const data = ctx.getImageData(0, 0, 2, 1).data;
        // pixel 0 ≈ 80, pixel 1 should be brighter (~160).
        self.postMessage(data[0] < 120 && data[4] > 120);
      } catch (_e) {
        self.postMessage(false);
      }
    };
  `;
  const blob = new Blob([source], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const worker = new Worker(url);
      const timer = setTimeout(() => {
        worker.terminate();
        resolve(false);
      }, 3000);
      worker.onmessage = (e) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(e.data === true);
      };
      worker.onerror = () => {
        clearTimeout(timer);
        worker.terminate();
        resolve(false);
      };
      worker.postMessage('check');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

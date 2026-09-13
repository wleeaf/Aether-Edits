/**
 * Compositor functions shared between live preview (PreviewPanel) and the
 * WebCodecs export worker. Lifted out of PreviewPanel verbatim so preview
 * and export draw via the same code path — guarantees WYSIWYG parity.
 *
 * Each function accepts either a main-thread `CanvasRenderingContext2D` or
 * an `OffscreenCanvasRenderingContext2D`. The methods we use (drawImage,
 * fillText, save/restore, translate/rotate, filter, font, fill/strokeStyle,
 * lineWidth) are identical across both.
 */

import type {
  Clip,
  ImageClip,
  ProjectState,
  TextClip,
  Transform,
  VideoClip,
} from '../types/project';
import {
  FONT_FAMILIES,
  clipDuration,
  compareClipsForDrawing,
} from '../types/project';

const ADJACENCY_EPS = 0.01;

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** CSS filter string for the color adjustment. Note: CSS brightness is
 *  multiplicative (1+b); we keep that everywhere so preview and export match. */
export function colorAdjustToCssFilter(c: VideoClip['color'] | ImageClip['color']): string {
  if (!c) return 'none';
  return `brightness(${(1 + c.brightness).toFixed(3)}) contrast(${c.contrast.toFixed(3)}) saturate(${c.saturation.toFixed(3)}) hue-rotate(${c.hue.toFixed(1)}deg)`;
}

/** Shared fit/transform/color math for video and image layers. */
function drawMediaLayer(
  ctx: Ctx2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  clip: VideoClip | ImageClip,
  W: number,
  H: number,
  transformOverride?: Transform,
): void {
  if (!srcW || !srcH) return;

  const filter = colorAdjustToCssFilter(clip.color);
  const restoreFilter = filter !== 'none';
  if (restoreFilter) ctx.filter = filter;

  if (clip.fit === 'cover') {
    const k = Math.max(W / srcW, H / srcH);
    const dw = srcW * k;
    const dh = srcH * k;
    ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else if (clip.fit === 'free') {
    const t = transformOverride ?? clip.transform;
    const baseK = Math.min(W / srcW, H / srcH);
    const k = baseK * t.scale;
    const dw = srcW * k;
    const dh = srcH * k;
    ctx.save();
    ctx.translate(t.x * W, t.y * H);
    if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    const scale = Math.min(W / srcW, H / srcH);
    const dw = Math.round(srcW * scale);
    const dh = Math.round(srcH * scale);
    const dx = Math.floor((W - dw) / 2);
    const dy = Math.floor((H - dh) / 2);
    ctx.drawImage(source, dx, dy, dw, dh);
  }

  if (restoreFilter) ctx.filter = 'none';
}

/** Preview path: HTMLVideoElement drawn via 2D context. */
export function drawVideoClip(
  ctx: Ctx2D,
  video: HTMLVideoElement,
  clip: VideoClip,
  W: number,
  H: number,
  transformOverride?: Transform,
): void {
  drawMediaLayer(ctx, video, video.videoWidth, video.videoHeight, clip, W, H, transformOverride);
}

/** Export path: VideoFrame from WebCodecs VideoDecoder. */
export function drawVideoFrame(
  ctx: Ctx2D,
  frame: VideoFrame,
  clip: VideoClip,
  W: number,
  H: number,
  transformOverride?: Transform,
): void {
  drawMediaLayer(ctx, frame, frame.displayWidth, frame.displayHeight, clip, W, H, transformOverride);
}

/** Preview path: HTMLImageElement. */
export function drawImageClip(
  ctx: Ctx2D,
  img: HTMLImageElement,
  clip: ImageClip,
  W: number,
  H: number,
  transformOverride?: Transform,
): void {
  if (!img.complete) return;
  drawMediaLayer(ctx, img, img.naturalWidth, img.naturalHeight, clip, W, H, transformOverride);
}

/** Export path: ImageBitmap (createImageBitmap from decoded file). */
export function drawImageBitmap(
  ctx: Ctx2D,
  bitmap: ImageBitmap,
  clip: ImageClip,
  W: number,
  H: number,
  transformOverride?: Transform,
): void {
  drawMediaLayer(ctx, bitmap, bitmap.width, bitmap.height, clip, W, H, transformOverride);
}

/** Text clip: stroked outline + filled fill, center-anchored, with the same
 *  font/size/transform math used by both preview and export. Fonts must be
 *  loaded into the rendering context beforehand — main thread inherits from
 *  CSS @font-face, worker must use FontFace.load() + (self as WorkerGlobalScope).fonts.add(). */
export function drawTextClip(
  ctx: Ctx2D,
  clip: TextClip,
  W: number,
  H: number,
  transformOverride?: Transform,
): void {
  const t = transformOverride ?? clip.transform;
  const fontSizePx = Math.round((clip.fontSize / 100) * H * t.scale);
  if (fontSizePx < 1) return;

  const family =
    FONT_FAMILIES.find((f) => f.key === clip.fontFamily)?.cssStack ??
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  ctx.save();
  ctx.translate(t.x * W, t.y * H);
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.font = `700 ${fontSizePx}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, Math.round(fontSizePx / 24));
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.strokeText(clip.text, 0, 0);
  ctx.fillStyle = clip.color;
  ctx.fillText(clip.text, 0, 0);
  ctx.restore();
}

/** All clips active at time t, sorted bottom-to-top by draw order:
 *  primary clip.zIndex, secondary track index, tertiary timelineStart. */
export function findActiveClipsAtTime(state: ProjectState, time: number): Clip[] {
  const out: Clip[] = [];
  for (const trackId of state.trackOrder) {
    const track = state.tracks[trackId];
    if (!track) continue;
    for (const clipId of track.clips) {
      const clip = state.clips[clipId];
      if (!clip) continue;
      const end = clip.timelineStart + clipDuration(clip);
      if (time >= clip.timelineStart && time < end) out.push(clip);
    }
  }
  out.sort((a, b) => compareClipsForDrawing(a, b, state.trackOrder));
  return out;
}

/** The immediately previous clip on the same track (by timelineStart order), if any. */
export function prevClipOnTrack(state: ProjectState, clip: Clip): Clip | null {
  const track = state.tracks[clip.trackId];
  if (!track) return null;
  const sorted = track.clips
    .map((cid) => state.clips[cid])
    .filter((c): c is Clip => Boolean(c))
    .sort((a, b) => a.timelineStart - b.timelineStart);
  const idx = sorted.findIndex((c) => c.id === clip.id);
  return idx > 0 ? sorted[idx - 1] : null;
}

/** Alpha multiplier for a clip at time t. Three independent contributions:
 *   1. Own `transitionOut`: fade-out tail in the last D/2 of clip.
 *   2. Own `transitionIn`:  fade-in head in the first D/2 of clip.
 *   3. Prev adjacent clip's `transitionOut`: fade-in head (legacy/pair coupling).
 *  The kind isn't visualized here — that's `applyTransition`'s job in the
 *  pair/orphan renderers. This function only produces the alpha curve so
 *  clips that fall outside those renderers (non-pair, non-orphan) still
 *  fade visually. */
export function computeClipAlpha(state: ProjectState, clip: Clip, t: number): number {
  let alpha = 1;
  const dur = clipDuration(clip);
  const tlEnd = clip.timelineStart + dur;

  if (clip.transitionOut && clip.transitionOut.duration > 0) {
    const D = Math.min(clip.transitionOut.duration, dur);
    const halfD = D / 2;
    const fadeStart = tlEnd - halfD;
    if (t >= fadeStart && t < tlEnd) {
      alpha *= Math.max(0, (tlEnd - t) / halfD);
    }
  }

  if (clip.transitionIn && clip.transitionIn.duration > 0) {
    const D = Math.min(clip.transitionIn.duration, dur);
    const halfD = D / 2;
    const fadeInEnd = clip.timelineStart + halfD;
    if (t >= clip.timelineStart && t < fadeInEnd) {
      alpha *= Math.max(0, (t - clip.timelineStart) / halfD);
    }
  }

  const prev = prevClipOnTrack(state, clip);
  if (prev && prev.transitionOut && prev.transitionOut.duration > 0) {
    const prevEnd = prev.timelineStart + clipDuration(prev);
    if (Math.abs(prevEnd - clip.timelineStart) < ADJACENCY_EPS) {
      const D = Math.min(prev.transitionOut.duration, dur);
      const halfD = D / 2;
      const fadeInEnd = clip.timelineStart + halfD;
      if (t >= clip.timelineStart && t < fadeInEnd) {
        alpha *= Math.max(0, (t - clip.timelineStart) / halfD);
      }
    }
  }

  return Math.max(0, Math.min(1, alpha));
}

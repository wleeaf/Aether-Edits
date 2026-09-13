/**
 * 16 video transitions as Canvas2D operations. Each function takes:
 *   ctx        — the destination canvas's 2D context
 *   prev       — OffscreenCanvas holding the outgoing clip's rendered frame
 *   next       — OffscreenCanvas holding the incoming clip's rendered frame
 *   progress   — 0..1, where 0 = fully prev, 1 = fully next
 *   W, H       — destination canvas size
 *
 * `prev` and `next` are already at the right scale/position/color — the
 * caller composited each clip into its own OffscreenCanvas before invoking
 * the transition. Transitions only need to combine the two.
 */
import type { TransitionKind } from '../types/project';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export type TransitionFn = (
  ctx: Ctx,
  prev: OffscreenCanvas,
  next: OffscreenCanvas,
  progress: number,
  W: number,
  H: number,
) => void;

/** Linear alpha cross-blend — the canonical xfade.
 *  Correct math: out = next * p + prev * (1 - p). Drawing prev at alpha (1-p)
 *  on a non-empty dest leaks the prior dest pixels into the result. Draw
 *  prev opaque (overwriting dest), then next on top with alpha p. */
const fade: TransitionFn = (ctx, prev, next, p, W, H) => {
  ctx.globalAlpha = 1;
  ctx.drawImage(prev, 0, 0, W, H);
  ctx.globalAlpha = p;
  ctx.drawImage(next, 0, 0, W, H);
  ctx.globalAlpha = 1;
};

/** Cross-blend with a black midpoint: prev → black → next. */
const fadeBlack: TransitionFn = (ctx, prev, next, p, W, H) => {
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (p < 0.5) {
    ctx.globalAlpha = 1 - p * 2;
    ctx.drawImage(prev, 0, 0, W, H);
  } else {
    ctx.globalAlpha = (p - 0.5) * 2;
    ctx.drawImage(next, 0, 0, W, H);
  }
  ctx.globalAlpha = 1;
};

/** Cross-blend with a white midpoint: prev → white → next. */
const fadeWhite: TransitionFn = (ctx, prev, next, p, W, H) => {
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  if (p < 0.5) {
    ctx.globalAlpha = 1 - p * 2;
    ctx.drawImage(prev, 0, 0, W, H);
  } else {
    ctx.globalAlpha = (p - 0.5) * 2;
    ctx.drawImage(next, 0, 0, W, H);
  }
  ctx.globalAlpha = 1;
};

// Pre-computed deterministic noise mask for `dissolve`. Same pattern every
// frame so the dissolve has stable per-pixel timing across the whole
// transition (and across rebuilds).
const NOISE = (() => {
  // 16-bit LCG for reproducibility.
  let seed = 0x1234;
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // 256x256 of thresholds in [0, 1]. Larger than typical canvas so it tiles cleanly.
  const arr = new Float32Array(256 * 256);
  for (let i = 0; i < arr.length; i++) arr[i] = lcg();
  return arr;
})();

/** Per-pixel random dissolve. We draw prev fully, then draw next with a
 *  threshold pattern so each pixel "flips" at a random progress value. */
const dissolve: TransitionFn = (ctx, prev, next, p, W, H) => {
  ctx.globalAlpha = 1;
  ctx.drawImage(prev, 0, 0, W, H);
  // Build a 256x256 mask canvas that selects pixels whose threshold < progress,
  // then upscale to W×H. Coarse but fast and visually convincing.
  const tile = new OffscreenCanvas(256, 256);
  const tctx = tile.getContext('2d');
  if (!tctx) return;
  const img = tctx.createImageData(256, 256);
  const data = img.data;
  for (let i = 0; i < NOISE.length; i++) {
    const j = i * 4;
    const show = NOISE[i] < p ? 255 : 0;
    data[j] = 255;
    data[j + 1] = 255;
    data[j + 2] = 255;
    data[j + 3] = show;
  }
  tctx.putImageData(img, 0, 0);
  // Use the mask as a clip region by drawing next *only* where the mask is alpha=255.
  ctx.save();
  // Temporary scratch to mask `next` with `tile`.
  const masked = new OffscreenCanvas(W, H);
  const mctx = masked.getContext('2d');
  if (mctx) {
    mctx.drawImage(next, 0, 0, W, H);
    mctx.globalCompositeOperation = 'destination-in';
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(tile, 0, 0, W, H);
    ctx.drawImage(masked, 0, 0, W, H);
  }
  ctx.restore();
};

/** Builds a wipe via a rect clip path. The mask rectangle moves across the
 *  canvas; the area covered by the rect is `next`, the rest is `prev`. */
function wipe(dir: 'left' | 'right' | 'up' | 'down'): TransitionFn {
  return (ctx, prev, next, p, W, H) => {
    ctx.globalAlpha = 1;
    ctx.drawImage(prev, 0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    let x = 0, y = 0, w = W, h = H;
    if (dir === 'left') {
      w = W * p; x = W - w;
    } else if (dir === 'right') {
      w = W * p;
    } else if (dir === 'up') {
      h = H * p; y = H - h;
    } else {
      h = H * p;
    }
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(next, 0, 0, W, H);
    ctx.restore();
  };
}

/** Slide: next slides in from one edge while prev slides out the opposite
 *  edge. Both move together so the seam stays at one position throughout. */
function slide(dir: 'left' | 'right' | 'up' | 'down'): TransitionFn {
  return (ctx, prev, next, p, W, H) => {
    ctx.globalAlpha = 1;
    let dx = 0, dy = 0;
    if (dir === 'left') dx = -W * p;
    else if (dir === 'right') dx = W * p;
    else if (dir === 'up') dy = -H * p;
    else dy = H * p;
    ctx.drawImage(prev, dx, dy, W, H);
    ctx.drawImage(next, dx + (dir === 'left' ? W : dir === 'right' ? -W : 0),
                       dy + (dir === 'up' ? H : dir === 'down' ? -H : 0),
                       W, H);
  };
}

/** Expanding/contracting circular reveal. */
function circle(mode: 'open' | 'close'): TransitionFn {
  return (ctx, prev, next, p, W, H) => {
    ctx.globalAlpha = 1;
    ctx.drawImage(prev, 0, 0, W, H);
    const maxR = Math.hypot(W, H) / 2;
    const r = mode === 'open' ? maxR * p : maxR * (1 - p);
    if (r <= 0) {
      // Fully prev visible — no next drawn.
      if (mode === 'close') return; // already drew prev
      // mode === 'open' but r=0 → still prev. OK.
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(mode === 'open' ? next : prev, 0, 0, W, H);
    ctx.restore();
    if (mode === 'close') {
      // Outside the shrinking circle is `next`. Repaint outside-clip area.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2, true); // counter-clockwise → cutout
      ctx.clip();
      ctx.drawImage(next, 0, 0, W, H);
      ctx.restore();
    }
  };
}

/** Pixelize: both frames are heavily pixelated at the midpoint, then sharpen
 *  back as we approach next. */
const pixelize: TransitionFn = (ctx, prev, next, p, W, H) => {
  ctx.globalAlpha = 1;
  // Bell curve of pixel block size: small → big → small.
  const bell = 1 - Math.abs(p - 0.5) * 2; // 0..1..0
  const minBlock = 1;
  const maxBlock = Math.max(W, H) / 30; // ~64px at 1080p
  const block = minBlock + bell * (maxBlock - minBlock);
  const dwn = Math.max(2, Math.round(W / block));
  const dhn = Math.max(2, Math.round(H / block));

  const tiny = new OffscreenCanvas(dwn, dhn);
  const tctx = tiny.getContext('2d');
  if (!tctx) {
    fade(ctx, prev, next, p, W, H);
    return;
  }
  tctx.imageSmoothingEnabled = true;
  // Draw prev opaque, then next at alpha p, so the result is a true
  // cross-blend: next*p + prev*(1-p), fully opaque. The previous version
  // drew both at < 1 alpha into an initially-empty canvas, producing
  // semi-transparent output that let lower layers leak through.
  tctx.globalAlpha = 1;
  tctx.drawImage(prev, 0, 0, dwn, dhn);
  tctx.globalAlpha = p;
  tctx.drawImage(next, 0, 0, dwn, dhn);
  tctx.globalAlpha = 1;

  const savedSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, W, H);
  ctx.imageSmoothingEnabled = savedSmoothing;
};

/** Radial sweep: a clock-hand mask rotates around the center, revealing next. */
const radial: TransitionFn = (ctx, prev, next, p, W, H) => {
  ctx.globalAlpha = 1;
  ctx.drawImage(prev, 0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.hypot(W, H);
  const startAngle = -Math.PI / 2; // 12 o'clock
  const endAngle = startAngle + p * Math.PI * 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(next, 0, 0, W, H);
  ctx.restore();
};

const TRANSITIONS: Record<TransitionKind, TransitionFn> = {
  fade,
  fadeblack: fadeBlack,
  fadewhite: fadeWhite,
  dissolve,
  wipeleft: wipe('left'),
  wiperight: wipe('right'),
  wipeup: wipe('up'),
  wipedown: wipe('down'),
  slideleft: slide('left'),
  slideright: slide('right'),
  slideup: slide('up'),
  slidedown: slide('down'),
  circleopen: circle('open'),
  circleclose: circle('close'),
  pixelize,
  radial,
};

export function applyTransition(
  kind: TransitionKind,
  ctx: Ctx,
  prev: OffscreenCanvas,
  next: OffscreenCanvas,
  progress: number,
  W: number,
  H: number,
): void {
  const fn = TRANSITIONS[kind] ?? fade;
  fn(ctx, prev, next, Math.max(0, Math.min(1, progress)), W, H);
}

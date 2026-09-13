export type MediaStatus = 'ready' | 'hydrating' | 'missing';

export type MediaKind = 'video' | 'image';

export interface MediaFile {
  id: string;
  name: string;
  objectUrl: string;
  file: File | null;
  duration: number;
  width: number;
  height: number;
  status: MediaStatus;
  hasAudio: boolean;
  kind: MediaKind;
}

/** Center-anchored normalized transform applied to any clip. */
export interface Transform {
  x: number;        // 0..1, 0.5 = canvas horizontal center
  y: number;        // 0..1, 0.5 = canvas vertical center
  scale: number;    // 1 = clip's default size; for video/image, 1 = letterbox-fit; for text, multiplies fontSize-derived px
  rotation: number; // degrees, positive = clockwise
}

export const DEFAULT_TRANSFORM: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/** Kept for v2→v3 migration only. Do not use on new clips. */
export type TextPosition = 'top' | 'center' | 'bottom';

export type TransitionKind =
  | 'fade'
  | 'fadeblack'
  | 'fadewhite'
  | 'dissolve'
  | 'wipeleft'
  | 'wiperight'
  | 'wipeup'
  | 'wipedown'
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  | 'circleopen'
  | 'circleclose'
  | 'pixelize'
  | 'radial';

export interface TransitionOut {
  kind: TransitionKind;
  duration: number; // seconds
}

export interface ColorAdjust {
  brightness: number;  // -1..1, 0 = no-op
  contrast: number;    // 0..2, 1 = no-op
  saturation: number;  // 0..3, 1 = no-op
  hue: number;         // -180..180 degrees, 0 = no-op
}

export const NEUTRAL_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1, hue: 0 };

export type VideoFit = 'contain' | 'cover' | 'free';

/** Curated, bundled text font family keys. Each maps to a TTF in
 *  `public/fonts/<key>.ttf` for export and a CSS @font-face for preview. */
export type FontFamilyKey = 'sans' | 'serif' | 'mono' | 'display' | 'handwriting';

export const FONT_FAMILIES: { key: FontFamilyKey; label: string; cssStack: string }[] = [
  { key: 'sans',         label: 'Sans',         cssStack: "'Aether Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { key: 'serif',        label: 'Serif',        cssStack: "'Aether Serif', Georgia, 'Times New Roman', serif" },
  { key: 'mono',         label: 'Mono',         cssStack: "'Aether Mono', 'JetBrains Mono', 'Fira Code', monospace" },
  { key: 'display',      label: 'Display',      cssStack: "'Aether Display', Impact, 'Arial Black', sans-serif" },
  { key: 'handwriting',  label: 'Handwriting',  cssStack: "'Aether Handwriting', 'Comic Sans MS', cursive" },
];

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export interface VideoClip {
  id: string;
  kind: 'video';
  mediaFileId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  trackId: string;
  zIndex: number; // higher draws on top; default 0
  volume: number; // 0..1
  muted: boolean;
  pan: number; // -1 = full left, 0 = center, 1 = full right
  duckSourceClipId: string | null;
  duckAmount: number; // 0..1, attenuation when ducking active
  fit: VideoFit;
  transform: Transform;
  color: ColorAdjust | null;
  speed: number; // 0.25..4, default 1
  transitionOut: TransitionOut | null;
  // Optional "transition in" at the clip's start. Independent of the
  // previous clip's transitionOut — used when the user drops an effect on
  // the start edge of a clip with no adjacent prev (or wants a per-clip
  // fade-in regardless of context).
  transitionIn: TransitionOut | null;
}

export interface ImageClip {
  id: string;
  kind: 'image';
  mediaFileId: string;
  sourceStart: number; // always 0 for images
  sourceEnd: number;   // display duration on the timeline (pre-speed)
  timelineStart: number;
  trackId: string;
  zIndex: number;
  fit: VideoFit; // default 'free' so resize-on-canvas is the natural interaction
  transform: Transform;
  color: ColorAdjust | null;
  speed: number; // accepted for type uniformity; export ignores (image is static)
  transitionOut: TransitionOut | null;
  transitionIn: TransitionOut | null;
}

export interface TextClip {
  id: string;
  kind: 'text';
  // Kept parallel to VideoClip so drag/trim/snap share code paths.
  // sourceStart is always 0; sourceEnd is the clip duration.
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  trackId: string;
  zIndex: number;
  text: string;
  color: string;
  fontSize: number; // % of canvas height, e.g. 8 = 8% of H
  fontFamily: FontFamilyKey;
  transform: Transform;
  speed: number; // accepted for type uniformity; text length is unaffected
  transitionOut: TransitionOut | null;
  transitionIn: TransitionOut | null;
}

export type Clip = VideoClip | TextClip | ImageClip;

/** Canonical timeline duration including speed. Every consumer should use this
 *  rather than (sourceEnd - sourceStart) directly. */
export function clipDuration(clip: Clip): number {
  const raw = clip.sourceEnd - clip.sourceStart;
  const speed = (clip as { speed?: number }).speed ?? 1;
  return raw / Math.max(MIN_SPEED, speed);
}

/** Stable composite z-order key. Higher draws on top.
 *  Primary: clip.zIndex (explicit per-clip layer).
 *  Secondary: track index (later tracks on top by default).
 *  Tertiary: timelineStart (later clips on top within a track). */
export function clipDrawOrder(
  clip: Clip,
  trackOrder: string[]
): [number, number, number] {
  return [
    clip.zIndex ?? 0,
    trackOrder.indexOf(clip.trackId),
    clip.timelineStart,
  ];
}

export function compareClipsForDrawing(
  a: Clip,
  b: Clip,
  trackOrder: string[]
): number {
  const ka = clipDrawOrder(a, trackOrder);
  const kb = clipDrawOrder(b, trackOrder);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

export interface Track {
  id: string;
  name: string;
  type: 'video';
  clips: string[];
}

/** Project-level canvas size. Drives both the preview viewport and the
 *  export resolution — WYSIWYG. */
export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasPreset {
  key: string;
  label: string;
  hint: string;
  size: CanvasSize;
}

export const CANVAS_PRESETS: CanvasPreset[] = [
  { key: '16:9-720',  label: '16:9 · 720p',  hint: 'Widescreen 1280×720',  size: { width: 1280, height: 720 } },
  { key: '16:9-1080', label: '16:9 · 1080p', hint: 'Widescreen 1920×1080', size: { width: 1920, height: 1080 } },
  { key: '16:9-480',  label: '16:9 · 480p',  hint: 'Widescreen 854×480',   size: { width: 854,  height: 480 } },
  { key: '9:16-720',  label: '9:16 · Phone', hint: 'Vertical 720×1280',    size: { width: 720,  height: 1280 } },
  { key: '9:16-1080', label: '9:16 · Phone HD', hint: 'Vertical 1080×1920', size: { width: 1080, height: 1920 } },
  { key: '1:1-1080',  label: '1:1 · Square', hint: 'Square 1080×1080',     size: { width: 1080, height: 1080 } },
  { key: '4:5-1080',  label: '4:5 · Portrait', hint: 'Portrait 1080×1350', size: { width: 1080, height: 1350 } },
  { key: '21:9-1080', label: '21:9 · Cinema', hint: 'Ultrawide 2560×1080', size: { width: 2560, height: 1080 } },
];

export const DEFAULT_CANVAS: CanvasSize = CANVAS_PRESETS[0].size;

export interface ProjectState {
  projectName: string;
  mediaFiles: Record<string, MediaFile>;
  tracks: Record<string, Track>;
  clips: Record<string, Clip>;
  trackOrder: string[];
  playheadPosition: number;
  isPlaying: boolean;
  zoomLevel: number;
  selectedClipIds: string[];
  canvas: CanvasSize;
}

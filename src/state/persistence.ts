import type {
  Clip,
  ColorAdjust,
  FontFamilyKey,
  ImageClip,
  MediaKind,
  ProjectState,
  TextPosition,
  Transform,
  TransitionKind,
  TransitionOut,
  VideoClip,
  VideoFit,
} from '../types/project';
import { DEFAULT_TRANSFORM, MAX_SPEED, MIN_SPEED, NEUTRAL_COLOR } from '../types/project';
import { initialState } from './reducer';

const KEY_V4 = 'montaj:project:v4';
const KEY_V3 = 'montaj:project:v3';
const KEY_V2 = 'montaj:project:v2';
const LEGACY_KEY = 'montaj:project:v1';

interface SerializedMediaFile {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  kind?: MediaKind;
}

interface SerializedProject {
  version: 2 | 3 | 4;
  projectName: string;
  tracks: ProjectState['tracks'];
  clips: ProjectState['clips'];
  trackOrder: string[];
  mediaFiles: Record<string, SerializedMediaFile>;
  canvas?: { width: number; height: number };
}

const ALLOWED_TRANSITION_KINDS = new Set<TransitionKind>([
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'pixelize', 'radial',
]);

const ALLOWED_FITS = new Set<VideoFit>(['contain', 'cover', 'free']);

const ALLOWED_FONT_FAMILIES = new Set<FontFamilyKey>([
  'sans', 'serif', 'mono', 'display', 'handwriting',
]);

function safeTransform(input: unknown): Transform {
  const t = (input ?? {}) as Partial<Transform>;
  return {
    x: typeof t.x === 'number' ? t.x : DEFAULT_TRANSFORM.x,
    y: typeof t.y === 'number' ? t.y : DEFAULT_TRANSFORM.y,
    scale: typeof t.scale === 'number' && t.scale > 0 ? t.scale : DEFAULT_TRANSFORM.scale,
    rotation: typeof t.rotation === 'number' ? t.rotation : DEFAULT_TRANSFORM.rotation,
  };
}

function safeColor(input: unknown): ColorAdjust | null {
  if (input == null) return null;
  const c = input as Partial<ColorAdjust>;
  return {
    brightness: typeof c.brightness === 'number' ? c.brightness : NEUTRAL_COLOR.brightness,
    contrast: typeof c.contrast === 'number' ? c.contrast : NEUTRAL_COLOR.contrast,
    saturation: typeof c.saturation === 'number' ? c.saturation : NEUTRAL_COLOR.saturation,
    hue: typeof c.hue === 'number' ? c.hue : NEUTRAL_COLOR.hue,
  };
}

function safeTransition(input: unknown): TransitionOut | null {
  if (input == null) return null;
  const t = input as Partial<TransitionOut> & { kind?: string };
  let kind: TransitionKind = 'fade';
  if (typeof t.kind === 'string' && ALLOWED_TRANSITION_KINDS.has(t.kind as TransitionKind)) {
    kind = t.kind as TransitionKind;
  }
  const duration = typeof t.duration === 'number' && t.duration > 0 ? t.duration : 1;
  return { kind, duration };
}

function safeFit(input: unknown): VideoFit {
  if (typeof input === 'string' && ALLOWED_FITS.has(input as VideoFit)) {
    return input as VideoFit;
  }
  return 'contain';
}

function safeSpeed(input: unknown): number {
  if (typeof input === 'number' && input > 0) {
    return Math.max(MIN_SPEED, Math.min(MAX_SPEED, input));
  }
  return 1;
}

function safeFontFamily(input: unknown): FontFamilyKey {
  if (typeof input === 'string' && ALLOWED_FONT_FAMILIES.has(input as FontFamilyKey)) {
    return input as FontFamilyKey;
  }
  return 'sans';
}

function safeMediaKind(input: unknown): MediaKind {
  return input === 'image' ? 'image' : 'video';
}

function transformFromLegacyPosition(pos: TextPosition | undefined): Transform {
  if (pos === 'top') return { x: 0.5, y: 0.05, scale: 1, rotation: 0 };
  if (pos === 'bottom') return { x: 0.5, y: 0.95, scale: 1, rotation: 0 };
  return { ...DEFAULT_TRANSFORM };
}

export function serialize(state: ProjectState): string {
  const mediaFiles: Record<string, SerializedMediaFile> = {};
  for (const [id, m] of Object.entries(state.mediaFiles)) {
    mediaFiles[id] = {
      id: m.id,
      name: m.name,
      duration: m.duration,
      width: m.width,
      height: m.height,
      hasAudio: m.hasAudio,
      kind: m.kind,
    };
  }
  const payload: SerializedProject = {
    version: 4,
    projectName: state.projectName,
    tracks: state.tracks,
    clips: state.clips,
    trackOrder: state.trackOrder,
    mediaFiles,
    canvas: state.canvas,
  };
  return JSON.stringify(payload);
}

/** Reads v2, v3, or v4 and returns ProjectState. */
export function deserialize(raw: string): ProjectState | null {
  try {
    const data = JSON.parse(raw) as { version?: number };
    if (data.version !== 2 && data.version !== 3 && data.version !== 4) return null;

    const fromV2 = data.version === 2;
    const d = data as unknown as SerializedProject & { mediaFiles?: Record<string, SerializedMediaFile> };

    const mediaFiles: ProjectState['mediaFiles'] = {};
    for (const [id, m] of Object.entries(d.mediaFiles ?? {})) {
      mediaFiles[id] = {
        id: m.id,
        name: m.name,
        duration: m.duration,
        width: m.width,
        height: m.height,
        hasAudio: m.hasAudio ?? true,
        kind: safeMediaKind(m.kind),
        file: null,
        objectUrl: '',
        status: 'hydrating',
      };
    }

    const clips: Record<string, Clip> = {};
    for (const [id, rawClip] of Object.entries(
      (d.clips ?? {}) as Record<string, Partial<Clip> & Record<string, unknown>>
    )) {
      const kind = (rawClip.kind as Clip['kind']) ?? 'video';
      const transitionOut = safeTransition(rawClip.transitionOut);
      const transitionIn = safeTransition(rawClip.transitionIn);
      const speed = safeSpeed(rawClip.speed);
      const zIndex = typeof rawClip.zIndex === 'number' ? Math.round(rawClip.zIndex) : 0;

      if (kind === 'text') {
        const transform = fromV2
          ? transformFromLegacyPosition(rawClip.position as TextPosition | undefined)
          : safeTransform(rawClip.transform);

        clips[id] = {
          id,
          kind: 'text',
          sourceStart: (rawClip.sourceStart as number | undefined) ?? 0,
          sourceEnd: (rawClip.sourceEnd as number | undefined) ?? 3,
          timelineStart: (rawClip.timelineStart as number | undefined) ?? 0,
          trackId: (rawClip.trackId as string | undefined) ?? 'track-1',
          zIndex,
          text: (rawClip.text as string | undefined) ?? 'Text',
          color: (rawClip.color as string | undefined) ?? '#ffffff',
          fontSize: (rawClip.fontSize as number | undefined) ?? 8,
          fontFamily: safeFontFamily(rawClip.fontFamily),
          transform,
          speed,
          transitionOut,
          transitionIn,
        };
      } else if (kind === 'image') {
        const v = rawClip as Partial<ImageClip> & Record<string, unknown>;
        clips[id] = {
          id,
          kind: 'image',
          mediaFileId: (v.mediaFileId as string | undefined) ?? '',
          sourceStart: 0,
          sourceEnd: (v.sourceEnd as number | undefined) ?? 4,
          timelineStart: (v.timelineStart as number | undefined) ?? 0,
          trackId: (v.trackId as string | undefined) ?? 'track-1',
          zIndex,
          fit: safeFit(v.fit),
          transform: safeTransform(v.transform),
          color: safeColor(v.color),
          speed,
          transitionOut,
          transitionIn,
        };
      } else {
        const v = rawClip as Partial<VideoClip> & Record<string, unknown>;
        clips[id] = {
          id,
          kind: 'video',
          mediaFileId: (v.mediaFileId as string | undefined) ?? '',
          sourceStart: (v.sourceStart as number | undefined) ?? 0,
          sourceEnd: (v.sourceEnd as number | undefined) ?? 0,
          timelineStart: (v.timelineStart as number | undefined) ?? 0,
          trackId: (v.trackId as string | undefined) ?? 'track-1',
          zIndex,
          volume: (v.volume as number | undefined) ?? 1,
          muted: (v.muted as boolean | undefined) ?? false,
          pan: (v.pan as number | undefined) ?? 0,
          duckSourceClipId: (v.duckSourceClipId as string | null | undefined) ?? null,
          duckAmount: (v.duckAmount as number | undefined) ?? 0.6,
          fit: safeFit(v.fit),
          transform: safeTransform(v.transform),
          color: safeColor(v.color),
          speed,
          transitionOut,
          transitionIn,
        };
      }
    }

    const persistedCanvas = d.canvas;
    const canvas =
      persistedCanvas && persistedCanvas.width > 0 && persistedCanvas.height > 0
        ? { width: persistedCanvas.width, height: persistedCanvas.height }
        : { ...initialState.canvas };

    return {
      ...initialState,
      projectName: d.projectName ?? initialState.projectName,
      tracks: d.tracks ?? initialState.tracks,
      clips,
      trackOrder: d.trackOrder ?? initialState.trackOrder,
      mediaFiles,
      canvas,
    };
  } catch {
    return null;
  }
}

export function loadProject(): ProjectState | null {
  try {
    const v4 = localStorage.getItem(KEY_V4);
    if (v4) return deserialize(v4);

    // Migrate from v3 → v4 once.
    const v3 = localStorage.getItem(KEY_V3);
    if (v3) {
      const migrated = deserialize(v3);
      if (migrated) {
        try {
          localStorage.setItem(KEY_V4, serialize(migrated));
          localStorage.removeItem(KEY_V3);
        } catch {
          // ignore quota
        }
        return migrated;
      }
    }

    // Migrate from v2 directly to v4 (skipping v3).
    const v2 = localStorage.getItem(KEY_V2);
    if (v2) {
      const migrated = deserialize(v2);
      if (migrated) {
        try {
          localStorage.setItem(KEY_V4, serialize(migrated));
          localStorage.removeItem(KEY_V2);
        } catch {
          // ignore quota
        }
        return migrated;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function saveProject(state: ProjectState): void {
  try {
    localStorage.setItem(KEY_V4, serialize(state));
  } catch {
    // quota / disabled
  }
}

export function clearSavedProject(): void {
  try {
    localStorage.removeItem(KEY_V4);
  } catch {
    // ignore
  }
}

export function migrateLegacyV1(): boolean {
  try {
    if (!localStorage.getItem(LEGACY_KEY)) return false;
    localStorage.removeItem(LEGACY_KEY);
    return true;
  } catch {
    return false;
  }
}

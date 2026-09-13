import type { Clip, ProjectState, Transform } from '../types/project';
import { DEFAULT_CANVAS, MIN_SPEED, clipDuration } from '../types/project';
import type { Action } from './actions';
import { newId } from '../utils/id';

function clampTransform(t: Transform): Transform {
  const wrap = (deg: number) => {
    let n = deg % 360;
    if (n > 180) n -= 360;
    else if (n < -180) n += 360;
    return n;
  };
  return {
    x: Math.max(-0.5, Math.min(1.5, t.x)),
    y: Math.max(-0.5, Math.min(1.5, t.y)),
    scale: Math.max(0.05, Math.min(8, t.scale)),
    rotation: wrap(t.rotation),
  };
}

export const initialState: ProjectState = {
  projectName: 'Untitled Project',
  mediaFiles: {},
  tracks: {
    'track-1': { id: 'track-1', name: 'Video 1', type: 'video', clips: [] },
  },
  clips: {},
  trackOrder: ['track-1'],
  playheadPosition: 0,
  isPlaying: false,
  zoomLevel: 50,
  selectedClipIds: [],
  canvas: { ...DEFAULT_CANVAS },
};

export function projectReducer(state: ProjectState, action: Action): ProjectState {
  switch (action.type) {
    case 'ADD_MEDIA_FILE':
      return {
        ...state,
        mediaFiles: { ...state.mediaFiles, [action.payload.id]: action.payload },
      };

    case 'MEDIA_HYDRATED': {
      const existing = state.mediaFiles[action.payload.id];
      if (!existing) return state;
      if (existing.status === 'ready' && existing.objectUrl === action.payload.objectUrl) return state;
      return {
        ...state,
        mediaFiles: {
          ...state.mediaFiles,
          [action.payload.id]: {
            ...existing,
            file: action.payload.file,
            objectUrl: action.payload.objectUrl,
            status: 'ready',
          },
        },
      };
    }

    case 'SET_MEDIA_STATUS': {
      const existing = state.mediaFiles[action.payload.id];
      if (!existing || existing.status === action.payload.status) return state;
      return {
        ...state,
        mediaFiles: {
          ...state.mediaFiles,
          [action.payload.id]: { ...existing, status: action.payload.status },
        },
      };
    }

    case 'SET_MEDIA_HAS_AUDIO': {
      const existing = state.mediaFiles[action.payload.id];
      if (!existing || existing.hasAudio === action.payload.hasAudio) return state;
      return {
        ...state,
        mediaFiles: {
          ...state.mediaFiles,
          [action.payload.id]: { ...existing, hasAudio: action.payload.hasAudio },
        },
      };
    }

    case 'ADD_CLIP': {
      const { clip, trackId } = action.payload;
      const track = state.tracks[trackId];
      if (!track) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: clip },
        tracks: {
          ...state.tracks,
          [trackId]: { ...track, clips: [...track.clips, clip.id] },
        },
      };
    }

    case 'SPLIT_CLIP': {
      const { clipId, splitTime } = action.payload;
      const clip = state.clips[clipId];
      if (!clip) return state;

      // splitTime is in timeline seconds. Source seconds advance at
      // `speed × timeline seconds`, so the split point in source space must
      // multiply the timeline offset by speed.
      const dur = clipDuration(clip);
      const clipEnd = clip.timelineStart + dur;
      if (splitTime <= clip.timelineStart || splitTime >= clipEnd) return state;

      const offsetInClip = splitTime - clip.timelineStart;
      const speed = Math.max(MIN_SPEED, (clip as { speed?: number }).speed ?? 1);
      const splitSourceTime = clip.sourceStart + offsetInClip * speed;

      const track = state.tracks[clip.trackId];
      if (!track) return state;

      const leftId = newId('clip');
      const rightId = newId('clip');

      // Left loses any transitionOut (it now abuts the new right half, not the original next clip).
      // Left loses its transitionOut (now abuts the new right half, not the original next).
      // Right loses its transitionIn for the same reason — the join with `left` is internal.
      const leftClip = { ...clip, id: leftId, sourceEnd: splitSourceTime, transitionOut: null };
      const rightClip = {
        ...clip,
        id: rightId,
        sourceStart: splitSourceTime,
        timelineStart: splitTime,
        transitionIn: null,
      };

      const clipIndex = track.clips.indexOf(clipId);
      const newClipList = [...track.clips];
      newClipList.splice(clipIndex, 1, leftId, rightId);

      const { [clipId]: _, ...restClips } = state.clips;

      return {
        ...state,
        clips: { ...restClips, [leftId]: leftClip, [rightId]: rightClip },
        tracks: {
          ...state.tracks,
          [clip.trackId]: { ...track, clips: newClipList },
        },
        selectedClipIds: [],
      };
    }

    case 'DELETE_CLIP': {
      const { clipId } = action.payload;
      const clip = state.clips[clipId];
      if (!clip) return state;

      const track = state.tracks[clip.trackId];
      if (!track) return state;
      const { [clipId]: _, ...restClips } = state.clips;

      // Cascade: clear any video clip that was ducking against this one.
      const cleaned: Record<string, Clip> = {};
      for (const [id, c] of Object.entries(restClips)) {
        if (c.kind === 'video' && c.duckSourceClipId === clipId) {
          cleaned[id] = { ...c, duckSourceClipId: null, duckAmount: 0 };
        } else {
          cleaned[id] = c;
        }
      }

      return {
        ...state,
        clips: cleaned,
        tracks: {
          ...state.tracks,
          [clip.trackId]: {
            ...track,
            clips: track.clips.filter((id) => id !== clipId),
          },
        },
        selectedClipIds: state.selectedClipIds.filter((id) => id !== clipId),
      };
    }

    case 'TRIM_CLIP': {
      const { clipId, sourceStart, sourceEnd, timelineStart } = action.payload;
      const clip = state.clips[clipId];
      if (!clip) return state;
      if (sourceEnd - sourceStart < 0.05) return state;
      return {
        ...state,
        clips: {
          ...state.clips,
          [clipId]: { ...clip, sourceStart, sourceEnd, timelineStart },
        },
      };
    }

    case 'SET_CLIP_VOLUME': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || clip.kind !== 'video') return state;
      const v = Math.max(0, Math.min(1, action.payload.volume));
      if (clip.volume === v) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, volume: v } },
      };
    }

    case 'SET_CLIP_MUTED': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || clip.kind !== 'video') return state;
      if (clip.muted === action.payload.muted) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, muted: action.payload.muted } },
      };
    }

    case 'SET_CLIP_TRANSITION': {
      const clip = state.clips[action.payload.clipId];
      if (!clip) return state;
      return {
        ...state,
        clips: {
          ...state.clips,
          [clip.id]: { ...clip, transitionOut: action.payload.transition },
        },
      };
    }

    case 'SET_CLIP_TRANSITION_IN': {
      const clip = state.clips[action.payload.clipId];
      if (!clip) return state;
      return {
        ...state,
        clips: {
          ...state.clips,
          [clip.id]: { ...clip, transitionIn: action.payload.transition },
        },
      };
    }

    case 'UPDATE_TEXT_CLIP': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || clip.kind !== 'text') return state;
      const next = {
        ...clip,
        text: action.payload.text ?? clip.text,
        color: action.payload.color ?? clip.color,
        fontSize: action.payload.fontSize ?? clip.fontSize,
        fontFamily: action.payload.fontFamily ?? clip.fontFamily,
      };
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: next },
      };
    }

    case 'SET_CLIP_TRANSFORM': {
      const clip = state.clips[action.payload.clipId];
      if (!clip) return state;
      const merged = clampTransform({ ...clip.transform, ...action.payload.transform });
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, transform: merged } },
      };
    }

    case 'SET_CLIP_SPEED': {
      const clip = state.clips[action.payload.clipId];
      if (!clip) return state;
      const s = Math.max(0.25, Math.min(4, action.payload.speed));
      if (clip.speed === s) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, speed: s } },
      };
    }

    case 'SET_CLIP_Z_INDEX': {
      const clip = state.clips[action.payload.clipId];
      if (!clip) return state;
      const z = Math.max(-9999, Math.min(9999, Math.round(action.payload.zIndex)));
      if (clip.zIndex === z) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, zIndex: z } },
      };
    }

    case 'SET_CLIP_FIT': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return state;
      if (clip.fit === action.payload.fit) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, fit: action.payload.fit } },
      };
    }

    case 'SET_CLIP_COLOR': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || (clip.kind !== 'video' && clip.kind !== 'image')) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, color: action.payload.color } },
      };
    }

    case 'SET_CLIP_PAN': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || clip.kind !== 'video') return state;
      const p = Math.max(-1, Math.min(1, action.payload.pan));
      if (clip.pan === p) return state;
      return {
        ...state,
        clips: { ...state.clips, [clip.id]: { ...clip, pan: p } },
      };
    }

    case 'SET_CLIP_DUCK': {
      const clip = state.clips[action.payload.clipId];
      if (!clip || clip.kind !== 'video') return state;
      const amt = Math.max(0, Math.min(1, action.payload.amount));
      const src = action.payload.sourceClipId;
      if (clip.duckSourceClipId === src && clip.duckAmount === amt) return state;
      return {
        ...state,
        clips: {
          ...state.clips,
          [clip.id]: { ...clip, duckSourceClipId: src, duckAmount: amt },
        },
      };
    }

    case 'MOVE_CLIP': {
      const { clipId, newTimelineStart, newTrackId } = action.payload;
      const clip = state.clips[clipId];
      if (!clip) return state;

      const updatedClip = {
        ...clip,
        timelineStart: newTimelineStart,
        trackId: newTrackId ?? clip.trackId,
      };

      let newTracks = state.tracks;
      if (newTrackId && newTrackId !== clip.trackId) {
        const oldTrack = state.tracks[clip.trackId];
        const newTrack = state.tracks[newTrackId];
        if (!oldTrack || !newTrack) return state;
        newTracks = {
          ...state.tracks,
          [clip.trackId]: {
            ...oldTrack,
            clips: oldTrack.clips.filter((id) => id !== clipId),
          },
          [newTrackId]: {
            ...newTrack,
            clips: [...newTrack.clips, clipId],
          },
        };
      }

      return {
        ...state,
        clips: { ...state.clips, [clipId]: updatedClip },
        tracks: newTracks,
      };
    }

    case 'ADD_TRACK': {
      const id = action.payload.id ?? newId('track');
      if (state.tracks[id]) return state;
      return {
        ...state,
        tracks: {
          ...state.tracks,
          [id]: { id, name: action.payload.name, type: 'video', clips: [] },
        },
        trackOrder: [...state.trackOrder, id],
      };
    }

    case 'REMOVE_TRACK': {
      const { trackId } = action.payload;
      if (state.trackOrder.length <= 1) return state;
      const track = state.tracks[trackId];
      if (!track) return state;

      const { [trackId]: _, ...restTracks } = state.tracks;
      const removedClipIds = new Set(track.clips);
      const cleaned: Record<string, Clip> = {};
      for (const [id, c] of Object.entries(state.clips)) {
        if (removedClipIds.has(id)) continue;
        // Cascade: clear duck refs that pointed at any clip on the removed track.
        if (c.kind === 'video' && c.duckSourceClipId && removedClipIds.has(c.duckSourceClipId)) {
          cleaned[id] = { ...c, duckSourceClipId: null, duckAmount: 0 };
        } else {
          cleaned[id] = c;
        }
      }

      return {
        ...state,
        tracks: restTracks,
        clips: cleaned,
        trackOrder: state.trackOrder.filter((id) => id !== trackId),
        selectedClipIds: state.selectedClipIds.filter((id) => !removedClipIds.has(id)),
      };
    }

    case 'SET_PLAYHEAD':
      return { ...state, playheadPosition: action.payload };

    case 'SET_PLAYING':
      return { ...state, isPlaying: action.payload };

    case 'SET_ZOOM':
      return { ...state, zoomLevel: action.payload };

    case 'SET_CANVAS': {
      // Clamp to reasonable bounds and even dimensions (h264 requires even).
      const w = Math.max(64, Math.round(action.payload.width / 2) * 2);
      const h = Math.max(64, Math.round(action.payload.height / 2) * 2);
      if (state.canvas.width === w && state.canvas.height === h) return state;
      return { ...state, canvas: { width: w, height: h } };
    }

    case 'SELECT_CLIP':
      return { ...state, selectedClipIds: action.payload };

    default:
      return state;
  }
}

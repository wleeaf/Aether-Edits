import type { Clip, ColorAdjust, FontFamilyKey, MediaFile, MediaStatus, Transform, TransitionOut, VideoFit } from '../types/project';

export type Action =
  | { type: 'ADD_MEDIA_FILE'; payload: MediaFile }
  | { type: 'MEDIA_HYDRATED'; payload: { id: string; file: File; objectUrl: string } }
  | { type: 'SET_MEDIA_STATUS'; payload: { id: string; status: MediaStatus } }
  | { type: 'SET_MEDIA_HAS_AUDIO'; payload: { id: string; hasAudio: boolean } }
  | { type: 'ADD_CLIP'; payload: { clip: Clip; trackId: string } }
  | { type: 'SPLIT_CLIP'; payload: { clipId: string; splitTime: number } }
  | { type: 'DELETE_CLIP'; payload: { clipId: string } }
  | { type: 'MOVE_CLIP'; payload: { clipId: string; newTimelineStart: number; newTrackId?: string } }
  | {
      type: 'TRIM_CLIP';
      payload: { clipId: string; sourceStart: number; sourceEnd: number; timelineStart: number };
    }
  | { type: 'SET_CLIP_VOLUME'; payload: { clipId: string; volume: number } }
  | { type: 'SET_CLIP_MUTED'; payload: { clipId: string; muted: boolean } }
  | { type: 'SET_CLIP_TRANSITION'; payload: { clipId: string; transition: TransitionOut | null } }
  | { type: 'SET_CLIP_TRANSITION_IN'; payload: { clipId: string; transition: TransitionOut | null } }
  | { type: 'SET_CLIP_TRANSFORM'; payload: { clipId: string; transform: Partial<Transform> } }
  | { type: 'SET_CLIP_FIT'; payload: { clipId: string; fit: VideoFit } }
  | { type: 'SET_CLIP_COLOR'; payload: { clipId: string; color: ColorAdjust | null } }
  | { type: 'SET_CLIP_PAN'; payload: { clipId: string; pan: number } }
  | { type: 'SET_CLIP_DUCK'; payload: { clipId: string; sourceClipId: string | null; amount: number } }
  | { type: 'SET_CLIP_SPEED'; payload: { clipId: string; speed: number } }
  | { type: 'SET_CLIP_Z_INDEX'; payload: { clipId: string; zIndex: number } }
  | { type: 'SET_CANVAS'; payload: { width: number; height: number } }
  | {
      type: 'UPDATE_TEXT_CLIP';
      payload: {
        clipId: string;
        text?: string;
        color?: string;
        fontSize?: number;
        fontFamily?: FontFamilyKey;
      };
    }
  | { type: 'ADD_TRACK'; payload: { name: string; id?: string } }
  | { type: 'REMOVE_TRACK'; payload: { trackId: string } }
  | { type: 'SET_PLAYHEAD'; payload: number }
  | { type: 'SET_PLAYING'; payload: boolean }
  | { type: 'SET_ZOOM'; payload: number }
  | { type: 'SELECT_CLIP'; payload: string[] }
  | { type: 'UNDO' }
  | { type: 'REDO' };

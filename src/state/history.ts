import type { ProjectState } from '../types/project';
import type { Action } from './actions';
import { projectReducer } from './reducer';

export type ProjectSnapshot = Pick<
  ProjectState,
  'mediaFiles' | 'tracks' | 'clips' | 'trackOrder' | 'projectName'
>;

export interface HistoryState {
  past: ProjectSnapshot[];
  present: ProjectState;
  future: ProjectSnapshot[];
}

function snapshot(state: ProjectState): ProjectSnapshot {
  return {
    mediaFiles: state.mediaFiles,
    tracks: state.tracks,
    clips: state.clips,
    trackOrder: state.trackOrder,
    projectName: state.projectName,
  };
}

function restore(state: ProjectState, snap: ProjectSnapshot): ProjectState {
  return { ...state, ...snap };
}

const TRANSIENT_ACTIONS = new Set<Action['type']>([
  'SET_PLAYHEAD',
  'SET_PLAYING',
  'SET_ZOOM',
  'SELECT_CLIP',
  'MEDIA_HYDRATED',
  'SET_MEDIA_STATUS',
  'SET_MEDIA_HAS_AUDIO',
]);

const MAX_HISTORY = 50;

export function historyReducer(state: HistoryState, action: Action): HistoryState {
  if (action.type === 'UNDO') {
    if (state.past.length === 0) return state;
    const previous = state.past[state.past.length - 1];
    return {
      past: state.past.slice(0, -1),
      present: restore(state.present, previous),
      future: [snapshot(state.present), ...state.future],
    };
  }

  if (action.type === 'REDO') {
    if (state.future.length === 0) return state;
    const next = state.future[0];
    return {
      past: [...state.past, snapshot(state.present)],
      present: restore(state.present, next),
      future: state.future.slice(1),
    };
  }

  const newPresent = projectReducer(state.present, action);
  if (newPresent === state.present) return state;

  if (TRANSIENT_ACTIONS.has(action.type)) {
    return { ...state, present: newPresent };
  }

  return {
    past: [...state.past, snapshot(state.present)].slice(-MAX_HISTORY),
    present: newPresent,
    future: [],
  };
}

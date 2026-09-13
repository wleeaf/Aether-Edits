import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { ProjectState } from '../types/project';
import type { Action } from './actions';
import { type HistoryState, historyReducer } from './history';
import { initialState } from './reducer';
import { loadProject, migrateLegacyV1, saveProject } from './persistence';
import { getFile, getOrCreateObjectUrl, requestPersistence } from '../services/mediaStore';

interface ProjectContextValue {
  state: ProjectState;
  dispatch: React.Dispatch<Action>;
  canUndo: boolean;
  canRedo: boolean;
  flushSave: () => void;
  hadLegacyV1: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

// Module-level, so StrictMode's double-effect doesn't re-run hydration.
let hydrationStarted = false;
const legacyV1Migrated = typeof window !== 'undefined' ? migrateLegacyV1() : false;

function buildInitialHistory(): HistoryState {
  const loaded = typeof window !== 'undefined' ? loadProject() : null;
  return {
    past: [],
    present: loaded ?? initialState,
    future: [],
  };
}

const DEBOUNCE_MS = 750;

async function hydrateMediaFiles(
  state: ProjectState,
  dispatch: React.Dispatch<Action>
): Promise<void> {
  for (const id of Object.keys(state.mediaFiles)) {
    const existing = state.mediaFiles[id];
    if (existing.status === 'ready' && existing.file) continue;
    const file = await getFile(id);
    if (!file) {
      dispatch({ type: 'SET_MEDIA_STATUS', payload: { id, status: 'missing' } });
      continue;
    }
    const objectUrl = getOrCreateObjectUrl(id, file);
    dispatch({ type: 'MEDIA_HYDRATED', payload: { id, file, objectUrl } });
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [history, dispatch] = useReducer(historyReducer, undefined, buildInitialHistory);
  const state = history.present;

  // Autosave: debounced on changes to persisted fields only.
  const timerRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      saveProject(stateRef.current);
      timerRef.current = null;
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state.projectName, state.tracks, state.clips, state.trackOrder, state.mediaFiles]);

  const flushSave = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    saveProject(stateRef.current);
  }, []);

  // Hydrate media from IndexedDB on mount (once, guarded against StrictMode re-run).
  useEffect(() => {
    if (hydrationStarted) return;
    hydrationStarted = true;
    void hydrateMediaFiles(stateRef.current, dispatch);
    // Best-effort: request persistent storage so files survive eviction.
    void requestPersistence();
  }, []);

  const value: ProjectContextValue = {
    state,
    dispatch,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    flushSave,
    hadLegacyV1: legacyV1Migrated,
  };

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within ProjectProvider');
  return ctx;
}

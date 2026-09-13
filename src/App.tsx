import { useEffect, useState } from 'react';
import { ProjectProvider, useProject } from './state/ProjectContext';
import { TopBar } from './components/TopBar/TopBar';
import { Sidebar } from './components/Sidebar/Sidebar';
import { PreviewPanel } from './components/Preview/PreviewPanel';
import { TimelinePanel } from './components/Timeline/TimelinePanel';
import { ExportDialog } from './components/Export/ExportDialog';
import { clipDuration } from './types/project';

function EditorShortcuts() {
  const { state, dispatch } = useProject();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't hijack keystrokes when the user is typing into an input. Without
      // this guard Backspace in the inspector text field deletes the entire
      // clip, Space inserts a play/pause, etc.
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (inEditable) return;

      // Split-at-playhead: if any clips are selected, only those; otherwise
      // every clip whose timeline range contains the playhead. Used by both
      // `s` and `Ctrl/Cmd+S`.
      const splitAtPlayhead = () => {
        const playhead = state.playheadPosition;
        const targets = state.selectedClipIds.length > 0
          ? state.selectedClipIds
              .map((id) => state.clips[id])
              .filter((c) => c)
          : Object.values(state.clips).filter((c) => {
              const end = c.timelineStart + clipDuration(c);
              return c.timelineStart < playhead && playhead < end;
            });
        for (const clip of targets) {
          const end = clip.timelineStart + clipDuration(clip);
          if (clip.timelineStart < playhead && playhead < end) {
            dispatch({
              type: 'SPLIT_CLIP',
              payload: { clipId: clip.id, splitTime: playhead },
            });
          }
        }
      };

      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'REDO' });
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        // Select all clips. Browser default Ctrl+A would select all text
        // on the page; we override it for the editor surface.
        e.preventDefault();
        dispatch({ type: 'SELECT_CLIP', payload: Object.keys(state.clips) });
      } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+S: split-at-playhead. Overrides browser "save page".
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === 's' && !(e.ctrlKey || e.metaKey)) {
        // Bare `s` aliases Ctrl+S for muscle memory.
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === ' ') {
        e.preventDefault();
        dispatch({ type: 'SET_PLAYING', payload: !state.isPlaying });
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        state.selectedClipIds.forEach((clipId) => {
          dispatch({ type: 'DELETE_CLIP', payload: { clipId } });
        });
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, state.isPlaying, state.selectedClipIds, state.playheadPosition, state.clips]);

  return null;
}

function App() {
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <ProjectProvider>
      <EditorShortcuts />
      <TopBar onExport={() => setExportOpen(true)} />
      <main className="editor-layout">
        <Sidebar />
        <PreviewPanel />
        <TimelinePanel />
      </main>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </ProjectProvider>
  );
}

export default App;

import { useRef, useState } from 'react';
import { useProject } from '../../state/ProjectContext';
import { CANVAS_PRESETS } from '../../types/project';
import { Select } from '../ui/Select';
import { DownloadIcon, RedoIcon, SaveIcon, UndoIcon } from '../icons';

export function TopBar({ onExport }: { onExport: () => void }) {
  const { state, dispatch, canUndo, canRedo, flushSave } = useProject();
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<number | null>(null);

  const handleSave = () => {
    flushSave();
    setJustSaved(true);
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = window.setTimeout(() => {
      setJustSaved(false);
      savedTimerRef.current = null;
    }, 1500);
  };

  // Match the project's current canvas to a preset key (for the dropdown's
  // active value). Falls back to the first preset's key if no match.
  const activeKey =
    CANVAS_PRESETS.find(
      (p) => p.size.width === state.canvas.width && p.size.height === state.canvas.height
    )?.key ?? '';

  const canvasOptions = CANVAS_PRESETS.map((p) => ({
    value: p.key,
    label: p.label,
    hint: `${p.size.width}×${p.size.height}`,
  }));

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <div className="topbar-logo-mark" aria-hidden>
            <span>Æ</span>
          </div>
          Aether Edits
          <span className="topbar-badge">Beta</span>
        </div>
      </div>

      <div className="topbar-center">
        <div className="topbar-canvas-picker" title="Project canvas — preview & export use this">
          <span className="topbar-canvas-label">Canvas</span>
          <Select
            value={activeKey}
            options={canvasOptions}
            onChange={(key) => {
              const preset = CANVAS_PRESETS.find((p) => p.key === key);
              if (preset) dispatch({ type: 'SET_CANVAS', payload: { ...preset.size } });
            }}
            ariaLabel="Canvas size"
            triggerLabel={
              activeKey
                ? `${CANVAS_PRESETS.find((p) => p.key === activeKey)?.label ?? ''} · ${state.canvas.width}×${state.canvas.height}`
                : `Custom · ${state.canvas.width}×${state.canvas.height}`
            }
          />
        </div>
        <button
          className="btn btn-ghost"
          disabled={!canUndo}
          onClick={() => dispatch({ type: 'UNDO' })}
          title="Undo (Ctrl+Z)"
        >
          <UndoIcon className="icon-sm" />
          <span>Undo</span>
        </button>
        <button
          className="btn btn-ghost"
          disabled={!canRedo}
          onClick={() => dispatch({ type: 'REDO' })}
          title="Redo (Ctrl+Shift+Z)"
        >
          <RedoIcon className="icon-sm" />
          <span>Redo</span>
        </button>
      </div>

      <div className="topbar-right">
        <button className="btn btn-secondary" onClick={handleSave}>
          <SaveIcon className="icon-sm" />
          <span>{justSaved ? 'Saved' : 'Save'}</span>
        </button>
        <button className="btn btn-primary" onClick={onExport}>
          <DownloadIcon className="icon-sm" />
          <span>Export</span>
        </button>
      </div>
    </header>
  );
}

import { useProject } from '../../state/ProjectContext';
import type { TransitionKind } from '../../types/project';

export const FX_DRAG_MIME = 'application/x-aether-fx';

const KINDS: { kind: TransitionKind; label: string }[] = [
  { kind: 'fade', label: 'Fade' },
  { kind: 'fadeblack', label: 'Fade · Black' },
  { kind: 'fadewhite', label: 'Fade · White' },
  { kind: 'dissolve', label: 'Dissolve' },
  { kind: 'wipeleft', label: 'Wipe ←' },
  { kind: 'wiperight', label: 'Wipe →' },
  { kind: 'wipeup', label: 'Wipe ↑' },
  { kind: 'wipedown', label: 'Wipe ↓' },
  { kind: 'slideleft', label: 'Slide ←' },
  { kind: 'slideright', label: 'Slide →' },
  { kind: 'slideup', label: 'Slide ↑' },
  { kind: 'slidedown', label: 'Slide ↓' },
  { kind: 'circleopen', label: 'Circle Open' },
  { kind: 'circleclose', label: 'Circle Close' },
  { kind: 'pixelize', label: 'Pixelize' },
  { kind: 'radial', label: 'Radial' },
];

export function EffectsPanel() {
  const { state, dispatch } = useProject();
  const selectedId = state.selectedClipIds.length === 1 ? state.selectedClipIds[0] : null;
  const selected = selectedId ? state.clips[selectedId] : null;
  const currentKind = selected?.transitionOut?.kind ?? null;
  const currentDuration = selected?.transitionOut?.duration ?? 1;

  const apply = (kind: TransitionKind) => {
    if (!selectedId) return;
    dispatch({
      type: 'SET_CLIP_TRANSITION',
      payload: { clipId: selectedId, transition: { kind, duration: currentDuration } },
    });
  };

  const setDuration = (d: number) => {
    if (!selectedId || !selected?.transitionOut) return;
    dispatch({
      type: 'SET_CLIP_TRANSITION',
      payload: { clipId: selectedId, transition: { ...selected.transitionOut, duration: d } },
    });
  };

  const clear = () => {
    if (!selectedId) return;
    dispatch({
      type: 'SET_CLIP_TRANSITION',
      payload: { clipId: selectedId, transition: null },
    });
  };

  return (
    <div className="fx-panel">
      <div className="sidebar-section-title">Transitions</div>
      <div className="fx-status">
        {selected ? (
          currentKind ? (
            <>
              Applied: <strong>{currentKind}</strong> · {currentDuration.toFixed(1)}s
            </>
          ) : (
            <>Click an effect to add a transition out of this clip.</>
          )
        ) : (
          <>Select a clip first to apply a transition.</>
        )}
      </div>

      <div className="fx-grid">
        {KINDS.map(({ kind, label }) => {
          const active = currentKind === kind;
          return (
            <button
              key={kind}
              className={`fx-card ${active ? 'active' : ''}`}
              onClick={() => apply(kind)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData(FX_DRAG_MIME, kind);
                e.dataTransfer.setData('text/plain', kind);
                window.dispatchEvent(new CustomEvent('aether-fx-drag-start', { detail: kind }));
              }}
              onDragEnd={() => {
                window.dispatchEvent(new CustomEvent('aether-fx-drag-end'));
              }}
              title={`Drag ${label} onto a clip — or click while a clip is selected`}
            >
              <div className="fx-thumb" data-kind={kind} />
              <div className="fx-card-name">{label}</div>
            </button>
          );
        })}
      </div>

      {currentKind && (
        <>
          <div className="fx-duration-control">
            <span>Duration</span>
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.1}
              value={currentDuration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
            <span className="inspector-value">{currentDuration.toFixed(1)}s</span>
          </div>
          <button className="fx-clear-btn" onClick={clear}>
            Remove transition
          </button>
        </>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Transitions apply between this clip and the next clip on the same track
        when they are exactly adjacent. Free-fit clips are excluded — pin them
        to <em>contain</em> or <em>cover</em> first.
      </div>
    </div>
  );
}

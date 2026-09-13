import { useProject } from '../../state/ProjectContext';
import type {
  Clip,
  ColorAdjust,
  FontFamilyKey,
  ImageClip,
  TextClip,
  VideoClip,
  VideoFit,
} from '../../types/project';
import {
  DEFAULT_TRANSFORM,
  FONT_FAMILIES,
  MAX_SPEED,
  MIN_SPEED,
  NEUTRAL_COLOR,
} from '../../types/project';
import {
  ImageIcon,
  LayerDownIcon,
  LayerUpIcon,
  LayersBackIcon,
  LayersFrontIcon,
  TextIcon,
  VideoIcon,
} from '../icons';

export function Inspector() {
  const { state, dispatch } = useProject();
  if (state.selectedClipIds.length !== 1) {
    return (
      <div>
        <div className="sidebar-section-title">Inspector</div>
        <div className="inspector-empty">
          Select a clip to edit its properties.
        </div>
      </div>
    );
  }
  const clip = state.clips[state.selectedClipIds[0]];
  if (!clip) return null;

  const KindIcon =
    clip.kind === 'video' ? VideoIcon : clip.kind === 'image' ? ImageIcon : TextIcon;
  const kindLabel =
    clip.kind === 'video' ? 'Video clip' : clip.kind === 'image' ? 'Image clip' : 'Text clip';

  return (
    <div>
      <div className="sidebar-section-title">Inspector</div>
      <div className="inspector">
        <div className="inspector-header">
          <span className="inspector-kind">
            <KindIcon className="icon-sm" />
            <span>{kindLabel}</span>
          </span>
        </div>

        {clip.kind === 'video' && <VideoClipFields clip={clip} dispatch={dispatch} />}
        {clip.kind === 'image' && <ImageClipFields clip={clip} dispatch={dispatch} />}
        {clip.kind === 'text' && <TextClipFields clip={clip} dispatch={dispatch} />}

        {(clip.kind === 'text' ||
          ((clip.kind === 'video' || clip.kind === 'image') && clip.fit === 'free')) && (
          <TransformFields clip={clip} dispatch={dispatch} />
        )}

        {(clip.kind === 'video' || clip.kind === 'image') && (
          <ColorFields clip={clip} dispatch={dispatch} />
        )}

        <SpeedField clip={clip} dispatch={dispatch} />
        <ZIndexField clip={clip} dispatch={dispatch} />
      </div>
    </div>
  );
}

function ZIndexField({
  clip,
  dispatch,
}: {
  clip: Clip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  const { state } = useProject();
  const allZ = Object.values(state.clips).map((c) => c.zIndex ?? 0);
  const maxZ = allZ.length ? Math.max(...allZ) : 0;
  const minZ = allZ.length ? Math.min(...allZ) : 0;

  const set = (z: number) =>
    dispatch({ type: 'SET_CLIP_Z_INDEX', payload: { clipId: clip.id, zIndex: z } });

  return (
    <>
      <div className="inspector-field-group-header">
        <span>Layer (z-index)</span>
      </div>
      <div className="inspector-field inspector-field-stack">
        <div className="inspector-chip-grid">
          <button type="button" className="inspector-chip" onClick={() => set(maxZ + 1)}>
            <LayersFrontIcon className="icon-sm" />
            <span>To front</span>
          </button>
          <button type="button" className="inspector-chip" onClick={() => set(minZ - 1)}>
            <LayersBackIcon className="icon-sm" />
            <span>To back</span>
          </button>
          <button type="button" className="inspector-chip" onClick={() => set(clip.zIndex + 1)}>
            <LayerUpIcon className="icon-sm" />
            <span>Forward</span>
          </button>
          <button type="button" className="inspector-chip" onClick={() => set(clip.zIndex - 1)}>
            <LayerDownIcon className="icon-sm" />
            <span>Backward</span>
          </button>
        </div>
      </div>
      <label className="inspector-field">
        <span>Index</span>
        <input
          type="range"
          min={-20}
          max={20}
          step={1}
          value={clip.zIndex}
          onChange={(e) => set(Number(e.target.value))}
        />
        <span className="inspector-value">{clip.zIndex}</span>
      </label>
    </>
  );
}

function FitChips({
  clip,
  dispatch,
}: {
  clip: VideoClip | ImageClip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  const fits: VideoFit[] = ['contain', 'cover', 'free'];
  return (
    <div className="inspector-field inspector-field-stack">
      <span>Fit</span>
      <div className="inspector-chip-row">
        {fits.map((f) => (
          <button
            key={f}
            type="button"
            className={`inspector-chip ${clip.fit === f ? 'active' : ''}`}
            onClick={() =>
              dispatch({
                type: 'SET_CLIP_FIT',
                payload: { clipId: clip.id, fit: f },
              })
            }
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

function VideoClipFields({
  clip,
  dispatch,
}: {
  clip: VideoClip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  const { state } = useProject();
  const duckSources = Object.values(state.clips)
    .filter((c): c is VideoClip => c.kind === 'video' && c.id !== clip.id)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  return (
    <>
      <label className="inspector-field">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(clip.volume * 100)}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_VOLUME',
              payload: { clipId: clip.id, volume: Number(e.target.value) / 100 },
            })
          }
        />
        <span className="inspector-value">{Math.round(clip.volume * 100)}%</span>
      </label>
      <label className="inspector-field">
        <span>Mute</span>
        <input
          type="checkbox"
          checked={clip.muted}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_MUTED',
              payload: { clipId: clip.id, muted: e.target.checked },
            })
          }
        />
      </label>
      <label className="inspector-field">
        <span>Pan</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={clip.pan}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_PAN',
              payload: { clipId: clip.id, pan: Number(e.target.value) },
            })
          }
        />
        <span className="inspector-value">
          {clip.pan === 0
            ? 'C'
            : clip.pan < 0
              ? `L${Math.round(-clip.pan * 100)}`
              : `R${Math.round(clip.pan * 100)}`}
        </span>
      </label>
      <FitChips clip={clip} dispatch={dispatch} />
      <div className="inspector-field-group-header">
        <span>Duck under</span>
      </div>
      <label className="inspector-field">
        <span>Source</span>
        <select
          value={clip.duckSourceClipId ?? ''}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_DUCK',
              payload: {
                clipId: clip.id,
                sourceClipId: e.target.value || null,
                amount: clip.duckAmount,
              },
            })
          }
        >
          <option value="">(off)</option>
          {duckSources.map((s) => {
            const trackName = state.tracks[s.trackId]?.name ?? s.trackId;
            const mediaName = state.mediaFiles[s.mediaFileId]?.name ?? s.id;
            return (
              <option key={s.id} value={s.id}>
                {trackName} · {mediaName} @ {s.timelineStart.toFixed(1)}s
              </option>
            );
          })}
        </select>
      </label>
      {clip.duckSourceClipId && (
        <label className="inspector-field">
          <span>Amount</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={clip.duckAmount}
            onChange={(e) =>
              dispatch({
                type: 'SET_CLIP_DUCK',
                payload: {
                  clipId: clip.id,
                  sourceClipId: clip.duckSourceClipId,
                  amount: Number(e.target.value),
                },
              })
            }
          />
          <span className="inspector-value">−{Math.round(clip.duckAmount * 100)}%</span>
        </label>
      )}
    </>
  );
}

function ImageClipFields({
  clip,
  dispatch,
}: {
  clip: ImageClip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  return (
    <>
      <FitChips clip={clip} dispatch={dispatch} />
      <div className="inspector-hint">
        Drag corners of the box in the preview to resize. Drag the centre to move.
      </div>
    </>
  );
}

function TextClipFields({
  clip,
  dispatch,
}: {
  clip: TextClip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  return (
    <>
      <label className="inspector-field inspector-field-stack">
        <span>Text</span>
        <input
          type="text"
          value={clip.text}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_TEXT_CLIP',
              payload: { clipId: clip.id, text: e.target.value },
            })
          }
        />
      </label>
      <label className="inspector-field">
        <span>Color</span>
        <input
          type="color"
          value={clip.color}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_TEXT_CLIP',
              payload: { clipId: clip.id, color: e.target.value },
            })
          }
        />
      </label>
      <label className="inspector-field">
        <span>Font</span>
        <select
          value={clip.fontFamily}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_TEXT_CLIP',
              payload: { clipId: clip.id, fontFamily: e.target.value as FontFamilyKey },
            })
          }
          style={{ fontFamily: FONT_FAMILIES.find((f) => f.key === clip.fontFamily)?.cssStack }}
        >
          {FONT_FAMILIES.map((f) => (
            <option
              key={f.key}
              value={f.key}
              style={{ fontFamily: f.cssStack }}
            >
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="inspector-field">
        <span>Size</span>
        <input
          type="range"
          min={2}
          max={25}
          step={0.5}
          value={clip.fontSize}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_TEXT_CLIP',
              payload: { clipId: clip.id, fontSize: Number(e.target.value) },
            })
          }
        />
        <span className="inspector-value">{clip.fontSize.toFixed(1)}%</span>
      </label>
    </>
  );
}

function SpeedField({
  clip,
  dispatch,
}: {
  clip: Clip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  // Speed is a no-op for text and image but harmless to expose; users can
  // shrink/expand timeline duration of text and images via speed as a quick lever.
  return (
    <>
      <div className="inspector-field-group-header">
        <span>Speed</span>
      </div>
      <label className="inspector-field">
        <span>×</span>
        <input
          type="range"
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.05}
          value={clip.speed}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_SPEED',
              payload: { clipId: clip.id, speed: Number(e.target.value) },
            })
          }
        />
        <span className="inspector-value">{clip.speed.toFixed(2)}×</span>
      </label>
    </>
  );
}

function TransformFields({
  clip,
  dispatch,
}: {
  clip: Clip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  const t = clip.transform;
  const reset = () =>
    dispatch({
      type: 'SET_CLIP_TRANSFORM',
      payload: { clipId: clip.id, transform: { ...DEFAULT_TRANSFORM } },
    });

  return (
    <>
      <div className="inspector-field-group-header">
        <span>Transform</span>
        <button type="button" className="inspector-link-btn" onClick={reset}>
          Reset
        </button>
      </div>
      <label className="inspector-field">
        <span>X</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={t.x}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_TRANSFORM',
              payload: { clipId: clip.id, transform: { x: Number(e.target.value) } },
            })
          }
        />
        <span className="inspector-value">{Math.round(t.x * 100)}%</span>
      </label>
      <label className="inspector-field">
        <span>Y</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={t.y}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_TRANSFORM',
              payload: { clipId: clip.id, transform: { y: Number(e.target.value) } },
            })
          }
        />
        <span className="inspector-value">{Math.round(t.y * 100)}%</span>
      </label>
      <label className="inspector-field">
        <span>Scale</span>
        <input
          type="range"
          min={0.1}
          max={3}
          step={0.05}
          value={t.scale}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_TRANSFORM',
              payload: { clipId: clip.id, transform: { scale: Number(e.target.value) } },
            })
          }
        />
        <span className="inspector-value">{t.scale.toFixed(2)}×</span>
      </label>
      <label className="inspector-field">
        <span>Rotate</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={t.rotation}
          onChange={(e) =>
            dispatch({
              type: 'SET_CLIP_TRANSFORM',
              payload: { clipId: clip.id, transform: { rotation: Number(e.target.value) } },
            })
          }
        />
        <span className="inspector-value">{Math.round(t.rotation)}°</span>
      </label>
    </>
  );
}

function ColorFields({
  clip,
  dispatch,
}: {
  clip: VideoClip | ImageClip;
  dispatch: React.Dispatch<import('../../state/actions').Action>;
}) {
  const enabled = !!clip.color;
  const c: ColorAdjust = clip.color ?? NEUTRAL_COLOR;

  const update = (patch: Partial<ColorAdjust>) => {
    dispatch({
      type: 'SET_CLIP_COLOR',
      payload: { clipId: clip.id, color: { ...c, ...patch } },
    });
  };
  const toggle = (on: boolean) => {
    dispatch({
      type: 'SET_CLIP_COLOR',
      payload: { clipId: clip.id, color: on ? { ...NEUTRAL_COLOR } : null },
    });
  };

  return (
    <>
      <div className="inspector-field-group-header">
        <span>Color adjust</span>
        {enabled && (
          <button
            type="button"
            className="inspector-link-btn"
            onClick={() =>
              dispatch({
                type: 'SET_CLIP_COLOR',
                payload: { clipId: clip.id, color: { ...NEUTRAL_COLOR } },
              })
            }
          >
            Reset
          </button>
        )}
      </div>
      <label className="inspector-field">
        <span>Enabled</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
        />
      </label>
      {enabled && (
        <>
          <label className="inspector-field">
            <span>Bright</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={c.brightness}
              onChange={(e) => update({ brightness: Number(e.target.value) })}
            />
            <span className="inspector-value">{c.brightness.toFixed(2)}</span>
          </label>
          <label className="inspector-field">
            <span>Contrast</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={c.contrast}
              onChange={(e) => update({ contrast: Number(e.target.value) })}
            />
            <span className="inspector-value">{c.contrast.toFixed(2)}</span>
          </label>
          <label className="inspector-field">
            <span>Saturate</span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={c.saturation}
              onChange={(e) => update({ saturation: Number(e.target.value) })}
            />
            <span className="inspector-value">{c.saturation.toFixed(2)}</span>
          </label>
          <label className="inspector-field">
            <span>Hue</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={c.hue}
              onChange={(e) => update({ hue: Number(e.target.value) })}
            />
            <span className="inspector-value">{Math.round(c.hue)}°</span>
          </label>
        </>
      )}
    </>
  );
}


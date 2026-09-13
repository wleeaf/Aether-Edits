import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Clip, ImageClip, MediaFile, TextClip, Transform, VideoClip } from '../../types/project';
import type { Action } from '../../state/actions';

export interface PendingTransform {
  clipId: string;
  transform: Transform;
}

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  canvasW: number;
  canvasH: number;
  activeClips: Clip[];
  selectedClipIds: string[];
  isPlaying: boolean;
  dispatch: Dispatch<Action>;
  mediaFiles: Record<string, MediaFile>;
  pendingTransform: PendingTransform | null;
  setPendingTransform: Dispatch<SetStateAction<PendingTransform | null>>;
  editingTextId: string | null;
  setEditingTextId: Dispatch<SetStateAction<string | null>>;
}

type DragMode = 'move' | 'scale-corner' | 'rotate';

interface DragState {
  clipId: string;
  mode: DragMode;
  origTransform: Transform;
  startClientX: number;
  startClientY: number;
  startDistPx: number;   // distance from clip center to pointer at drag start
  startAngleRad: number; // angle from clip center to pointer at drag start
}

const SNAP_TARGETS = [0.05, 0.25, 0.5, 0.75, 0.95];
const SNAP_THRESHOLD = 0.04;

function snapTo(v: number): number {
  for (const t of SNAP_TARGETS) if (Math.abs(v - t) < SNAP_THRESHOLD) return t;
  return v;
}

export function CanvasOverlay({
  canvasRef,
  canvasW,
  canvasH,
  activeClips,
  selectedClipIds,
  isPlaying,
  dispatch,
  mediaFiles,
  pendingTransform,
  setPendingTransform,
  editingTextId,
  setEditingTextId,
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const displaySizeRef = useRef(displaySize);
  displaySizeRef.current = displaySize;
  const pendingRef = useRef<PendingTransform | null>(pendingTransform);
  pendingRef.current = pendingTransform;

  // Track canvas display size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const r = canvas.getBoundingClientRect();
      setDisplaySize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef]);

  // Global drag listeners (one effect lifecycle per drag instance).
  useEffect(() => {
    if (!drag) return;

    const canvas = canvasRef.current;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const display = displaySizeRef.current;
      if (display.w <= 0 || display.h <= 0 || !canvas) return;
      const rect = canvas.getBoundingClientRect();

      if (d.mode === 'move') {
        const dx = e.clientX - d.startClientX;
        const dy = e.clientY - d.startClientY;
        let nx = d.origTransform.x + dx / display.w;
        let ny = d.origTransform.y + dy / display.h;
        if (e.shiftKey) {
          nx = snapTo(nx);
          ny = snapTo(ny);
        }
        setPendingTransform({
          clipId: d.clipId,
          transform: { ...d.origTransform, x: nx, y: ny },
        });
      } else if (d.mode === 'scale-corner') {
        const cxView = rect.left + d.origTransform.x * display.w;
        const cyView = rect.top + d.origTransform.y * display.h;
        const cur = Math.hypot(e.clientX - cxView, e.clientY - cyView);
        const ratio = d.startDistPx > 0 ? cur / d.startDistPx : 1;
        const newScale = Math.max(0.05, Math.min(8, d.origTransform.scale * ratio));
        setPendingTransform({
          clipId: d.clipId,
          transform: { ...d.origTransform, scale: newScale },
        });
      } else {
        const cxView = rect.left + d.origTransform.x * display.w;
        const cyView = rect.top + d.origTransform.y * display.h;
        const angle = Math.atan2(e.clientY - cyView, e.clientX - cxView);
        const deltaDeg = ((angle - d.startAngleRad) * 180) / Math.PI;
        let newRot = d.origTransform.rotation + deltaDeg;
        while (newRot > 180) newRot -= 360;
        while (newRot < -180) newRot += 360;
        if (e.shiftKey) newRot = Math.round(newRot / 15) * 15;
        setPendingTransform({
          clipId: d.clipId,
          transform: { ...d.origTransform, rotation: newRot },
        });
      }
    };

    const onUp = () => {
      const d = dragRef.current;
      const pt = pendingRef.current;
      if (d && pt && pt.clipId === d.clipId) {
        dispatch({
          type: 'SET_CLIP_TRANSFORM',
          payload: { clipId: d.clipId, transform: pt.transform },
        });
      }
      setDrag(null);
      setPendingTransform(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.clipId, drag?.mode]);

  const beginDrag = (e: React.PointerEvent, clip: Clip, mode: DragMode, t: Transform): void => {
    e.stopPropagation();
    e.preventDefault();
    const canvas = canvasRef.current;
    const display = displaySizeRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cxView = rect.left + t.x * display.w;
    const cyView = rect.top + t.y * display.h;
    setDrag({
      clipId: clip.id,
      mode,
      origTransform: { ...t },
      startClientX: e.clientX,
      startClientY: e.clientY,
      startDistPx: Math.hypot(e.clientX - cxView, e.clientY - cyView),
      startAngleRad: Math.atan2(e.clientY - cyView, e.clientX - cxView),
    });
    if (!selectedClipIds.includes(clip.id)) {
      dispatch({ type: 'SELECT_CLIP', payload: [clip.id] });
    }
    // Auto-promote video/image clips out of contain/cover so the transform
    // takes effect during the drag.
    if ((clip.kind === 'video' || clip.kind === 'image') && clip.fit !== 'free') {
      dispatch({ type: 'SET_CLIP_FIT', payload: { clipId: clip.id, fit: 'free' } });
    }
  };

  return (
    <div
      ref={overlayRef}
      className="canvas-overlay"
      style={{
        width: displaySize.w || '100%',
        height: displaySize.h || '100%',
        pointerEvents: isPlaying ? 'none' : undefined,
      }}
    >
      {displaySize.w > 0 &&
        activeClips.map((clip) => {
          // Text clips: always interactive (small bbox, hard to find otherwise).
          // Video/image clips: handles visible when selected OR when already in
          // free fit (so the user can see what's resizable).
          const isSelected = selectedClipIds.includes(clip.id);
          if (clip.kind === 'video' || clip.kind === 'image') {
            if (!isSelected && clip.fit !== 'free') return null;
          }
          const t =
            pendingTransform && pendingTransform.clipId === clip.id
              ? pendingTransform.transform
              : clip.transform;
          const box =
            clip.kind === 'text'
              ? measureTextBox(clip, t, canvasH, displaySize.h)
              : measureMediaBox(clip, t, mediaFiles, canvasW, canvasH, displaySize.w, displaySize.h);
          const isEditingThis = clip.kind === 'text' && editingTextId === clip.id;
          return (
            <ClipHandle
              key={clip.id}
              transform={t}
              displayW={displaySize.w}
              displayH={displaySize.h}
              boxW={box.w}
              boxH={box.h}
              isSelected={isSelected}
              zIndex={clip.zIndex}
              onPointerDown={(e, mode) => beginDrag(e, clip, mode, t)}
              onDoubleClick={
                clip.kind === 'text' ? () => setEditingTextId(clip.id) : undefined
              }
              suppressPointer={isEditingThis}
            />
          );
        })}
      {displaySize.w > 0 &&
        editingTextId &&
        (() => {
          const clip = activeClips.find((c) => c.id === editingTextId);
          if (!clip || clip.kind !== 'text') return null;
          const t = clip.transform;
          const box = measureTextBox(clip, t, canvasH, displaySize.h);
          const fontSizeCanvasPx = (clip.fontSize / 100) * canvasH * t.scale;
          const ratio = canvasH > 0 ? displaySize.h / canvasH : 1;
          const fontPxDisplay = Math.max(10, fontSizeCanvasPx * ratio);
          const cx = t.x * displaySize.w;
          const cy = t.y * displaySize.h;
          const w = Math.max(80, box.w + 20);
          const h = Math.max(28, fontPxDisplay * 1.4);
          const commit = (next: string) => {
            dispatch({
              type: 'UPDATE_TEXT_CLIP',
              payload: { clipId: clip.id, text: next },
            });
          };
          return (
            <TextEditInput
              key={`edit-${clip.id}`}
              initial={clip.text}
              onCommit={commit}
              onClose={() => setEditingTextId(null)}
              style={{
                position: 'absolute',
                left: cx - w / 2,
                top: cy - h / 2,
                width: w,
                height: h,
                fontSize: fontPxDisplay,
                color: clip.color,
                transform: `rotate(${t.rotation}deg)`,
              }}
            />
          );
        })()}
    </div>
  );
}

interface HandleProps {
  transform: Transform;
  displayW: number;
  displayH: number;
  boxW: number;
  boxH: number;
  isSelected: boolean;
  zIndex: number;
  onPointerDown: (e: React.PointerEvent, mode: DragMode) => void;
  onDoubleClick?: () => void;
  suppressPointer?: boolean;
}

interface TextEditInputProps {
  initial: string;
  onCommit: (value: string) => void;
  onClose: () => void;
  style: React.CSSProperties;
}

/** Inline text editor that commits on Enter / blur, cancels (no commit) on Escape.
 *  Keeps a local value buffer so per-keystroke UPDATE_TEXT_CLIP dispatches don't
 *  thrash the reducer, and so Escape can truly revert. */
function TextEditInput({ initial, onCommit, onClose, style }: TextEditInputProps) {
  const [value, setValue] = useState(initial);
  const cancelledRef = useRef(false);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (!cancelledRef.current && value !== initial) onCommit(value);
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (value !== initial) onCommit(value);
          onClose();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelledRef.current = true;
          onClose();
        }
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="overlay-text-editor"
      style={style}
    />
  );
}

/** Approximate text bounding box in display px. Mirrors PreviewPanel.drawTextClip. */
function measureTextBox(clip: TextClip, transform: Transform, canvasH: number, displayH: number): { w: number; h: number } {
  const fontSizeCanvasPx = (clip.fontSize / 100) * canvasH * transform.scale;
  const ratio = canvasH > 0 ? displayH / canvasH : 1;
  const fontPxDisplay = Math.max(8, fontSizeCanvasPx * ratio);
  // Cheap width estimate: avg glyph ≈ 0.55 × font size.
  const text = clip.text || ' ';
  const charW = fontPxDisplay * 0.55;
  return {
    w: Math.max(charW * text.length, fontPxDisplay * 1.5),
    h: fontPxDisplay * 1.2,
  };
}

/** Video/image bounding box in display px when fit='free'. Mirrors PreviewPanel.drawVideoClip/drawImageClip. */
function measureMediaBox(
  clip: VideoClip | ImageClip,
  transform: Transform,
  mediaFiles: Record<string, MediaFile>,
  canvasW: number,
  canvasH: number,
  displayW: number,
  displayH: number
): { w: number; h: number } {
  const m = mediaFiles[clip.mediaFileId];
  if (!m || m.width <= 0 || m.height <= 0) {
    // Fallback: half the canvas, square.
    return { w: displayW * 0.5, h: displayH * 0.5 };
  }
  const baseK = Math.min(canvasW / m.width, canvasH / m.height);
  const k = baseK * transform.scale;
  const dwCanvas = m.width * k;
  const dhCanvas = m.height * k;
  const ratioX = canvasW > 0 ? displayW / canvasW : 1;
  const ratioY = canvasH > 0 ? displayH / canvasH : 1;
  return { w: dwCanvas * ratioX, h: dhCanvas * ratioY };
}

function ClipHandle({
  transform,
  displayW,
  displayH,
  boxW,
  boxH,
  isSelected,
  zIndex,
  onPointerDown,
  onDoubleClick,
  suppressPointer,
}: HandleProps) {
  const cx = transform.x * displayW;
  const cy = transform.y * displayH;
  const padding = 6;
  const w = boxW + padding * 2;
  const h = boxH + padding * 2;

  return (
    <div
      className={`overlay-clip-handle ${isSelected ? 'selected' : ''}`}
      style={{
        left: cx - w / 2,
        top: cy - h / 2,
        width: w,
        height: h,
        // Stack handles by clip z-index so the topmost layer's handle catches
        // pointer events when handles overlap. Selected clip wins ties.
        zIndex: zIndex + (isSelected ? 1000 : 0),
        transform: `rotate(${transform.rotation}deg)`,
        pointerEvents: suppressPointer ? 'none' : undefined,
      }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onDoubleClick={onDoubleClick}
    >
      {isSelected && (
        <>
          <div
            className="overlay-handle-corner tl"
            onPointerDown={(e) => onPointerDown(e, 'scale-corner')}
          />
          <div
            className="overlay-handle-corner tr"
            onPointerDown={(e) => onPointerDown(e, 'scale-corner')}
          />
          <div
            className="overlay-handle-corner bl"
            onPointerDown={(e) => onPointerDown(e, 'scale-corner')}
          />
          <div
            className="overlay-handle-corner br"
            onPointerDown={(e) => onPointerDown(e, 'scale-corner')}
          />
          <div
            className="overlay-handle-rotate"
            onPointerDown={(e) => onPointerDown(e, 'rotate')}
          />
        </>
      )}
    </div>
  );
}

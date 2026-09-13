import { useLayoutEffect, useRef, useEffect, useCallback, useState } from 'react';
import { useProject } from '../../state/ProjectContext';
import type { Clip, ProjectState, TextClip, VideoClip } from '../../types/project';
import { clipDuration } from '../../types/project';
import {
  computeClipAlpha,
  drawImageClip,
  drawTextClip,
  drawVideoClip,
  findActiveClipsAtTime,
} from '../../services/canvasCompositor';
import { applyTransition } from '../../services/transitionEffects';
import { CanvasOverlay, type PendingTransform } from './CanvasOverlay';
import { PauseIcon, PlayIcon, SkipEndIcon, SkipStartIcon } from '../icons';
import { clampMenuPosition } from '../ui/contextMenu';

const ACTIVE_WINDOW_SECONDS = 3;
const ADJACENCY_EPS = 0.005;

interface TransitionPair {
  prev: VideoClip;
  next: VideoClip;
  D: number;
  windowStart: number;
  windowEnd: number;
}

/** Render a singleton orphan with its chosen transition kind.
 *   - side='tail': clip → black (uses transitionOut.kind).
 *   - side='head': black → clip (uses transitionIn.kind).
 *  Both directions exercise the same `applyTransition` functions — the
 *  "head" case just swaps prev/next so the kind reveals INTO the clip
 *  instead of OUT to black. */
function renderPreviewSingletonOrphan(
  destCtx: CanvasRenderingContext2D,
  orphan: SingletonOrphan,
  t: number,
  W: number,
  H: number,
  videoRefs: Map<string, HTMLVideoElement>,
  imageRefs: Map<string, HTMLImageElement>,
  editingTextId: string | null,
): void {
  const scratchClip = new OffscreenCanvas(W, H);
  const sctxClip = scratchClip.getContext('2d');
  if (!sctxClip) return;

  const clip = orphan.clip;
  sctxClip.clearRect(0, 0, W, H);
  sctxClip.globalAlpha = 1;
  if (clip.kind === 'video') {
    const v = videoRefs.get(clip.id);
    if (v && v.readyState >= 2 && v.src) drawVideoClip(sctxClip, v, clip, W, H);
  } else if (clip.kind === 'image') {
    const img = imageRefs.get(clip.mediaFileId);
    if (img && img.complete) drawImageClip(sctxClip, img, clip, W, H);
  } else {
    if (editingTextId === clip.id) return;
    drawTextClip(sctxClip, clip as TextClip, W, H);
  }

  // The "other side" of the orphan transition is the underlying scene
  // (whatever was already painted this frame — black background + any
  // other-track clips at lower z-indexes). Snapshotting dest instead of
  // passing an opaque-black buffer means fade/wipe/slide/etc. blend the
  // clip in/out OF the scene, keeping other tracks visible. fadeBlack and
  // fadeWhite still flash to black/white per their own design.
  const scratchScene = new OffscreenCanvas(W, H);
  const sctxScene = scratchScene.getContext('2d');
  if (!sctxScene) return;
  sctxScene.drawImage(destCtx.canvas, 0, 0);

  destCtx.globalAlpha = 1;
  const progress = (t - orphan.windowStart) / orphan.D;
  if (orphan.side === 'tail') {
    const kind = clip.transitionOut?.kind ?? 'fade';
    applyTransition(kind, destCtx, scratchClip, scratchScene, progress, W, H);
  } else {
    const kind = clip.transitionIn?.kind ?? 'fade';
    applyTransition(kind, destCtx, scratchScene, scratchClip, progress, W, H);
  }
  destCtx.globalAlpha = 1;
}

/** Render a transition pair onto the destination context at time t.
 *  Mirrors `renderTransitionLayer` in the export worker: render prev and
 *  next clips into scratch canvases at full canvas size, then call the
 *  shared `applyTransition` helper. Best-effort source frames — uses each
 *  clip's video element in its current state. If a video isn't loaded yet
 *  (e.g. next clip in the first half of the window, before any frame is
 *  decoded), its scratch stays transparent and the transition still draws
 *  something reasonable. */
function renderPreviewTransition(
  destCtx: CanvasRenderingContext2D,
  pair: TransitionPair,
  t: number,
  W: number,
  H: number,
  videoRefs: Map<string, HTMLVideoElement>,
): void {
  const scratchPrev = new OffscreenCanvas(W, H);
  const scratchNext = new OffscreenCanvas(W, H);
  const sctxPrev = scratchPrev.getContext('2d');
  const sctxNext = scratchNext.getContext('2d');
  if (!sctxPrev || !sctxNext) return;

  // Composite scene + each clip into the scratch buffers so the transition
  // blends scene+clipPrev ↔ scene+clipNext, keeping other-track clips
  // visible throughout the window. Without this baseline the pair's opaque
  // output wipes any track at a lower z-index.
  sctxPrev.globalAlpha = 1;
  sctxPrev.drawImage(destCtx.canvas, 0, 0);
  const prevVideo = videoRefs.get(pair.prev.id);
  if (prevVideo && prevVideo.readyState >= 2 && prevVideo.src) {
    drawVideoClip(sctxPrev, prevVideo, pair.prev, W, H);
  }

  sctxNext.globalAlpha = 1;
  sctxNext.drawImage(destCtx.canvas, 0, 0);
  const nextVideo = videoRefs.get(pair.next.id);
  if (nextVideo && nextVideo.readyState >= 2 && nextVideo.src) {
    drawVideoClip(sctxNext, nextVideo, pair.next, W, H);
  }

  destCtx.globalAlpha = 1;
  const progress = (t - pair.windowStart) / pair.D;
  const kind = pair.prev.transitionOut?.kind ?? 'fade';
  applyTransition(kind, destCtx, scratchPrev, scratchNext, progress, W, H);
  destCtx.globalAlpha = 1;
}

/** Same rules as `computeTransitionPairs` in the export worker — kept in
 *  sync so preview-to-export parity holds. Adjacent same-track, same-zIndex
 *  video pairs with `transitionOut` form a pair. (The free-fit exclusion
 *  the FFmpeg path had is gone — Canvas2D + the scratch-canvas approach
 *  handles alpha correctly.) */
function previewTransitionPairs(state: ProjectState): TransitionPair[] {
  const pairs: TransitionPair[] = [];
  for (const trackId of state.trackOrder) {
    const track = state.tracks[trackId];
    if (!track) continue;
    const sorted = track.clips
      .map((cid) => state.clips[cid])
      .filter((c): c is Clip => Boolean(c))
      .sort((a, b) => a.timelineStart - b.timelineStart);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (prev.kind !== 'video' || next.kind !== 'video') continue;
      if (!prev.transitionOut || prev.transitionOut.duration <= 0) continue;
      if (prev.zIndex !== next.zIndex) continue;
      const prevEnd = prev.timelineStart + clipDuration(prev);
      if (Math.abs(next.timelineStart - prevEnd) > ADJACENCY_EPS) continue;
      const D = Math.min(prev.transitionOut.duration, clipDuration(prev), clipDuration(next));
      const halfD = D / 2;
      pairs.push({
        prev,
        next,
        D,
        windowStart: prevEnd - halfD,
        windowEnd: prevEnd + halfD,
      });
    }
  }
  return pairs;
}

/** Singleton orphan: a clip with `transitionOut` or `transitionIn` that
 *  didn't form a pair. The 'tail' kind transitions to BLACK; the 'head'
 *  kind transitions FROM BLACK. */
interface SingletonOrphan {
  clip: Clip;
  D: number;
  windowStart: number;
  windowEnd: number;
  side: 'head' | 'tail';
}

function previewSingletonOrphans(
  state: ProjectState,
  pairs: TransitionPair[],
): SingletonOrphan[] {
  const prevInPair = new Set<string>();
  const nextInPair = new Set<string>();
  for (const p of pairs) {
    prevInPair.add(p.prev.id);
    nextInPair.add(p.next.id);
  }
  const orphans: SingletonOrphan[] = [];
  for (const clip of Object.values(state.clips)) {
    const dur = clipDuration(clip);
    if (clip.transitionOut && clip.transitionOut.duration > 0 && !prevInPair.has(clip.id)) {
      const D = Math.min(clip.transitionOut.duration, dur);
      const tlEnd = clip.timelineStart + dur;
      orphans.push({ clip, D, windowStart: tlEnd - D / 2, windowEnd: tlEnd, side: 'tail' });
    }
    if (clip.transitionIn && clip.transitionIn.duration > 0 && !nextInPair.has(clip.id)) {
      const D = Math.min(clip.transitionIn.duration, dur);
      orphans.push({
        clip,
        D,
        windowStart: clip.timelineStart,
        windowEnd: clip.timelineStart + D / 2,
        side: 'head',
      });
    }
  }
  return orphans;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getTimelineDuration(clips: Record<string, Clip>): number {
  let max = 0;
  for (const clip of Object.values(clips)) {
    const end = clip.timelineStart + clipDuration(clip);
    if (end > max) max = end;
  }
  return max;
}

export function PreviewPanel() {
  const { state, dispatch } = useProject();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Image refs are keyed by mediaFileId because the same image media can back
  // multiple clips. Decoding once and reusing across clips saves memory.
  const imageRefs = useRef<Map<string, HTMLImageElement>>(new Map());
  const primedClipsRef = useRef<Set<string>>(new Set());
  const playingClipsRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [videoLoadTick, setVideoLoadTick] = useState(0);

  // Live transform during drag — bypasses dispatch so a pointermove storm
  // doesn't fill the 50-slot history. Committed once on pointerup.
  const [pendingTransform, setPendingTransform] = useState<PendingTransform | null>(null);
  const pendingTransformRef = useRef<PendingTransform | null>(null);
  pendingTransformRef.current = pendingTransform;

  // When the user double-clicks a text clip we hide its canvas-rendered text
  // and let CanvasOverlay show an inline input instead. Cleared on blur/Enter.
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const editingTextIdRef = useRef<string | null>(null);
  editingTextIdRef.current = editingTextId;

  // Wrapper size = the largest box that fits the available preview area while
  // preserving the project's canvas aspect ratio. JS-driven because CSS can't
  // do "aspect-ratio capped by both max-width and max-height" cleanly across
  // arbitrary aspects.
  const containerRef = useRef<HTMLDivElement>(null);
  const [wrapperSize, setWrapperSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const W = Math.max(0, el.clientWidth - padX);
      const H = Math.max(0, el.clientHeight - padY);
      if (W <= 0 || H <= 0) return;
      const aspect = state.canvas.width / Math.max(1, state.canvas.height);
      let w = W;
      let h = W / aspect;
      if (h > H) {
        h = H;
        w = H * aspect;
      }
      setWrapperSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.canvas.width, state.canvas.height]);

  const hasClips = Object.keys(state.clips).length > 0;
  const totalDuration = getTimelineDuration(state.clips);

  useEffect(() => {
    const current = videoRefs.current;
    const aliveVideoIds = new Set<string>();
    for (const [cid, c] of Object.entries(state.clips)) {
      if (c.kind === 'video') aliveVideoIds.add(cid);
    }
    for (const clipId of Array.from(current.keys())) {
      if (!aliveVideoIds.has(clipId)) {
        const v = current.get(clipId);
        if (v) {
          v.pause();
          v.removeAttribute('src');
          v.load();
        }
        current.delete(clipId);
        primedClipsRef.current.delete(clipId);
      }
    }
    for (const clipId of aliveVideoIds) {
      if (!current.has(clipId)) {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.playsInline = true;
        v.addEventListener('loadeddata', () => setVideoLoadTick((n) => n + 1));
        current.set(clipId, v);
      }
    }
  }, [state.clips]);

  // Image pool — one HTMLImageElement per image media. Cleared when no clip
  // references the media anymore.
  useEffect(() => {
    const current = imageRefs.current;
    const aliveMediaIds = new Set<string>();
    for (const c of Object.values(state.clips)) {
      if (c.kind === 'image') aliveMediaIds.add(c.mediaFileId);
    }
    for (const mediaId of Array.from(current.keys())) {
      if (!aliveMediaIds.has(mediaId)) current.delete(mediaId);
    }
    for (const mediaId of aliveMediaIds) {
      if (current.has(mediaId)) continue;
      const media = state.mediaFiles[mediaId];
      if (!media?.objectUrl) continue;
      const img = new Image();
      img.onload = () => setVideoLoadTick((n) => n + 1);
      img.src = media.objectUrl;
      current.set(mediaId, img);
    }
  }, [state.clips, state.mediaFiles]);

  useEffect(() => {
    for (const [clipId, v] of videoRefs.current) {
      const clip = state.clips[clipId];
      if (!clip || clip.kind !== 'video') continue;
      const media = state.mediaFiles[clip.mediaFileId];
      if (!media?.objectUrl) {
        if (v.src) {
          v.removeAttribute('src');
          v.load();
        }
        continue;
      }
      const clipStart = clip.timelineStart;
      const clipEnd = clipStart + clipDuration(clip);
      const inWindow =
        clipEnd >= state.playheadPosition - ACTIVE_WINDOW_SECONDS &&
        clipStart <= state.playheadPosition + ACTIVE_WINDOW_SECONDS;
      if (inWindow) {
        if (v.src !== media.objectUrl) {
          v.src = media.objectUrl;
          primedClipsRef.current.delete(clipId);
        }
      } else if (v.src) {
        v.removeAttribute('src');
        v.load();
        primedClipsRef.current.delete(clipId);
      }
    }
  }, [state.clips, state.mediaFiles, state.playheadPosition]);

  const drawBlack = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  // Still-frame (paused): seek each active VIDEO clip, then composite bottom→top with alpha + text.
  useEffect(() => {
    if (!hasClips || state.isPlaying) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const active = findActiveClipsAtTime(state, state.playheadPosition);
    if (active.length === 0) {
      drawBlack();
      return;
    }

    let cancelled = false;
    const pending: Array<{ v: HTMLVideoElement; handler: () => void; type: 'seeked' | 'loadedmetadata' }> = [];

    // Transition pairs + singleton orphans that overlap the current playhead.
    const pairs = previewTransitionPairs(state);
    const activePairs = pairs.filter(
      (p) => state.playheadPosition >= p.windowStart && state.playheadPosition < p.windowEnd,
    );
    const allOrphans = previewSingletonOrphans(state, pairs);
    const activeOrphans = allOrphans.filter(
      (o) => state.playheadPosition >= o.windowStart && state.playheadPosition < o.windowEnd,
    );
    const pairMemberIds = new Set<string>();
    for (const p of activePairs) {
      pairMemberIds.add(p.prev.id);
      pairMemberIds.add(p.next.id);
    }
    const orphanMemberIds = new Set<string>();
    for (const o of activeOrphans) {
      orphanMemberIds.add(o.clip.id);
    }

    // The set of video clips that need to be seeked: every active video
    // clip, plus pair members that aren't naturally active at this playhead.
    const clipsToSeek = new Map<string, VideoClip>();
    for (const c of active) {
      if (c.kind === 'video') clipsToSeek.set(c.id, c);
    }
    for (const p of activePairs) {
      if (!clipsToSeek.has(p.prev.id)) clipsToSeek.set(p.prev.id, p.prev);
      if (!clipsToSeek.has(p.next.id)) clipsToSeek.set(p.next.id, p.next);
    }

    const render = async () => {
      for (const clip of clipsToSeek.values()) {
        const v = videoRefs.current.get(clip.id);
        if (!v || !v.src) continue;
        const speed = Math.max(0.25, Math.min(4, clip.speed));
        // Clamp the source time to the clip's [sourceStart, sourceEnd] window —
        // for pair members rendered outside their natural active range we
        // freeze at the boundary frame rather than skipping past.
        const natural = clip.sourceStart + (state.playheadPosition - clip.timelineStart) * speed;
        const src = Math.max(clip.sourceStart, Math.min(clip.sourceEnd - 0.001, natural));
        if (v.readyState < 1) {
          await new Promise<void>((resolve) => {
            const handler = () => resolve();
            v.addEventListener('loadedmetadata', handler, { once: true });
            pending.push({ v, handler, type: 'loadedmetadata' });
          });
          if (cancelled) return;
        }
        const primed = primedClipsRef.current.has(clip.id);
        const needsSeek = !primed || Math.abs(v.currentTime - src) > 0.05;
        if (needsSeek) {
          await new Promise<void>((resolve) => {
            const handler = () => resolve();
            v.addEventListener('seeked', handler, { once: true });
            pending.push({ v, handler, type: 'seeked' });
            if (!primed && Math.abs(v.currentTime - src) < 0.001) {
              v.currentTime = Math.max(0, src + 0.001);
            } else {
              v.currentTime = src;
            }
          });
          if (cancelled) return;
          primedClipsRef.current.add(clip.id);
        }
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const pt = pendingTransformRef.current;
      for (const clip of active) {
        if (pairMemberIds.has(clip.id)) continue; // pair handles drawing
        if (orphanMemberIds.has(clip.id)) continue; // orphan handles drawing
        const alpha = computeClipAlpha(state, clip, state.playheadPosition);
        if (alpha <= 0.001) continue;
        ctx.globalAlpha = alpha;
        const override = pt && pt.clipId === clip.id ? pt.transform : undefined;
        if (clip.kind === 'video') {
          const v = videoRefs.current.get(clip.id);
          if (v && v.readyState >= 2) drawVideoClip(ctx, v, clip, canvas.width, canvas.height, override);
        } else if (clip.kind === 'image') {
          const img = imageRefs.current.get(clip.mediaFileId);
          if (img) drawImageClip(ctx, img, clip, canvas.width, canvas.height, override);
        } else {
          if (editingTextIdRef.current === clip.id) continue;
          drawTextClip(ctx, clip as TextClip, canvas.width, canvas.height, override);
        }
      }

      // Render transition pairs + singleton orphans on top — their member
      // clips were skipped above so their pixels come from applyTransition.
      for (const pair of activePairs) {
        renderPreviewTransition(ctx, pair, state.playheadPosition, canvas.width, canvas.height, videoRefs.current);
      }
      for (const orphan of activeOrphans) {
        renderPreviewSingletonOrphan(
          ctx, orphan, state.playheadPosition, canvas.width, canvas.height,
          videoRefs.current, imageRefs.current, editingTextIdRef.current,
        );
      }

      ctx.globalAlpha = 1;
    };

    render();

    return () => {
      cancelled = true;
      for (const { v, handler, type } of pending) {
        v.removeEventListener(type, handler);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasClips, state.isPlaying, state.playheadPosition, state.clips, state.mediaFiles, videoLoadTick, pendingTransform]);

  // Playback loop: let each active clip's <video> play; canvas paints per frame.
  useEffect(() => {
    if (!hasClips || !state.isPlaying) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    lastTimeRef.current = 0;

    const render = (timestamp: number) => {
      const delta = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 0;
      lastTimeRef.current = timestamp;
      const snapshot = stateRef.current;
      const t = snapshot.playheadPosition + delta;
      if (t >= totalDuration) {
        dispatch({ type: 'SET_PLAYING', payload: false });
        dispatch({ type: 'SET_PLAYHEAD', payload: totalDuration });
        return;
      }
      dispatch({ type: 'SET_PLAYHEAD', payload: t });

      const active = findActiveClipsAtTime(snapshot, t);
      const activeIds = new Set(active.map((c) => c.id));

      for (const clipId of Array.from(playingClipsRef.current)) {
        if (!activeIds.has(clipId)) {
          const v = videoRefs.current.get(clipId);
          if (v) {
            if (!v.paused) v.pause();
            v.muted = true;
          }
          playingClipsRef.current.delete(clipId);
        }
      }

      // Defer the clear+redraw if ANY active clip can't yet contribute
      // pixels (mid-seek, mid-decode, image still loading). The canvas
      // retains its previous frame's pixels — much better than flashing
      // black in the unready clip's region. True empty intervals (no
      // active clips at all) paint black intentionally.
      let allDrawable = active.length === 0;
      if (!allDrawable) {
        allDrawable = true;
        for (const clip of active) {
          if (clip.kind === 'video') {
            const v = videoRefs.current.get(clip.id);
            if (!v || v.readyState < 2 || v.seeking) { allDrawable = false; break; }
          } else if (clip.kind === 'image') {
            const img = imageRefs.current.get(clip.mediaFileId);
            if (!img || !img.complete || !img.naturalWidth) { allDrawable = false; break; }
          }
          // text is always drawable.
        }
      }
      if (!allDrawable) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Detect transition pairs + singleton orphans at t. Their member clips
      // are rendered via applyTransition (matching the export). All other
      // active clips render normally. This is what makes "wipe", "slide",
      // etc. look visually different in preview rather than every effect
      // collapsing into a basic alpha fade.
      const pairs = previewTransitionPairs(snapshot);
      const activePairs = pairs.filter((p) => t >= p.windowStart && t < p.windowEnd);
      const orphans = previewSingletonOrphans(snapshot, pairs);
      const activeOrphans = orphans.filter((o) => t >= o.windowStart && t < o.windowEnd);
      const pairMembers = new Set<string>();
      for (const p of activePairs) {
        pairMembers.add(p.prev.id);
        pairMembers.add(p.next.id);
      }
      const orphanMembers = new Set<string>();
      for (const o of activeOrphans) {
        orphanMembers.add(o.clip.id);
      }

      const pt = pendingTransformRef.current;
      for (const clip of active) {
        if (pairMembers.has(clip.id)) continue; // rendered by the pair below
        if (orphanMembers.has(clip.id)) continue; // rendered by orphan below

        const alpha = computeClipAlpha(snapshot, clip, t);
        if (alpha <= 0.001) continue;

        if (clip.kind === 'video') {
          const v = videoRefs.current.get(clip.id);
          if (!v || !v.src) continue;
          const videoClip = clip as VideoClip;
          const speed = Math.max(0.25, Math.min(4, videoClip.speed));
          // Source-time advances at `speed` × timeline rate.
          const expectedSrc = videoClip.sourceStart + (t - videoClip.timelineStart) * speed;

          if (!playingClipsRef.current.has(clip.id)) {
            if (v.readyState >= 1) v.currentTime = expectedSrc;
            v.muted = videoClip.muted;
            v.volume = videoClip.volume * alpha;
            v.playbackRate = speed;
            v.play().catch(() => {
              v.muted = true;
              v.play().catch(() => {});
            });
            playingClipsRef.current.add(clip.id);
          } else {
            // Drift correction. Skip if v is already seeking — issuing a
            // new seek on top of an in-flight one drops readyState to 0
            // and produces another visible stall.
            if (!v.seeking && Math.abs(v.currentTime - expectedSrc) > 0.5) {
              v.currentTime = expectedSrc;
            }
            v.muted = videoClip.muted;
            v.volume = Math.max(0, Math.min(1, videoClip.volume * alpha));
            if (Math.abs(v.playbackRate - speed) > 0.01) v.playbackRate = speed;
          }

          if (v.readyState >= 2) {
            ctx.globalAlpha = alpha;
            const override = pt && pt.clipId === clip.id ? pt.transform : undefined;
            drawVideoClip(ctx, v, videoClip, canvas.width, canvas.height, override);
          }
        } else if (clip.kind === 'image') {
          const img = imageRefs.current.get(clip.mediaFileId);
          if (img) {
            ctx.globalAlpha = alpha;
            const override = pt && pt.clipId === clip.id ? pt.transform : undefined;
            drawImageClip(ctx, img, clip, canvas.width, canvas.height, override);
          }
        } else {
          if (editingTextIdRef.current === clip.id) continue;
          ctx.globalAlpha = alpha;
          const override = pt && pt.clipId === clip.id ? pt.transform : undefined;
          drawTextClip(ctx, clip as TextClip, canvas.width, canvas.height, override);
        }
      }

      // Render transition pairs and singleton orphans on top of everything.
      for (const pair of activePairs) {
        renderPreviewTransition(ctx, pair, t, canvas.width, canvas.height, videoRefs.current);
      }
      for (const orphan of activeOrphans) {
        renderPreviewSingletonOrphan(
          ctx, orphan, t, canvas.width, canvas.height,
          videoRefs.current, imageRefs.current, editingTextIdRef.current,
        );
      }

      ctx.globalAlpha = 1;

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = 0;
      for (const clipId of playingClipsRef.current) {
        const v = videoRefs.current.get(clipId);
        if (v) {
          if (!v.paused) v.pause();
          v.muted = true;
        }
      }
      playingClipsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasClips, state.isPlaying, totalDuration]);

  const togglePlay = () => {
    if (!hasClips) return;
    if (state.playheadPosition >= totalDuration) {
      dispatch({ type: 'SET_PLAYHEAD', payload: 0 });
    }
    dispatch({ type: 'SET_PLAYING', payload: !state.isPlaying });
  };

  const skipToStart = () => {
    if (state.isPlaying) dispatch({ type: 'SET_PLAYING', payload: false });
    dispatch({ type: 'SET_PLAYHEAD', payload: 0 });
  };

  const skipToEnd = () => {
    if (state.isPlaying) dispatch({ type: 'SET_PLAYING', payload: false });
    dispatch({ type: 'SET_PLAYHEAD', payload: totalDuration });
  };

  const activeClips = hasClips ? findActiveClipsAtTime(state, state.playheadPosition) : [];

  const [canvasCtx, setCanvasCtx] = useState<{ x: number; y: number } | null>(null);
  const canvasCtxMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvasCtx) return;
    const onClick = () => setCanvasCtx(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [canvasCtx]);
  // After the menu mounts, measure it and re-clamp so it never overflows the
  // viewport. The previous hardcoded 220×130 dimensions didn't match the
  // actual rendered size (~190×175).
  useLayoutEffect(() => {
    if (!canvasCtx) return;
    const el = canvasCtxMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clamped = clampMenuPosition({
      requestedX: canvasCtx.x,
      requestedY: canvasCtx.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
    });
    if (clamped.x !== canvasCtx.x || clamped.y !== canvasCtx.y) {
      setCanvasCtx(clamped);
    }
  }, [canvasCtx]);

  return (
    <div className="preview-panel">
      <div className="preview-canvas-container" ref={containerRef}>
        {hasClips ? (
          <div
            className="preview-canvas-wrapper"
            style={{ width: wrapperSize.w || undefined, height: wrapperSize.h || undefined }}
            onContextMenu={(e) => {
              e.preventDefault();
              // Initial position uses the cursor coordinates; the layout
              // effect above re-measures and clamps once the menu is in DOM.
              setCanvasCtx({ x: e.clientX, y: e.clientY });
            }}
          >
            <canvas
              ref={canvasRef}
              className="preview-canvas"
              width={state.canvas.width}
              height={state.canvas.height}
            />
            <CanvasOverlay
              canvasRef={canvasRef}
              canvasW={state.canvas.width}
              canvasH={state.canvas.height}
              activeClips={activeClips}
              selectedClipIds={state.selectedClipIds}
              isPlaying={state.isPlaying}
              dispatch={dispatch}
              mediaFiles={state.mediaFiles}
              pendingTransform={pendingTransform}
              setPendingTransform={setPendingTransform}
              editingTextId={editingTextId}
              setEditingTextId={setEditingTextId}
            />
          </div>
        ) : (
          <div className="preview-placeholder">
            <div className="preview-placeholder-icon">▶</div>
            <div className="preview-placeholder-text">
              Drop a video in the sidebar to begin
            </div>
          </div>
        )}
      </div>
      <div className="playback-controls">
        <span />
        <div className="playback-controls-group">
          <button
            className="control-btn"
            onClick={skipToStart}
            disabled={!hasClips}
            title="Skip to start"
            aria-label="Skip to start"
          >
            <SkipStartIcon className="icon-md" />
          </button>
          <button
            className="play-btn"
            onClick={togglePlay}
            disabled={!hasClips}
            title={state.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={state.isPlaying ? 'Pause' : 'Play'}
          >
            {state.isPlaying ? <PauseIcon className="icon-lg" /> : <PlayIcon className="icon-lg" />}
          </button>
          <button
            className="control-btn"
            onClick={skipToEnd}
            disabled={!hasClips}
            title="Skip to end"
            aria-label="Skip to end"
          >
            <SkipEndIcon className="icon-md" />
          </button>
        </div>
        <span className="time-display">
          {formatTime(state.playheadPosition)} / {formatTime(totalDuration)}
        </span>
      </div>

      {canvasCtx && (
        <div
          ref={canvasCtxMenuRef}
          className="context-menu"
          style={{ left: canvasCtx.x, top: canvasCtx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              if (state.selectedClipIds.length === 1) {
                dispatch({
                  type: 'SET_CLIP_TRANSFORM',
                  payload: {
                    clipId: state.selectedClipIds[0],
                    transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
                  },
                });
              }
              setCanvasCtx(null);
            }}
            disabled={state.selectedClipIds.length !== 1}
          >
            <span>↺ Reset selected transform</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              for (const c of Object.values(state.clips)) {
                dispatch({
                  type: 'SET_CLIP_TRANSFORM',
                  payload: {
                    clipId: c.id,
                    transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
                  },
                });
              }
              setCanvasCtx(null);
            }}
          >
            <span>↺ Reset ALL transforms</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              dispatch({ type: 'SET_PLAYING', payload: !state.isPlaying });
              setCanvasCtx(null);
            }}
          >
            {state.isPlaying ? <PauseIcon className="icon-sm" /> : <PlayIcon className="icon-sm" />}
            <span>{state.isPlaying ? 'Pause' : 'Play'}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 'var(--text-xs)' }}>Space</span>
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              dispatch({ type: 'SET_PLAYHEAD', payload: 0 });
              setCanvasCtx(null);
            }}
          >
            <span>⏮ Jump to start</span>
          </button>
        </div>
      )}
    </div>
  );
}

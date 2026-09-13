import { useState, useCallback, useRef, useMemo } from 'react';
import { useProject } from '../state/ProjectContext';
import { checkExportSupport } from '../services/browserSupport';
import {
  runWebCodecsExport,
  type ExportRequest,
  type QualityPreset,
  type SerializedMediaFile,
} from '../services/webcodecsExporter';
import { renderAudioToPcm, type PcmPayload } from '../services/audioGraphBuilder';
import type { Clip, ProjectState, VideoClip } from '../types/project';
import { clipDuration } from '../types/project';

export type { QualityPreset };

export type ExportPhase = 'idle' | 'waiting' | 'loading-core' | 'exporting' | 'done' | 'error';

interface ExportState {
  phase: ExportPhase;
  progress: number;
  error: string | null;
  downloadUrl: string | null;
}

const initial: ExportState = {
  phase: 'idle',
  progress: 0,
  error: null,
  downloadUrl: null,
};

const EXPORT_FPS = 30;

export function useExport() {
  const { state } = useProject();
  const [exportState, setExportState] = useState<ExportState>(initial);
  const previousUrlRef = useRef<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const referencedMediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const clip of Object.values(state.clips)) {
      if (clip.kind === 'video' || clip.kind === 'image') ids.add(clip.mediaFileId);
    }
    return ids;
  }, [state.clips]);

  const readiness = useMemo(() => {
    let hydrating = 0;
    let missing = 0;
    let orphan = 0;
    for (const id of referencedMediaIds) {
      const m = state.mediaFiles[id];
      if (!m) {
        orphan++;
        continue;
      }
      if (m.status === 'hydrating') hydrating++;
      else if (m.status === 'missing') missing++;
      else if (!m.file) {
        missing++;
      }
    }
    const hasClips = Object.keys(state.clips).length > 0;
    return {
      hasClips,
      hydrating,
      missing: missing + orphan,
      allReady: hasClips && hydrating === 0 && missing === 0 && orphan === 0,
    };
  }, [referencedMediaIds, state.mediaFiles, state.clips]);

  const revokeDownloadUrl = useCallback(() => {
    if (previousUrlRef.current) {
      URL.revokeObjectURL(previousUrlRef.current);
      previousUrlRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    // If an export is in flight, signal abort. The worker honors it on the
    // next frame boundary and the promise rejects with "Export aborted".
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    revokeDownloadUrl();
    setExportState(initial);
  }, [revokeDownloadUrl]);

  const startExportFlow = useCallback(
    async (quality: QualityPreset = 'fast') => {
      if (!readiness.hasClips) {
        setExportState({ phase: 'error', progress: 0, error: 'No clips to export', downloadUrl: null });
        return;
      }
      if (readiness.missing > 0) {
        setExportState({
          phase: 'error',
          progress: 0,
          error: `${readiness.missing} media file${readiness.missing > 1 ? 's are' : ' is'} missing — re-import before exporting.`,
          downloadUrl: null,
        });
        return;
      }
      if (readiness.hydrating > 0) {
        setExportState({ phase: 'waiting', progress: 0, error: null, downloadUrl: null });
        return;
      }

      revokeDownloadUrl();

      try {
        // Confirm WebCodecs supports the project canvas + codec.
        const support = await checkExportSupport({
          width: state.canvas.width,
          height: state.canvas.height,
        });
        if (!support.supported || !support.videoCodec) {
          setExportState({
            phase: 'error',
            progress: 0,
            error: support.reason ?? 'Browser does not support WebCodecs export.',
            downloadUrl: null,
          });
          return;
        }

        // Serialize the involved media for the worker. We pass the File handle
        // by reference — Files survive structured clone across postMessage.
        const mediaFiles: Record<string, SerializedMediaFile> = {};
        for (const id of referencedMediaIds) {
          const m = state.mediaFiles[id];
          if (!m?.file) continue;
          mediaFiles[id] = {
            id: m.id,
            width: m.width,
            height: m.height,
            duration: m.duration,
            kind: m.kind,
            hasAudio: m.hasAudio,
            file: m.file,
          };
        }

        // Strip out any clip whose media is missing.
        const usableClips: Record<string, Clip> = {};
        for (const [id, clip] of Object.entries(state.clips)) {
          if ((clip.kind === 'video' || clip.kind === 'image') && !mediaFiles[clip.mediaFileId]) continue;
          usableClips[id] = clip;
        }
        if (Object.keys(usableClips).length === 0) {
          setExportState({ phase: 'error', progress: 0, error: 'No exportable clips.', downloadUrl: null });
          return;
        }

        // Trim each track to only the usable clips.
        const tracks: typeof state.tracks = {};
        for (const [trackId, track] of Object.entries(state.tracks)) {
          tracks[trackId] = {
            ...track,
            clips: track.clips.filter((cid) => usableClips[cid]),
          };
        }

        // Render audio on the main thread — Web Audio (OfflineAudioContext,
        // decodeAudioData) is unavailable in Workers on Firefox and older
        // Chromium. The PCM result then crosses the postMessage boundary as
        // transferables, costing zero copies.
        let audioPcm: PcmPayload | null = null;
        if (support.audioCodec && support.audioEncoderCodec) {
          const audioClips: VideoClip[] = [];
          for (const clip of Object.values(usableClips)) {
            if (clip.kind === 'video' && !clip.muted && clip.volume > 0) {
              const m = mediaFiles[clip.mediaFileId];
              if (m?.hasAudio) audioClips.push(clip);
            }
          }
          if (audioClips.length > 0) {
            const totalDuration = computeTimelineDuration(usableClips);
            try {
              audioPcm = await renderAudioToPcm({
                clips: audioClips.map((c) => ({
                  clip: c,
                  file: mediaFiles[c.mediaFileId].file,
                  hasAudio: mediaFiles[c.mediaFileId].hasAudio,
                })),
                duration: totalDuration,
                sampleRate: 48000,
                prevClipOnTrack: makePrevClipOnTrackLookup(state),
              });
            } catch (e) {
              console.warn('Audio render failed, exporting silent video:', e);
            }
          }
        }

        const req: ExportRequest = {
          type: 'export',
          clips: usableClips,
          tracks,
          trackOrder: state.trackOrder,
          mediaFiles,
          canvas: { width: state.canvas.width, height: state.canvas.height },
          quality,
          videoCodec: support.videoCodec,
          audioCodec: audioPcm ? support.audioCodec : null,
          audioEncoderCodec: audioPcm ? support.audioEncoderCodec : null,
          audioPcm,
          fps: EXPORT_FPS,
        };

        setExportState({ phase: 'exporting', progress: 0, error: null, downloadUrl: null });

        const handle = runWebCodecsExport(req, {
          onProgress: (fraction) => {
            setExportState((s) => ({ ...s, progress: fraction * 100 }));
          },
        });
        abortRef.current = handle.abort;
        const blob = await handle.promise;
        abortRef.current = null;

        const url = URL.createObjectURL(blob);
        previousUrlRef.current = url;
        setExportState({ phase: 'done', progress: 100, error: null, downloadUrl: url });
      } catch (err) {
        setExportState({
          phase: 'error',
          progress: 0,
          error: err instanceof Error ? err.message : 'Unknown error',
          downloadUrl: null,
        });
      }
    },
    [readiness, referencedMediaIds, state, revokeDownloadUrl],
  );

  return { exportState, startExportFlow, reset, readiness };
}

function computeTimelineDuration(clips: Record<string, Clip>): number {
  let max = 0;
  for (const clip of Object.values(clips)) {
    const end = clip.timelineStart + clipDuration(clip);
    if (end > max) max = end;
  }
  return max;
}

/** For audioGraphBuilder.renderAudioToPcm — given a clipId, find the
 *  immediately previous clip on the same track. Used to apply a fade-in
 *  mirroring the previous clip's transitionOut. */
function makePrevClipOnTrackLookup(state: ProjectState): (clipId: string) => VideoClip | null {
  return (clipId) => {
    const clip = state.clips[clipId];
    if (!clip) return null;
    const track = state.tracks[clip.trackId];
    if (!track) return null;
    const sorted = track.clips
      .map((cid) => state.clips[cid])
      .filter((c): c is Clip => Boolean(c))
      .sort((a, b) => a.timelineStart - b.timelineStart);
    const idx = sorted.findIndex((c) => c.id === clip.id);
    const prev = idx > 0 ? sorted[idx - 1] : null;
    return prev && prev.kind === 'video' ? prev : null;
  };
}

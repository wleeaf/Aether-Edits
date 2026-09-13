import { useRef, useState, useCallback, useEffect } from 'react';
import { useProject } from '../../state/ProjectContext';
import type { ImageClip, MediaFile, TextClip, VideoClip } from '../../types/project';
import { DEFAULT_TRANSFORM } from '../../types/project';
import { newId } from '../../utils/id';
import { getOrCreateObjectUrl, saveFile } from '../../services/mediaStore';
import { isMp4, transcodeToMp4 } from '../../services/videoTranscoder';
import { Inspector } from '../Inspector/Inspector';
import { EffectsPanel } from './EffectsPanel';
import {
  ClapperIcon,
  DeleteIcon,
  ImageIcon,
  SettingsIcon,
  SparkleIcon,
  SplitIcon,
  TextIcon,
  VideoIcon,
} from '../icons';

const DEFAULT_TEXT_DURATION = 3;

type SidebarTab = 'media' | 'fx' | 'inspect';

export function Sidebar() {
  const { state, dispatch } = useProject();
  const [tab, setTab] = useState<SidebarTab>('media');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const [transcodingFiles, setTranscodingFiles] = useState<Record<string, { name: string; progress: number }>>({});
  const [fileCtxMenu, setFileCtxMenu] = useState<{ x: number; y: number; mediaId: string } | null>(null);

  useEffect(() => {
    if (!fileCtxMenu) return;
    const onClick = () => setFileCtxMenu(null);
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [fileCtxMenu]);

  const addMediaToTimeline = useCallback((media: MediaFile) => {
    const trackId = state.trackOrder[0];
    if (!trackId) return;
    const tlStart = state.playheadPosition;
    const clip: VideoClip | ImageClip =
      media.kind === 'image'
        ? {
            id: newId('clip'),
            kind: 'image',
            mediaFileId: media.id,
            sourceStart: 0,
            sourceEnd: media.duration,
            timelineStart: tlStart,
            trackId,
            zIndex: 0,
            fit: 'free',
            transform: { ...DEFAULT_TRANSFORM },
            color: null,
            speed: 1,
            transitionOut: null,
            transitionIn: null,
          }
        : {
            id: newId('clip'),
            kind: 'video',
            mediaFileId: media.id,
            sourceStart: 0,
            sourceEnd: media.duration,
            timelineStart: tlStart,
            trackId,
            zIndex: 0,
            volume: 1,
            muted: false,
            pan: 0,
            duckSourceClipId: null,
            duckAmount: 0.6,
            fit: 'contain',
            transform: { ...DEFAULT_TRANSFORM },
            color: null,
            speed: 1,
            transitionOut: null,
            transitionIn: null,
          };
    dispatch({ type: 'ADD_CLIP', payload: { clip, trackId } });
    dispatch({ type: 'SELECT_CLIP', payload: [clip.id] });
  }, [state.trackOrder, state.playheadPosition, dispatch]);

  const handleFiles = useCallback(
    (files: FileList) => {
      Array.from(files).forEach((file) => {
        const isVideo = file.type.startsWith('video/');
        const isImage = file.type.startsWith('image/');
        if (!isVideo && !isImage) return;
        const id = newId('media');

        setLoadingFiles((prev) => new Set(prev).add(id));

        const finishLoading = () => {
          setLoadingFiles((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        };

        const finalizeMeta = async (
          duration: number,
          width: number,
          height: number,
          kind: 'video' | 'image'
        ) => {
          // The export worker can only read MP4 sources. For anything else
          // (MOV/WebM/MKV/AVI/etc) we transcode to MP4 right now, while
          // HTMLVideoElement is still available on the main thread. The
          // transcoded blob becomes the canonical media file.
          let storedFile = file;
          if (kind === 'video' && !(await isMp4(file))) {
            setTranscodingFiles((prev) => ({ ...prev, [id]: { name: file.name, progress: 0 } }));
            try {
              const mp4Blob = await transcodeToMp4(file, {
                onProgress: (frac) => {
                  setTranscodingFiles((prev) =>
                    prev[id] ? { ...prev, [id]: { ...prev[id], progress: frac } } : prev,
                  );
                },
              });
              const baseName = file.name.replace(/\.[^.]+$/, '');
              storedFile = new File([mp4Blob], `${baseName}.mp4`, { type: 'video/mp4' });
            } catch (err) {
              console.warn('Transcode failed:', err);
              setTranscodingFiles((prev) => {
                const { [id]: _, ...rest } = prev;
                return rest;
              });
              finishLoading();
              return;
            }
            setTranscodingFiles((prev) => {
              const { [id]: _, ...rest } = prev;
              return rest;
            });
          }
          const objectUrl = getOrCreateObjectUrl(id, storedFile);
          const mediaFile: MediaFile = {
            id,
            name: storedFile.name,
            objectUrl,
            file: storedFile,
            duration,
            width,
            height,
            status: 'ready',
            hasAudio: kind === 'video',
            kind,
          };
          dispatch({ type: 'ADD_MEDIA_FILE', payload: mediaFile });
          try {
            await saveFile(id, storedFile);
          } catch (err) {
            console.warn('IDB saveFile failed:', err);
            dispatch({ type: 'SET_MEDIA_STATUS', payload: { id, status: 'missing' } });
          }
          finishLoading();
        };

        if (isImage) {
          const probeUrl = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            void finalizeMeta(4, img.naturalWidth, img.naturalHeight, 'image');
            URL.revokeObjectURL(probeUrl);
          };
          img.onerror = () => {
            URL.revokeObjectURL(probeUrl);
            finishLoading();
          };
          img.src = probeUrl;
          return;
        }

        const probeUrl = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.preload = 'metadata';

        const finalizeVideo = (duration: number) => {
          void finalizeMeta(duration, video.videoWidth, video.videoHeight, 'video');
          URL.revokeObjectURL(probeUrl);
        };

        video.onloadedmetadata = () => {
          const reported = video.duration;
          const looksBad = !Number.isFinite(reported) || reported <= 0;
          if (!looksBad) {
            finalizeVideo(reported);
            return;
          }

          const onTimeUpdate = () => {
            video.removeEventListener('timeupdate', onTimeUpdate);
            const real = video.duration;
            video.currentTime = 0;
            finalizeVideo(Number.isFinite(real) && real > 0 ? real : 0);
          };
          video.addEventListener('timeupdate', onTimeUpdate);
          try {
            video.currentTime = Number.MAX_SAFE_INTEGER;
          } catch {
            video.removeEventListener('timeupdate', onTimeUpdate);
            finalizeVideo(Number.isFinite(reported) && reported > 0 ? reported : 0);
          }
        };
        video.onerror = () => {
          URL.revokeObjectURL(probeUrl);
          finishLoading();
        };
        video.src = probeUrl;
      });
    },
    [dispatch]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const handleSplitAtPlayhead = () => {
    if (state.selectedClipIds.length !== 1) return;
    dispatch({
      type: 'SPLIT_CLIP',
      payload: {
        clipId: state.selectedClipIds[0],
        splitTime: state.playheadPosition,
      },
    });
  };

  const handleDeleteSelected = () => {
    state.selectedClipIds.forEach((clipId) => {
      dispatch({ type: 'DELETE_CLIP', payload: { clipId } });
    });
  };

  const handleAddText = () => {
    const trackId = state.trackOrder[0];
    if (!trackId) return;
    const clip: TextClip = {
      id: newId('clip'),
      kind: 'text',
      sourceStart: 0,
      sourceEnd: DEFAULT_TEXT_DURATION,
      timelineStart: state.playheadPosition,
      trackId,
      zIndex: 0,
      text: 'Your text',
      color: '#ffffff',
      fontSize: 8,
      fontFamily: 'sans',
      transform: { ...DEFAULT_TRANSFORM },
      speed: 1,
      transitionOut: null,
      transitionIn: null,
    };
    dispatch({ type: 'ADD_CLIP', payload: { clip, trackId } });
    dispatch({ type: 'SELECT_CLIP', payload: [clip.id] });
  };

  const mediaFiles = Object.values(state.mediaFiles);
  const hasSelection = state.selectedClipIds.length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'media' ? 'active' : ''}`}
          onClick={() => setTab('media')}
        >
          <ClapperIcon className="icon-sm sidebar-tab-icon" />
          Media
        </button>
        <button
          className={`sidebar-tab ${tab === 'fx' ? 'active' : ''}`}
          onClick={() => setTab('fx')}
        >
          <SparkleIcon className="icon-sm sidebar-tab-icon" />
          Effects
        </button>
        <button
          className={`sidebar-tab ${tab === 'inspect' ? 'active' : ''}`}
          onClick={() => setTab('inspect')}
        >
          <SettingsIcon className="icon-sm sidebar-tab-icon" />
          Inspect
        </button>
      </div>

      <div className="sidebar-content">
        {tab === 'media' && (
          <>
            <div>
              <div className="sidebar-section-title">Import</div>
              <div
                className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="drop-zone-icon">⬆</div>
                <div className="drop-zone-text">Drop video or image files</div>
                <div className="drop-zone-hint">or click to browse</div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => e.target.files && handleFiles(e.target.files)}
              />
            </div>

            {(mediaFiles.length > 0 || loadingFiles.size > 0) && (
              <div>
                <div className="sidebar-section-title">Files</div>
                <div className="file-list">
                  {Object.entries(transcodingFiles).map(([tid, info]) => (
                    <div key={tid} className="file-item" style={{ opacity: 0.75 }}>
                      <div className="file-item-icon" style={{ animation: 'spin 1s linear infinite' }}>⏳</div>
                      <div className="file-item-info" style={{ width: '100%' }}>
                        <div className="file-item-name">{info.name}</div>
                        <div className="file-item-meta">Converting to MP4 · {Math.round(info.progress * 100)}%</div>
                        <div style={{
                          marginTop: 6, height: 3, background: 'var(--bg-tertiary)', borderRadius: 2, overflow: 'hidden',
                        }}>
                          <div style={{
                            width: `${Math.round(info.progress * 100)}%`, height: '100%',
                            background: 'var(--accent-gradient)', transition: 'width 0.2s ease',
                          }} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {loadingFiles.size > Object.keys(transcodingFiles).length && (
                    <div className="file-item" style={{ opacity: 0.5 }}>
                      <div className="file-item-icon" style={{ animation: 'spin 1s linear infinite' }}>⏳</div>
                      <div className="file-item-info">
                        <div className="file-item-name">Reading{loadingFiles.size > 1 ? ` (${loadingFiles.size})` : ''}…</div>
                        <div className="file-item-meta">Probing metadata</div>
                      </div>
                    </div>
                  )}
                  {mediaFiles.map((f) => {
                    const statusLabel =
                      f.status === 'hydrating'
                        ? 'Loading…'
                        : f.status === 'missing'
                          ? 'Missing — re-import'
                          : null;
                    const statusColor =
                      f.status === 'missing' ? 'var(--danger)' : 'var(--text-muted)';
                    return (
                      <div
                        key={f.id}
                        className="file-item"
                        draggable={f.status === 'ready'}
                        style={{ opacity: f.status === 'ready' ? 1 : 0.6 }}
                        onDragStart={(e) => {
                          if (f.status !== 'ready') {
                            e.preventDefault();
                            return;
                          }
                          e.dataTransfer.setData('mediaFileId', f.id);
                        }}
                        onDoubleClick={() => f.status === 'ready' && addMediaToTimeline(f)}
                        onContextMenu={(e) => {
                          if (f.status !== 'ready') return;
                          e.preventDefault();
                          e.stopPropagation();
                          const W = 180;
                          const H = 80;
                          const margin = 8;
                          const x = Math.min(e.clientX, window.innerWidth - W - margin);
                          const y = Math.min(e.clientY, window.innerHeight - H - margin);
                          setFileCtxMenu({ x: Math.max(margin, x), y: Math.max(margin, y), mediaId: f.id });
                        }}
                      >
                        <div className="file-item-icon">
                          {f.kind === 'image' ? (
                            <ImageIcon className="icon-md" />
                          ) : (
                            <VideoIcon className="icon-md" />
                          )}
                        </div>
                        <div className="file-item-info">
                          <div className="file-item-name">{f.name}</div>
                          <div className="file-item-meta">
                            {`${Math.floor(f.duration / 60)}:${Math.floor(f.duration % 60).toString().padStart(2, '0')}`}
                            {f.width > 0 && ` · ${f.width}×${f.height}`}
                            {statusLabel && (
                              <>
                                {' · '}
                                <span style={{ color: statusColor }}>{statusLabel}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <div className="sidebar-section-title">Quick Tools</div>
              <div className="quick-tools">
                <button className="tool-btn" onClick={handleAddText}>
                  <TextIcon className="icon-sm" /> Add Text
                </button>
                <button
                  className="tool-btn"
                  disabled={state.selectedClipIds.length !== 1}
                  onClick={handleSplitAtPlayhead}
                >
                  <SplitIcon className="icon-sm" /> Split at Playhead
                </button>
                <button
                  className="tool-btn"
                  disabled={!hasSelection}
                  onClick={handleDeleteSelected}
                >
                  <DeleteIcon className="icon-sm" /> Delete Selected
                </button>
              </div>
            </div>
          </>
        )}

        {tab === 'fx' && <EffectsPanel />}

        {tab === 'inspect' && <Inspector />}
      </div>

      {fileCtxMenu && (
        <div
          className="context-menu"
          style={{ left: fileCtxMenu.x, top: fileCtxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              const m = state.mediaFiles[fileCtxMenu.mediaId];
              if (m) addMediaToTimeline(m);
              setFileCtxMenu(null);
            }}
          >
            <span>＋ Add to timeline at playhead</span>
          </button>
        </div>
      )}
    </aside>
  );
}

import { useEffect, useState } from 'react';
import { useProject } from '../../state/ProjectContext';
import { useExport, type QualityPreset } from '../../hooks/useExport';
import { checkExportSupport, type ExportSupport } from '../../services/browserSupport';
import { DownloadIcon, XIcon } from '../icons';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

const QUALITY_OPTIONS: { value: QualityPreset; label: string; hint: string }[] = [
  { value: 'fast', label: 'Fast', hint: '~1.5 Mbps @ 1080p · best for previews' },
  { value: 'balanced', label: 'Balanced', hint: '~4 Mbps @ 1080p' },
  { value: 'quality', label: 'Quality', hint: '~7 Mbps @ 1080p · larger files' },
];

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const { state } = useProject();
  const { exportState, startExportFlow, reset, readiness } = useExport();
  const [quality, setQuality] = useState<QualityPreset>('fast');
  const [support, setSupport] = useState<ExportSupport | null>(null);

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    checkExportSupport({ width: state.canvas.width, height: state.canvas.height }).then((s) => {
      if (!cancelled) setSupport(s);
    });
    return () => { cancelled = true; };
  }, [open, state.canvas.width, state.canvas.height]);

  if (!open) return null;

  const handleClose = () => {
    reset();
    onClose();
  };

  const isWorking =
    exportState.phase === 'waiting' ||
    exportState.phase === 'loading-core' ||
    exportState.phase === 'exporting';
  const hasClips = Object.keys(state.clips).length > 0;

  return (
    <div className="modal-backdrop" onClick={isWorking ? undefined : handleClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Export Video</h2>
          {!isWorking && (
            <button
              type="button"
              className="modal-close"
              onClick={handleClose}
              aria-label="Close"
            >
              <XIcon className="icon-sm" />
            </button>
          )}
        </div>

        <div className="modal-body">
          {exportState.phase === 'idle' && (
            <>
              {!hasClips ? (
                <p className="modal-alert modal-alert-warn">
                  Add clips to the timeline before exporting.
                </p>
              ) : support && !support.supported ? (
                <p className="modal-alert modal-alert-warn">{support.reason}</p>
              ) : readiness.missing > 0 ? (
                <p className="modal-alert modal-alert-warn">
                  {readiness.missing} media file{readiness.missing > 1 ? 's are' : ' is'} missing —
                  re-import before exporting.
                </p>
              ) : readiness.hydrating > 0 ? (
                <p className="modal-text">Loading media from storage…</p>
              ) : (
                <>
                  <p className="modal-text">
                    Export runs in your browser with WebCodecs (hardware-accelerated) — nothing is
                    uploaded.
                  </p>
                  {support && support.supported && !support.audioCodec && (
                    <p className="modal-alert modal-alert-warn">
                      This browser has no audio encoder available — export will be silent. (Common
                      on Linux Chromium builds; AAC and Opus encoders are both missing.)
                    </p>
                  )}
                  {support && support.supported && support.audioCodec === 'opus' && (
                    <p className="modal-note">
                      Using Opus audio (AAC not available in this browser). The MP4 will play in
                      Chrome/Firefox/VLC. Safari may not handle MP4-Opus.
                    </p>
                  )}
                  <div className="modal-section">
                    <div className="modal-section-title">Canvas</div>
                    <div className="modal-section-value">
                      {state.canvas.width} × {state.canvas.height}
                    </div>
                    <div className="modal-section-hint">
                      What you see in the preview is what will be exported. Change the size from
                      the canvas picker in the top bar.
                    </div>
                  </div>
                  <div className="modal-section">
                    <div className="modal-section-title">Quality / Speed</div>
                    <div className="modal-chip-stack">
                      {QUALITY_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`modal-chip ${quality === opt.value ? 'active' : ''}`}
                          onClick={() => setQuality(opt.value)}
                        >
                          <span className="modal-chip-label">{opt.label}</span>
                          <span className="modal-chip-hint">{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={handleClose}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => startExportFlow(quality)}
                  disabled={
                    !hasClips || !readiness.allReady || (support !== null && !support.supported)
                  }
                >
                  <DownloadIcon className="icon-sm" />
                  <span>Export</span>
                </button>
              </div>
            </>
          )}

          {exportState.phase === 'waiting' && (
            <>
              <p className="modal-text">Loading media from storage…</p>
              <ProgressBar progress={exportState.progress} />
            </>
          )}

          {exportState.phase === 'exporting' && (
            <>
              <p className="modal-text">Rendering video…</p>
              <ProgressBar progress={exportState.progress} />
              <p className="modal-note">
                Using your browser's hardware H.264 encoder. Should be a few × realtime on a modern
                machine.
              </p>
            </>
          )}

          {exportState.phase === 'done' && (
            <>
              <p className="modal-alert modal-alert-success">Export complete!</p>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={handleClose}>
                  Close
                </button>
                {exportState.downloadUrl && (
                  <a
                    href={exportState.downloadUrl}
                    download="aether-edits-export.mp4"
                    className="btn btn-primary"
                  >
                    <DownloadIcon className="icon-sm" />
                    <span>Download</span>
                  </a>
                )}
              </div>
            </>
          )}

          {exportState.phase === 'error' && (
            <>
              <p className="modal-alert modal-alert-danger">{exportState.error}</p>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={handleClose}>
                  Close
                </button>
                <button className="btn btn-primary" onClick={() => startExportFlow(quality)}>
                  Retry
                </button>
              </div>
            </>
          )}

          {isWorking && <p className="modal-note">Please don't close this window.</p>}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ progress, indeterminate }: { progress: number; indeterminate?: boolean }) {
  return (
    <div className="progress-track">
      <div
        className={`progress-fill ${indeterminate ? 'progress-fill-indet' : ''}`}
        style={{ width: indeterminate ? '40%' : `${Math.min(progress, 100)}%` }}
      />
    </div>
  );
}

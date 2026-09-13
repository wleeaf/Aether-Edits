/**
 * Main-thread orchestration for WebCodecs export. Spawns export.worker.ts,
 * forwards an ExportRequest, exposes a Promise<Blob> and progress callbacks.
 *
 * Replaces the old `exportEngine.ts` runExport(). useExport.ts depends on
 * this shape.
 */
import type { ExportRequest, ExportMessage, QualityPreset, SerializedMediaFile } from '../workers/export.worker';

export type { ExportRequest, ExportMessage, QualityPreset, SerializedMediaFile };

let worker: Worker | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), {
    type: 'module',
  });
  return worker;
}

export interface ExportCallbacks {
  onProgress?: (fraction: number) => void;
}

export interface ExportHandle {
  promise: Promise<Blob>;
  abort: () => void;
}

export function runWebCodecsExport(
  req: ExportRequest,
  cb: ExportCallbacks = {},
): ExportHandle {
  const w = getWorker();
  let aborted = false;

  const promise = new Promise<Blob>((resolve, reject) => {
    const handleMessage = (ev: MessageEvent<ExportMessage>) => {
      const m = ev.data;
      switch (m.type) {
        case 'progress':
          cb.onProgress?.(m.fraction);
          break;
        case 'done':
          w.removeEventListener('message', handleMessage);
          resolve(new Blob([m.output], { type: 'video/mp4' }));
          break;
        case 'error':
          w.removeEventListener('message', handleMessage);
          reject(new Error(m.message));
          break;
        case 'aborted':
          w.removeEventListener('message', handleMessage);
          reject(new Error('Export aborted'));
          break;
      }
    };

    w.addEventListener('message', handleMessage);
    // Transfer the PCM channel buffers (zero-copy). After this call the
    // main-thread Float32Arrays are detached — that's fine, we don't
    // reuse them.
    const transfers: ArrayBuffer[] = [];
    if (req.audioPcm) {
      for (const ch of req.audioPcm.channels) {
        if (ch.buffer instanceof ArrayBuffer) transfers.push(ch.buffer);
      }
    }
    w.postMessage(req, transfers);
  });

  return {
    promise,
    abort: () => {
      if (aborted) return;
      aborted = true;
      w.postMessage({ type: 'abort' });
    },
  };
}

const MAX_ENTRIES = 300;
const cache = new Map<string, string>(); // key → blob URL

function cacheKey(mediaId: string, sourceTime: number, width: number): string {
  return `${mediaId}:${Math.round(sourceTime)}:${width}`;
}

function touch(key: string, url: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, url);
  while (cache.size > MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    const firstUrl = cache.get(firstKey);
    if (firstUrl) URL.revokeObjectURL(firstUrl);
    cache.delete(firstKey);
  }
}

// Serial queue: a single <video>+canvas pipeline handles one seek at a time.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

export async function getThumbnail(
  mediaId: string,
  file: File,
  sourceTime: number,
  width = 80,
  height = 45
): Promise<string> {
  const key = cacheKey(mediaId, sourceTime, width);
  const hit = cache.get(key);
  if (hit) {
    touch(key, hit);
    return hit;
  }

  return enqueue(async () => {
    const again = cache.get(key);
    if (again) return again;

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error('thumbnail load failed')), { once: true });
      });

      video.currentTime = Math.min(Math.max(0, sourceTime), Math.max(0, (video.duration || 0) - 0.01));
      await new Promise<void>((resolve) => {
        video.addEventListener('seeked', () => resolve(), { once: true });
      });

      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error('no 2d context');
      const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
      const dw = Math.round(video.videoWidth * scale);
      const dh = Math.round(video.videoHeight * scale);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(video, Math.floor((width - dw) / 2), Math.floor((height - dh) / 2), dw, dh);

      let blob: Blob;
      if (canvas instanceof OffscreenCanvas) {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
      } else {
        blob = await new Promise<Blob>((resolve, reject) => {
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob null'))),
            'image/jpeg',
            0.6
          );
        });
      }
      const thumbUrl = URL.createObjectURL(blob);
      touch(key, thumbUrl);
      return thumbUrl;
    } finally {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    }
  });
}

export function clearThumbnailCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

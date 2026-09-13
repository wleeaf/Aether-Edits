/**
 * Video scrubber abstraction. Phase 1 ships a <video>-based implementation.
 * A WebCodecs implementation is stubbed so the abstraction locks in now; when
 * the WebCodecs MP4 demux + decode pipeline is written, PreviewPanel won't change.
 */

export interface VideoScrubber {
  attach(file: File, onReady?: () => void): void;
  seek(sourceTime: number): Promise<void>;
  drawCurrentFrame(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  detach(): void;
}

export class VideoElementScrubber implements VideoScrubber {
  private video: HTMLVideoElement | null = null;
  private url: string | null = null;

  attach(file: File, onReady?: () => void): void {
    this.detach();
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    if (onReady) video.addEventListener('loadeddata', () => onReady(), { once: true });
    video.src = url;
    this.video = video;
    this.url = url;
  }

  async seek(sourceTime: number): Promise<void> {
    const v = this.video;
    if (!v) return;
    if (v.readyState < 1) {
      await new Promise<void>((resolve) => v.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    }
    if (Math.abs(v.currentTime - sourceTime) < 0.05) return;
    await new Promise<void>((resolve) => {
      v.addEventListener('seeked', () => resolve(), { once: true });
      v.currentTime = sourceTime;
    });
  }

  drawCurrentFrame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const v = this.video;
    if (!v || v.readyState < 2) return;
    const scale = Math.min(w / v.videoWidth, h / v.videoHeight);
    const dw = Math.round(v.videoWidth * scale);
    const dh = Math.round(v.videoHeight * scale);
    const dx = Math.floor((w - dw) / 2);
    const dy = Math.floor((h - dh) / 2);
    ctx.drawImage(v, dx, dy, dw, dh);
  }

  detach(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}

export class WebCodecsScrubber implements VideoScrubber {
  // Phase 2 implementation: mp4box.js demux + VideoDecoder decode.
  attach(): void { throw new Error('WebCodecsScrubber not yet implemented'); }
  async seek(): Promise<void> { throw new Error('WebCodecsScrubber not yet implemented'); }
  drawCurrentFrame(): void { throw new Error('WebCodecsScrubber not yet implemented'); }
  detach(): void {}
}

/** Returns a scrubber for the given file. Phase 1 always uses the <video> impl. */
export function createScrubber(): VideoScrubber {
  return new VideoElementScrubber();
}

/** Feature-detect — currently unused by PreviewPanel but exposed for future flip. */
export async function isWebCodecsSupported(codec = 'avc1.64002A'): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') return false;
  try {
    const r = await VideoDecoder.isConfigSupported({ codec });
    return !!r.supported;
  } catch {
    return false;
  }
}

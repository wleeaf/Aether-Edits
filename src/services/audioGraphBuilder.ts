/**
 * Builds an OfflineAudioContext graph from the project timeline and renders
 * it to a single AudioBuffer. That buffer is then chunked into AudioData
 * frames and fed to a WebCodecs AudioEncoder.
 *
 * IMPORTANT: this module MUST run on the main thread.
 *   - Firefox doesn't expose Web Audio (OfflineAudioContext, decodeAudioData)
 *     in DedicatedWorkerGlobalScope.
 *   - Chrome added it in 110+ but older Chromium builds and some embedded
 *     contexts don't have it.
 *   - So we render to PCM on the main thread, then transfer the PCM
 *     channels to the export worker for encoding (AudioEncoder DOES work
 *     in workers).
 *
 * Per video clip with audio:
 *
 *   BufferSource(playbackRate = speed)
 *      → Gain(volume + fade ramps)
 *      → StereoPanner(pan)
 *      → Gain(ducking schedule)
 *      → Destination
 *
 * Why OfflineAudioContext rather than raw PCM math: pan, gain ramps, sample
 * mixing, and source-time/output-time scheduling are exactly what the Web
 * Audio API was built for. The graph is declarative and ~100 lines covers
 * what would be a few hundred lines of PCM bookkeeping.
 *
 * Known limitation (v1): BufferSource.playbackRate changes pitch as well as
 * speed. FFmpeg's atempo preserved pitch via phase vocoding. Most users
 * don't notice on short speed-adjusted clips; pitch preservation can be
 * added later via rubberband.js if it comes up.
 */

import type { VideoClip } from '../types/project';
import { clipDuration } from '../types/project';

export interface AudioClipInput {
  clip: VideoClip;
  /** File handle for the source media. */
  file: File;
  /** Whether the source actually has an audio stream — gates whether we add it to the graph. */
  hasAudio: boolean;
}

export interface AudioBuildInput {
  /** All video clips on the timeline (whether or not they have audio). */
  clips: AudioClipInput[];
  /** Total timeline duration in seconds. */
  duration: number;
  /** Output sample rate (matches AudioEncoder config). 48000 is the AAC sweet spot. */
  sampleRate: number;
  /** Lookup: for a given clip id, find the immediately previous clip on the
   *  same track (used to apply a fade-in mirroring the previous clip's
   *  transitionOut). */
  prevClipOnTrack: (clipId: string) => VideoClip | null;
}

/** Render the audio mix to a single AudioBuffer (length = duration × sampleRate). */
export async function buildMixedAudio(input: AudioBuildInput): Promise<AudioBuffer> {
  const { clips, duration, sampleRate, prevClipOnTrack } = input;

  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.max(1, Math.ceil(duration * sampleRate)),
    sampleRate,
  });

  // decodeAudioData is async per file; do them in parallel.
  const decodedByMedia = new Map<string, AudioBuffer>();
  await Promise.all(
    clips.map(async ({ clip, file, hasAudio }) => {
      if (!hasAudio || clip.muted) return;
      if (decodedByMedia.has(clip.mediaFileId)) return;
      try {
        const bytes = await file.arrayBuffer();
        const buf = await ctx.decodeAudioData(bytes);
        decodedByMedia.set(clip.mediaFileId, buf);
      } catch (e) {
        // Source had no decodable audio (silent video, unsupported codec, etc.)
        console.warn(`Audio decode failed for media ${clip.mediaFileId}; skipping audio for those clips:`, e);
      }
    }),
  );

  for (const { clip } of clips) {
    if (clip.muted || clip.volume <= 0) continue;
    const buf = decodedByMedia.get(clip.mediaFileId);
    if (!buf) continue;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    // SCHEDULING NOTE — easy to get wrong:
    //   `BufferSource.start(when, offset, duration)`:
    //     when      → output (timeline) seconds.
    //     offset    → source seconds at which to begin reading the buffer.
    //     duration  → source seconds to play (NOT output seconds).
    //   With `playbackRate = 2`, a 4-second source slice plays for 2 seconds
    //   of output. So pass the source-time slice as-is; playbackRate handles
    //   the compression/expansion of the output window automatically.
    source.playbackRate.value = Math.max(0.25, Math.min(4, clip.speed));

    // Gain: volume + fade ramps for transitionOut tail and prev-clip fade-in.
    const gain = ctx.createGain();
    gain.gain.value = clip.volume;
    scheduleFades(gain.gain, clip, prevClipOnTrack(clip.id), clip.volume);

    // Pan.
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, clip.pan));

    source.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);

    const sourceSlice = Math.max(0, clip.sourceEnd - clip.sourceStart);
    if (sourceSlice > 0) {
      try {
        source.start(clip.timelineStart, clip.sourceStart, sourceSlice);
      } catch (e) {
        console.warn('Audio source start failed', e);
      }
    }
  }

  return ctx.startRendering();
}

/** Apply fade-out (own transitionOut) and fade-in (prev clip's transitionOut)
 *  to the gain param via linear ramps. Mirrors `computeClipAlpha` from the
 *  video compositor so audio and video fades stay in lockstep. */
function scheduleFades(
  param: AudioParam,
  clip: VideoClip,
  prev: VideoClip | null,
  baseVolume: number,
): void {
  const dur = clipDuration(clip);
  const tlEnd = clip.timelineStart + dur;

  // Fade-out from own transitionOut.
  if (clip.transitionOut && clip.transitionOut.duration > 0) {
    const D = Math.min(clip.transitionOut.duration, dur);
    const halfD = D / 2;
    const fadeStart = tlEnd - halfD;
    param.setValueAtTime(baseVolume, fadeStart);
    param.linearRampToValueAtTime(0, tlEnd);
  }

  // Fade-in from previous adjacent clip's transitionOut.
  if (prev && prev.transitionOut && prev.transitionOut.duration > 0) {
    const prevEnd = prev.timelineStart + clipDuration(prev);
    if (Math.abs(prevEnd - clip.timelineStart) < 0.01) {
      const D = Math.min(prev.transitionOut.duration, dur);
      const halfD = D / 2;
      param.setValueAtTime(0, clip.timelineStart);
      param.linearRampToValueAtTime(baseVolume, clip.timelineStart + halfD);
    }
  }
}

/** PCM payload that crosses the main-thread → worker boundary. The
 *  channels' ArrayBuffers should be passed as transferables in postMessage
 *  to avoid a copy. */
export interface PcmPayload {
  channels: Float32Array[];
  sampleRate: number;
  numberOfFrames: number;
}

/** Main-thread entry: render audio mix via Web Audio, return a transferable
 *  PCM payload ready for the export worker. */
export async function renderAudioToPcm(input: AudioBuildInput): Promise<PcmPayload> {
  const buffer = await buildMixedAudio(input);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    // getChannelData returns a view into the AudioBuffer's internal storage —
    // copy into a fresh Float32Array so the underlying buffer is transferable
    // (the AudioBuffer keeps owning its own storage).
    channels.push(new Float32Array(buffer.getChannelData(ch)));
  }
  return { channels, sampleRate: buffer.sampleRate, numberOfFrames: buffer.length };
}

/** Worker-side: encode a pre-rendered PCM payload to AAC/Opus chunks via
 *  AudioEncoder. AudioEncoder IS available in dedicated workers; what wasn't
 *  available was OfflineAudioContext. We split rendering and encoding across
 *  the thread boundary accordingly.
 *
 *  Splits into fixed-size frames (1024 is the AAC frame size; Opus tolerates
 *  whatever you feed it). */
export async function encodePcm(
  pcm: PcmPayload,
  encoder: AudioEncoder,
): Promise<void> {
  const FRAME_SIZE = 1024;
  const { channels, sampleRate, numberOfFrames } = pcm;
  const channelCount = channels.length;

  let offset = 0;
  while (offset < numberOfFrames) {
    const len = Math.min(FRAME_SIZE, numberOfFrames - offset);
    // f32-planar layout: [channel0 samples..., channel1 samples...]
    const planar = new Float32Array(len * channelCount);
    for (let ch = 0; ch < channelCount; ch++) {
      planar.set(channels[ch].subarray(offset, offset + len), ch * len);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: len,
      numberOfChannels: channelCount,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    try {
      encoder.encode(audioData);
    } finally {
      audioData.close();
    }
    offset += len;
  }
}

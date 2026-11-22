import {
  AI_FRAME_JPEG_QUALITY,
  AI_FRAME_MAX_COUNT,
  AI_FRAME_TARGET_WIDTH,
  computeFrameTimestamps,
  computeScaledDimensions,
  formatPhaseError,
  type ExtractedVideoFrame,
} from '../utils/videoPipeline';

export class FrameExtractionError extends Error {
  technicalDetail?: string;

  constructor(message: string, technicalDetail?: string) {
    super(formatPhaseError('Extracción frames', message));
    this.name = 'FrameExtractionError';
    this.technicalDetail = technicalDetail;
  }
}

export interface FrameExtractionResult {
  frames: ExtractedVideoFrame[];
  durationSec: number;
  sourceWidth: number;
  sourceHeight: number;
}

const METADATA_TIMEOUT_MS = 12_000;
const SEEK_TIMEOUT_MS = 4_500;

function waitForEventOrTimeout(
  target: HTMLVideoElement,
  events: string[],
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timerId = 0;

    const cleanup = () => {
      window.clearTimeout(timerId);
      for (const evt of events) {
        target.removeEventListener(evt, onSuccess);
      }
      target.removeEventListener('error', onError);
    };

    const onSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };

    for (const evt of events) {
      target.addEventListener(evt, onSuccess, { once: true });
    }
    target.addEventListener('error', onError, { once: true });

    timerId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }, timeoutMs);
  });
}

async function seekVideoTo(video: HTMLVideoElement, targetSec: number): Promise<boolean> {
  const clamped = Math.max(0, Math.min(targetSec, Math.max(0, (video.duration || targetSec) - 0.05)));

  // If already within 0.08s and frame data is ready, no seek needed
  if (Math.abs(video.currentTime - clamped) <= 0.08 && video.readyState >= 2) {
    return true;
  }

  const seekPromise = waitForEventOrTimeout(video, ['seeked', 'loadeddata'], SEEK_TIMEOUT_MS);
  try {
    video.currentTime = clamped;
  } catch {
    return false;
  }
  const ok = await seekPromise;
  if (!ok) return false;

  // Give iOS Safari a micro-frame to paint decoded frame into the video texture
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  return video.readyState >= 2;
}

/**
 * Extracts 12–16 lightweight JPEG frames directly in the browser using <video> + <canvas>
 * resized to 480px width at JPEG quality 0.55 so raw .MOV/.MP4 binaries NEVER leave the device.
 */
export async function extractLightweightVideoFrames(
  videoBlob: Blob,
  knownDurationSec?: number,
  onProgress?: (message: string, percent: number) => void
): Promise<FrameExtractionResult> {
  if (typeof document === 'undefined') {
    throw new FrameExtractionError('La extracción de fotogramas requiere un navegador.');
  }

  const objectUrl = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');
  video.preload = 'auto';

  const canvas = document.createElement('canvas');

  try {
    onProgress?.('Abriendo vídeo en el navegador para extraer fotogramas...', 8);

    const metaPromise = waitForEventOrTimeout(
      video,
      ['loadeddata', 'loadedmetadata'],
      METADATA_TIMEOUT_MS
    );
    video.src = objectUrl;
    video.load();

    const loaded = await metaPromise;
    if (!loaded && video.readyState < 1) {
      throw new FrameExtractionError(
        'No se pudo decodificar el vídeo en este navegador (formato o códec no soportado en Safari).'
      );
    }

    // Ensure at least first frame is decoded on iOS Safari
    if (video.readyState < 2) {
      await waitForEventOrTimeout(video, ['loadeddata', 'canplay'], 4_000);
    }

    const durationSec =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : knownDurationSec && knownDurationSec > 0
        ? knownDurationSec
        : 0;

    const sourceWidth = video.videoWidth || AI_FRAME_TARGET_WIDTH;
    const sourceHeight = video.videoHeight || Math.round(AI_FRAME_TARGET_WIDTH * (16 / 9));
    const { width, height } = computeScaledDimensions(
      sourceWidth,
      sourceHeight,
      AI_FRAME_TARGET_WIDTH
    );

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!ctx) {
      throw new FrameExtractionError('No se pudo inicializar el canvas 2D para extraer fotogramas.');
    }

    const timestamps = computeFrameTimestamps(durationSec, AI_FRAME_MAX_COUNT);
    const frames: ExtractedVideoFrame[] = [];
    let accumulatedBase64Chars = 0;

    for (let i = 0; i < timestamps.length; i += 1) {
      const targetSec = timestamps[i];
      const pct = Math.round(12 + ((i + 1) / timestamps.length) * 32);
      onProgress?.(
        `Extrayendo fotograma ${i + 1}/${timestamps.length} (${targetSec.toFixed(1)}s)...`,
        pct
      );

      const seekOk = await seekVideoTo(video, targetSec);
      if (!seekOk && frames.length > 0) {
        // Skip stalled keyframe gracefully if we already have valid frames
        continue;
      }

      try {
        ctx.drawImage(video, 0, 0, width, height);
        // Adapt quality slightly downward only if frames are unusually detailed so total stays well below 2 MB
        const quality =
          accumulatedBase64Chars > 1_200_000
            ? Math.max(0.38, AI_FRAME_JPEG_QUALITY - 0.14)
            : AI_FRAME_JPEG_QUALITY;
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const commaIdx = dataUrl.indexOf(',');
        const dataBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';

        if (dataBase64.length > 64) {
          accumulatedBase64Chars += dataBase64.length;
          frames.push({
            timestampSec: targetSec,
            dataBase64,
            mimeType: 'image/jpeg',
            width,
            height,
          });
        }
      } catch (drawErr) {
        console.warn(`[Extracción frames] No se pudo capturar t=${targetSec}s:`, drawErr);
      }
    }

    if (frames.length === 0) {
      throw new FrameExtractionError(
        'No se pudo extraer ningún fotograma válido del vídeo. Comprueba que el archivo MP4/MOV no esté dañado.'
      );
    }

    return {
      frames,
      durationSec,
      sourceWidth,
      sourceHeight,
    };
  } catch (err) {
    if (err instanceof FrameExtractionError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new FrameExtractionError(
      'No se pudieron extraer los fotogramas del vídeo en el navegador.',
      detail
    );
  } finally {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // Ignore cleanup errors
    }
    canvas.width = 0;
    canvas.height = 0;
    URL.revokeObjectURL(objectUrl);
  }
}

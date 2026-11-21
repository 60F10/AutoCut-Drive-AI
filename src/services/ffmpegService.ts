import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { VideoCut } from '../types';
import { buildFfmpegFilterComplex, getExtension } from '../utils/videoPipeline';

// Single-threaded @ffmpeg/core CDNs (does NOT require SharedArrayBuffer or COOP/COEP headers)
const FFMPEG_CORE_CDNS = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
];

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

async function getLoadedFfmpeg(onStatus?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const instance = new FFmpeg();
    let lastError: unknown = null;

    for (const baseURL of FFMPEG_CORE_CDNS) {
      try {
        onStatus?.('Cargando motor FFmpeg.wasm (single-thread)...');
        const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
        await instance.load({ coreURL, wasmURL });
        ffmpegInstance = instance;
        return instance;
      } catch (err) {
        lastError = err;
      }
    }

    loadPromise = null;
    throw new Error(
      `No se pudo cargar @ffmpeg/core single-thread: ${
        lastError instanceof Error ? lastError.message : 'Error de red'
      }`
    );
  })();

  return loadPromise;
}

export async function readVideoDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      cleanup();
      resolve(duration);
    };

    video.onerror = () => {
      cleanup();
      resolve(0);
    };

    video.src = url;
  });
}

export interface RenderProgress {
  percent: number;
  message: string;
}

/**
 * Renders the selected cuts into a clean H.264 + AAC MP4 preserving 9:16 vertical orientation.
 */
export async function renderCutsWithFfmpeg(
  sourceBlob: Blob,
  originalFileName: string,
  cuts: VideoCut[],
  onProgress?: (progress: RenderProgress) => void
): Promise<Blob> {
  const ffmpeg = await getLoadedFfmpeg((msg) => onProgress?.({ percent: 5, message: msg }));

  const ext = getExtension(originalFileName) || '.mp4';
  const inputName = `input${ext}`;
  const outputName = 'output.mp4';

  const progressHandler = ({ progress }: { progress: number }) => {
    const pct = Math.max(10, Math.min(98, Math.round(progress * 100)));
    onProgress?.({
      percent: pct,
      message: `Renderizando cortes en navegador (${pct}%)...`,
    });
  };

  ffmpeg.on('progress', progressHandler);

  try {
    onProgress?.({ percent: 8, message: 'Preparando vídeo en memoria de FFmpeg...' });
    await ffmpeg.writeFile(inputName, await fetchFile(sourceBlob));

    // Attempt full video+audio concat first; if source video has no audio stream, retry video-only
    let exitCode = 0;
    try {
      const { args, activeCount } = buildFfmpegFilterComplex(cuts, inputName, outputName, true);
      onProgress?.({
        percent: 12,
        message: `Uniendo ${activeCount} cortes (H.264 + AAC)...`,
      });
      exitCode = await ffmpeg.exec(args);
    } catch {
      exitCode = 1;
    }

    if (exitCode !== 0) {
      const { args, activeCount } = buildFfmpegFilterComplex(cuts, inputName, outputName, false);
      onProgress?.({
        percent: 18,
        message: `Sin pista de audio detectada: uniendo ${activeCount} cortes de vídeo...`,
      });
      const fallbackCode = await ffmpeg.exec(args);
      if (fallbackCode !== 0) {
        throw new Error(
          'FFmpeg.wasm no pudo renderizar los cortes. Comprueba que el códec del vídeo sea compatible (H.264 / MP4 / WebM).'
        );
      }
    }

    onProgress?.({ percent: 99, message: 'Empaquetando archivo MP4 final...' });
    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(String(data));
    onProgress?.({ percent: 100, message: 'Renderizado completado.' });
    return new Blob([bytes.buffer], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}

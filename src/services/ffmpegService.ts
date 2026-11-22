import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { ExportQuality, SubtitleBlock, TikTokEditOptions, VideoCut } from '../types';
import {
  EXPORT_QUALITY_PROFILES,
  buildAssSubtitles,
  buildFfmpegFilterComplex,
  buildMultiClipFfmpegFilterComplex,
  filterEditedCuts,
  getExtension,
  normalizeTikTokOptions,
  remapSubtitlesToFinalTimeline,
  type FfmpegPipelineOptions,
} from '../utils/videoPipeline';

// Single-threaded @ffmpeg/core CDNs (does NOT require SharedArrayBuffer or COOP/COEP headers)
const FFMPEG_CORE_CDNS = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
];

const FFMPEG_TEMP_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.webm',
  '.m4a',
  '.aac',
  '.tmp',
  '.txt',
  '.srt',
  '.ass',
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

/**
 * Strictly purges tracked files AND sweeps any leftover media/temp/subtitle artifacts
 * in the FFmpeg.wasm virtual root filesystem to keep mobile browser RAM low.
 */
async function purgeFfmpegVirtualFs(ffmpeg: FFmpeg, trackedFiles: string[] = []): Promise<void> {
  const candidates = new Set<string>(trackedFiles.filter(Boolean));

  try {
    const entries = await ffmpeg.listDir('/');
    for (const entry of entries) {
      if (entry.isDir) continue;
      const lower = entry.name.toLowerCase();
      if (FFMPEG_TEMP_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        candidates.add(entry.name);
      }
    }
  } catch {
    // Fallback to deleting tracked files directly if listDir is unavailable
  }

  await Promise.allSettled(
    Array.from(candidates).map((fileName) => ffmpeg.deleteFile(fileName))
  );
}

export interface VideoMetadataInfo {
  durationSec: number;
  width: number;
  height: number;
}

export async function inspectVideoMetadata(blob: Blob): Promise<VideoMetadataInfo> {
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
      const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
      const width = Number.isFinite(video.videoWidth) ? video.videoWidth : 0;
      const height = Number.isFinite(video.videoHeight) ? video.videoHeight : 0;
      cleanup();
      resolve({ durationSec, width, height });
    };

    video.onerror = () => {
      cleanup();
      resolve({ durationSec: 0, width: 0, height: 0 });
    };

    video.src = url;
  });
}

export async function readVideoDuration(blob: Blob): Promise<number> {
  const meta = await inspectVideoMetadata(blob);
  return meta.durationSec;
}

export interface RenderProgress {
  percent: number;
  message: string;
}

export interface RenderTikTokConfig {
  tiktokOptions?: Partial<TikTokEditOptions>;
  subtitles?: SubtitleBlock[];
  preserveOrder?: boolean;
}

async function prepareOptionalSubtitleFile(
  ffmpeg: FFmpeg,
  jobId: string,
  cuts: VideoCut[],
  exportQuality: ExportQuality,
  renderConfig?: RenderTikTokConfig
): Promise<string | undefined> {
  const opts = normalizeTikTokOptions(renderConfig?.tiktokOptions);
  if (!opts.subtitlesEnabled || !renderConfig?.subtitles?.length) {
    return undefined;
  }

  const activeCuts = filterEditedCuts(cuts, Boolean(renderConfig?.preserveOrder));
  const remapped = remapSubtitlesToFinalTimeline(renderConfig.subtitles, activeCuts);
  if (remapped.length === 0) {
    return undefined;
  }

  const profile = EXPORT_QUALITY_PROFILES[exportQuality];
  const assContent = buildAssSubtitles(remapped, profile.width, profile.height);
  const subFileName = `subs_${jobId}.ass`;
  await ffmpeg.writeFile(subFileName, new TextEncoder().encode(assContent));
  return subFileName;
}

/**
 * Renders single-clip selected cuts into a clean H.264 + AAC MP4 preserving 9:16 vertical orientation,
 * optional framing mode (center_crop / blur_pad), silence trim, -14 LUFS normalization,
 * optional burned ASS subtitles, and strict virtual FS cleanup in `finally`.
 */
export async function renderCutsWithFfmpeg(
  sourceBlob: Blob,
  originalFileName: string,
  cuts: VideoCut[],
  onProgress?: (progress: RenderProgress) => void,
  exportQuality: ExportQuality = 'high_1080p',
  renderConfig?: RenderTikTokConfig
): Promise<Blob> {
  const ffmpeg = await getLoadedFfmpeg((msg) => onProgress?.({ percent: 5, message: msg }));
  const profile = EXPORT_QUALITY_PROFILES[exportQuality];
  const opts = normalizeTikTokOptions(renderConfig?.tiktokOptions);

  const jobId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ext = getExtension(originalFileName) || '.mp4';
  const inputName = `in_${jobId}${ext}`;
  const outputName = `out_${jobId}.mp4`;
  let subtitleFileName: string | undefined;

  const progressHandler = ({ progress }: { progress: number }) => {
    const pct = Math.max(10, Math.min(98, Math.round(progress * 100)));
    onProgress?.({
      percent: pct,
      message: `Renderizando cortes en ${profile.width}×${profile.height} (${pct}%)...`,
    });
  };

  ffmpeg.on('progress', progressHandler);

  try {
    await purgeFfmpegVirtualFs(ffmpeg);

    onProgress?.({ percent: 8, message: 'Preparando vídeo en memoria de FFmpeg...' });
    await ffmpeg.writeFile(inputName, await fetchFile(sourceBlob));

    subtitleFileName = await prepareOptionalSubtitleFile(
      ffmpeg,
      jobId,
      cuts,
      exportQuality,
      renderConfig
    );

    const basePipelineOptions: FfmpegPipelineOptions = {
      framingMode: opts.framingMode,
      silenceTrimEnabled: opts.silenceTrimEnabled,
      audioNormalizeEnabled: opts.audioNormalizeEnabled,
      subtitleFileName,
      preserveOrder: renderConfig?.preserveOrder ?? true,
    };

    const runAttempt = async (hasAudio: boolean, withSubtitles: boolean): Promise<number> => {
      await ffmpeg.deleteFile(outputName).catch(() => {});
      const { args, activeCount } = buildFfmpegFilterComplex(
        cuts,
        inputName,
        outputName,
        hasAudio,
        exportQuality,
        {
          ...basePipelineOptions,
          subtitleFileName: withSubtitles ? subtitleFileName : undefined,
        }
      );
      const audioTag = hasAudio && opts.audioNormalizeEnabled ? ' · -14 LUFS' : '';
      const subTag = withSubtitles && subtitleFileName ? ' · Subtítulos' : '';
      onProgress?.({
        percent: hasAudio ? 12 : 18,
        message: `Renderizando ${activeCount} cortes (${profile.shortLabel}${audioTag}${subTag})...`,
      });
      try {
        return await ffmpeg.exec(args);
      } catch {
        return 1;
      }
    };

    let exitCode = await runAttempt(true, Boolean(subtitleFileName));

    // If burned subtitles failed in this wasm build (e.g. missing libass/fontconfig), retry cleanly without burning
    if (exitCode !== 0 && subtitleFileName) {
      onProgress?.({
        percent: 16,
        message: 'Reintentando render sin quemar subtítulos (disponibles en .SRT)...',
      });
      exitCode = await runAttempt(true, false);
    }

    // Fallback for videos without an audio track
    if (exitCode !== 0) {
      exitCode = await runAttempt(false, false);
      if (exitCode !== 0) {
        throw new Error(
          'FFmpeg.wasm no pudo renderizar los cortes. Comprueba que el códec sea compatible o prueba el modo "720p móvil" para ahorrar RAM.'
        );
      }
    }

    onProgress?.({ percent: 99, message: 'Empaquetando archivo MP4 final...' });
    const data = await ffmpeg.readFile(outputName);
    const bytes =
      data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(String(data));
    onProgress?.({ percent: 100, message: 'Renderizado completado.' });
    return new Blob([bytes.buffer], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    await purgeFfmpegVirtualFs(ffmpeg, [inputName, outputName, subtitleFileName ?? '']);
  }
}

export interface MultiClipFfmpegSource {
  blob: Blob;
  originalFileName: string;
}

/**
 * Renders multi-clip cuts referencing each input by clip_index, normalizing every clip
 * to 9:16 vertical with framing mode, silence trim, -14 LUFS loudness normalization,
 * optional burned ASS subtitles, and strict virtual FS cleanup in `finally`.
 */
export async function renderMultiClipCutsWithFfmpeg(
  sources: MultiClipFfmpegSource[],
  cuts: VideoCut[],
  onProgress?: (progress: RenderProgress) => void,
  exportQuality: ExportQuality = 'high_1080p',
  renderConfig?: RenderTikTokConfig
): Promise<Blob> {
  const ffmpeg = await getLoadedFfmpeg((msg) => onProgress?.({ percent: 4, message: msg }));
  const profile = EXPORT_QUALITY_PROFILES[exportQuality];
  const opts = normalizeTikTokOptions(renderConfig?.tiktokOptions);

  const jobId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const inputNames: string[] = [];
  const outputName = `combined_${jobId}.mp4`;
  let subtitleFileName: string | undefined;

  const progressHandler = ({ progress }: { progress: number }) => {
    const pct = Math.max(15, Math.min(98, Math.round(progress * 100)));
    onProgress?.({
      percent: pct,
      message: `Normalizando ${profile.width}×${profile.height} y uniendo clips (${pct}%)...`,
    });
  };

  ffmpeg.on('progress', progressHandler);

  try {
    await purgeFfmpegVirtualFs(ffmpeg);

    for (let i = 0; i < sources.length; i += 1) {
      const ext = getExtension(sources[i].originalFileName) || '.mp4';
      const fileName = `mc_${jobId}_${i}${ext}`;
      inputNames.push(fileName);
      onProgress?.({
        percent: Math.round(6 + ((i + 1) / sources.length) * 8),
        message: `Cargando Clip ${i + 1}/${sources.length} en FFmpeg...`,
      });
      await ffmpeg.writeFile(fileName, await fetchFile(sources[i].blob));
    }

    subtitleFileName = await prepareOptionalSubtitleFile(
      ffmpeg,
      jobId,
      cuts,
      exportQuality,
      { ...renderConfig, preserveOrder: true }
    );

    const basePipelineOptions: FfmpegPipelineOptions = {
      framingMode: opts.framingMode,
      silenceTrimEnabled: opts.silenceTrimEnabled,
      audioNormalizeEnabled: opts.audioNormalizeEnabled,
      subtitleFileName,
      preserveOrder: true,
    };

    const runAttempt = async (includeAudio: boolean, withSubtitles: boolean): Promise<number> => {
      await ffmpeg.deleteFile(outputName).catch(() => {});
      const { args, activeCount } = buildMultiClipFfmpegFilterComplex(
        cuts,
        inputNames,
        outputName,
        includeAudio,
        exportQuality,
        {
          ...basePipelineOptions,
          subtitleFileName: withSubtitles ? subtitleFileName : undefined,
        }
      );
      onProgress?.({
        percent: includeAudio ? 16 : 22,
        message: `Renderizando ${activeCount} cortes de ${sources.length} clips (${profile.width}×${profile.height})...`,
      });
      try {
        return await ffmpeg.exec(args);
      } catch {
        return 1;
      }
    };

    let exitCode = await runAttempt(true, Boolean(subtitleFileName));

    if (exitCode !== 0 && subtitleFileName) {
      onProgress?.({
        percent: 20,
        message: 'Reintentando combinación sin quemar subtítulos (disponibles en .SRT)...',
      });
      exitCode = await runAttempt(true, false);
    }

    if (exitCode !== 0) {
      exitCode = await runAttempt(false, false);
      if (exitCode !== 0) {
        throw new Error(
          'FFmpeg.wasm no pudo combinar estos clips. En móvil, activa "Rápido móvil — 720p" o reduce el peso total.'
        );
      }
    }

    onProgress?.({ percent: 99, message: 'Empaquetando MP4 combinado...' });
    const data = await ffmpeg.readFile(outputName);
    const bytes =
      data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(String(data));
    onProgress?.({ percent: 100, message: 'Combinación renderizada correctamente.' });
    return new Blob([bytes.buffer], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    await purgeFfmpegVirtualFs(ffmpeg, [...inputNames, outputName, subtitleFileName ?? '']);
  }
}

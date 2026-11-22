import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { ExportQuality, SubtitleBlock, TikTokEditOptions, VideoCut } from '../types';
import {
  EXPORT_QUALITY_PROFILES,
  buildAssSubtitles,
  buildConcatCopyFfmpegArgs,
  buildConcatListContent,
  buildFfmpegFilterComplex,
  buildSingleSegmentFfmpegArgs,
  filterEditedCuts,
  formatPhaseError,
  getExtension,
  normalizeTikTokOptions,
  planSequentialMultiClipJobs,
  remapSubtitlesToFinalTimeline,
  type FfmpegPipelineOptions,
  type SegmentAudioMode,
} from '../utils/videoPipeline';
import { logError, logInfo, logWarn } from './debugLogger';

export type FfmpegCoreFormat = 'esm' | 'umd';

export interface FfmpegCoreSource {
  format: FfmpegCoreFormat;
  provider: 'unpkg' | 'jsdelivr';
  baseURL: string;
}

export const FFMPEG_ASSET_MIME_TYPES = {
  coreJs: 'text/javascript',
  coreWasm: 'application/wasm',
} as const;

// Single-threaded @ffmpeg/core CDNs (compatible with iOS Safari without SharedArrayBuffer/COOP/COEP).
// Vite runs @ffmpeg/ffmpeg's Web Worker as an ES Module Worker (`type: 'module'`), where
// `importScripts()` does not exist and `await import(coreURL)` requires the `dist/esm` bundle.
// `dist/umd` is kept strictly as a last-resort fallback for classic-worker environments.
export const FFMPEG_CORE_SOURCES: readonly FfmpegCoreSource[] = [
  {
    format: 'esm',
    provider: 'unpkg',
    baseURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
  },
  {
    format: 'esm',
    provider: 'jsdelivr',
    baseURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
  },
  {
    format: 'umd',
    provider: 'unpkg',
    baseURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
  },
  {
    format: 'umd',
    provider: 'jsdelivr',
    baseURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  },
];

const FFMPEG_ASSET_TIMEOUT_MS = 35_000;
const METADATA_READ_TIMEOUT_MS = 6_000;

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

async function fetchFfmpegAssetAsBlobUrl(
  url: string,
  mimeType: (typeof FFMPEG_ASSET_MIME_TYPES)[keyof typeof FFMPEG_ASSET_MIME_TYPES],
  assetLabel: 'ffmpeg-core.js' | 'ffmpeg-core.wasm',
  source: FfmpegCoreSource
): Promise<string> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), FFMPEG_ASSET_TIMEOUT_MS);

  try {
    console.info(`[FFmpeg] Descargando ${assetLabel} (${source.format}) desde ${url}`);
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} al descargar ${assetLabel} (${url})`);
    }

    const buf = await response.arrayBuffer();
    if (buf.byteLength === 0) {
      throw new Error(`${assetLabel} se descargó vacío (0 bytes) desde ${url}`);
    }

    const mb = Number((buf.byteLength / (1024 * 1024)).toFixed(2));
    console.info(`[FFmpeg] ${assetLabel} (${source.format}) cargado correctamente (${mb} MB)`);
    logInfo('FFmpeg', `${assetLabel} descargado`, {
      formato: source.format,
      cdn: source.provider,
      mime: mimeType,
      pesoMB: mb,
      ms: Math.round(performance.now() - t0),
    });
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  } catch (err) {
    const isAbort =
      err instanceof DOMException
        ? err.name === 'AbortError'
        : err instanceof Error && err.name === 'AbortError';
    const reason = isAbort
      ? `Tiempo de espera agotado (${Math.round(FFMPEG_ASSET_TIMEOUT_MS / 1000)}s) cargando ${assetLabel}`
      : err instanceof Error
      ? err.message
      : String(err);
    console.error(`[FFmpeg] Error cargando ${assetLabel} (${source.format}) desde ${url}:`, err);
    logWarn(
      'FFmpeg',
      `Fallo descargando ${assetLabel}`,
      { formato: source.format, cdn: source.provider, motivo: reason },
      err
    );
    throw new Error(`Fallo al cargar ${assetLabel}: ${reason}`);
  } finally {
    window.clearTimeout(timerId);
  }
}

async function getLoadedFfmpeg(onStatus?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const t0 = performance.now();
    const attemptErrors: string[] = [];

    for (const source of FFMPEG_CORE_SOURCES) {
      const instance = new FFmpeg();
      let coreURL: string | null = null;
      let wasmURL: string | null = null;
      const formatLabel = source.format.toUpperCase();

      try {
        logInfo('FFmpeg', `Intentando cargar núcleo ${formatLabel} (${source.provider})`, {
          formato: source.format,
          cdn: source.provider,
          baseURL: source.baseURL,
        });

        onStatus?.(`Cargando motor FFmpeg.wasm ${formatLabel} (ffmpeg-core.js)...`);
        coreURL = await fetchFfmpegAssetAsBlobUrl(
          `${source.baseURL}/ffmpeg-core.js`,
          FFMPEG_ASSET_MIME_TYPES.coreJs,
          'ffmpeg-core.js',
          source
        );

        onStatus?.(`Cargando núcleo binario FFmpeg.wasm ${formatLabel} (ffmpeg-core.wasm)...`);
        wasmURL = await fetchFfmpegAssetAsBlobUrl(
          `${source.baseURL}/ffmpeg-core.wasm`,
          FFMPEG_ASSET_MIME_TYPES.coreWasm,
          'ffmpeg-core.wasm',
          source
        );

        onStatus?.(`Inicializando FFmpeg single-thread (${formatLabel}) en el navegador...`);
        await instance.load({ coreURL, wasmURL });
        console.info(
          `[FFmpeg] Motor single-thread (${source.format}) inicializado correctamente desde ${source.baseURL}`
        );
        logInfo('FFmpeg', `Núcleo single-thread ${formatLabel} inicializado`, {
          formato: source.format,
          cdn: source.provider,
          ms: Math.round(performance.now() - t0),
        });
        ffmpegInstance = instance;
        return instance;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[FFmpeg] Falló núcleo ${source.format} (${source.baseURL}): ${msg}`);
        logWarn(
          'FFmpeg',
          `Fallo al inicializar núcleo ${formatLabel} (${source.provider})`,
          { formato: source.format, cdn: source.provider, motivo: msg },
          err
        );
        attemptErrors.push(`[${source.format}] ${source.baseURL}: ${msg}`);
        try {
          instance.terminate();
        } catch {
          // Ignore terminate error on failed worker
        }
        if (coreURL) URL.revokeObjectURL(coreURL);
        if (wasmURL) URL.revokeObjectURL(wasmURL);
      }
    }

    loadPromise = null;
    logError('FFmpeg', 'No se pudo cargar @ffmpeg/core desde ningún CDN (ESM ni UMD)', {
      intentos: attemptErrors.length,
      ultimoError: attemptErrors[attemptErrors.length - 1] ?? 'desconocido',
    });
    throw new Error(
      formatPhaseError(
        'FFmpeg',
        `No se pudo cargar el núcleo single-thread (ffmpeg-core.js / ffmpeg-core.wasm). ${attemptErrors[attemptErrors.length - 1] ?? 'Comprueba tu conexión a internet.'}`
      )
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
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');

    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timerId);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    };

    const finish = (info: VideoMetadataInfo) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(info);
    };

    const timerId = window.setTimeout(() => {
      finish({ durationSec: 0, width: 0, height: 0 });
    }, METADATA_READ_TIMEOUT_MS);

    video.onloadedmetadata = () => {
      const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
      const width = Number.isFinite(video.videoWidth) ? video.videoWidth : 0;
      const height = Number.isFinite(video.videoHeight) ? video.videoHeight : 0;
      finish({ durationSec, width, height });
    };

    video.onerror = () => {
      finish({ durationSec: 0, width: 0, height: 0 });
    };

    video.src = url;
    video.load();
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
  blob?: Blob;
  loadBlob?: (onDownloadPercent?: (pct: number) => void) => Promise<Blob>;
  originalFileName: string;
  sizeBytes?: number;
}

async function prepareCutLocalSubtitleFile(
  ffmpeg: FFmpeg,
  jobId: string,
  orderIndex: number,
  cut: VideoCut,
  exportQuality: ExportQuality,
  renderConfig?: RenderTikTokConfig
): Promise<string | undefined> {
  const opts = normalizeTikTokOptions(renderConfig?.tiktokOptions);
  if (!opts.subtitlesEnabled || !renderConfig?.subtitles?.length) {
    return undefined;
  }

  const remapped = remapSubtitlesToFinalTimeline(renderConfig.subtitles, [cut]);
  if (remapped.length === 0) {
    return undefined;
  }

  const profile = EXPORT_QUALITY_PROFILES[exportQuality];
  const assContent = buildAssSubtitles(remapped, profile.width, profile.height);
  const subFileName = `sub_${jobId}_${orderIndex}.ass`;
  await ffmpeg.writeFile(subFileName, new TextEncoder().encode(assContent));
  return subFileName;
}

/**
 * Ultra-low-memory Multi-Clip renderer (1 raw clip at a time in RAM & MEMFS):
 * 1. Loads ONLY the current clip into FFmpeg MEMFS, encodes its active cuts into
 *    small uniform intermediate segments (`seg_000.mp4`, ...).
 * 2. Immediately deletes the raw input from MEMFS and drops JS Blob/Uint8Array refs
 *    before downloading/loading the next clip.
 * 3. Joins all intermediate segments in exact narrative order via FFmpeg's `concat`
 *    demuxer with `-c copy` (zero re-encoding, near-zero RAM, ~1 s).
 * 4. Purges all temporary segments and concat playlist in `finally`.
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
  const plan = planSequentialMultiClipJobs(cuts, sources.length, jobId);
  const concatListName = `concat_${jobId}.txt`;
  const outputName = `combined_${jobId}.mp4`;

  const trackedTempFiles = new Set<string>([concatListName, outputName]);
  let currentProgressBase = 8;
  let currentProgressSpan = 10;
  let currentProgressLabel = 'Recortando clips secuencialmente';

  const progressHandler = ({ progress }: { progress: number }) => {
    const safeP = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const pct = Math.max(
      8,
      Math.min(94, Math.round(currentProgressBase + safeP * currentProgressSpan))
    );
    onProgress?.({
      percent: pct,
      message: `${currentProgressLabel} (${pct}%)...`,
    });
  };

  ffmpeg.on('progress', progressHandler);

  logInfo('FFmpeg', 'Iniciando pipeline Multi-Clip secuencial (1 clip a la vez)', {
    totalClips: sources.length,
    clipsUsados: plan.clipBatches.length,
    segmentosTotales: plan.totalSegments,
    calidad: profile.shortLabel,
  });

  try {
    await purgeFfmpegVirtualFs(ffmpeg);

    let completedSegments = 0;
    const totalClips = sources.length;
    const encodeRangeStart = 8;
    const encodeRangeSpan = 82; // 8% -> 90%

    for (const batch of plan.clipBatches) {
      const clipNum = batch.clipIndex + 1;
      const source = sources[batch.clipIndex];
      if (!source) {
        throw new Error(`Falta la fuente del Clip ${clipNum}/${totalClips}.`);
      }

      const clipStartMs = performance.now();
      const ext = getExtension(source.originalFileName) || '.mp4';
      const rawInputName = `mc_raw_${jobId}_${batch.clipIndex}${ext}`;
      trackedTempFiles.add(rawInputName);

      // Step 1: Lazily fetch ONLY this clip's binary blob (never holding all raw clips in RAM)
      let clipBlob: Blob | null = source.blob ?? null;
      const isLazyDownloaded = !clipBlob && Boolean(source.loadBlob);
      if (!clipBlob && source.loadBlob) {
        onProgress?.({
          percent: Math.round(
            encodeRangeStart + (completedSegments / plan.totalSegments) * encodeRangeSpan
          ),
          message: `Descargando Clip ${clipNum}/${totalClips} (${source.originalFileName})...`,
        });
        clipBlob = await source.loadBlob((pct) => {
          onProgress?.({
            percent: Math.round(
              encodeRangeStart + (completedSegments / plan.totalSegments) * encodeRangeSpan
            ),
            message: `Descargando Clip ${clipNum}/${totalClips} (${pct}%)...`,
          });
        });
      }

      if (!clipBlob) {
        throw new Error(
          `No hay datos de vídeo disponibles para el Clip ${clipNum}/${totalClips} (${source.originalFileName}).`
        );
      }

      const clipMb = Number((clipBlob.size / (1024 * 1024)).toFixed(2));
      onProgress?.({
        percent: Math.round(
          encodeRangeStart + (completedSegments / plan.totalSegments) * encodeRangeSpan
        ),
        message: `Cargando Clip ${clipNum}/${totalClips} en FFmpeg (${clipMb} MB)...`,
      });

      // Write raw clip into MEMFS, then immediately drop JS buffer reference before exec
      let rawBytes: Uint8Array | null = await fetchFile(clipBlob);
      await ffmpeg.writeFile(rawInputName, rawBytes);
      rawBytes = null;
      if (isLazyDownloaded) {
        clipBlob = null;
      }

      logInfo('FFmpeg', `Clip ${clipNum}/${totalClips} cargado`, {
        archivo: source.originalFileName,
        pesoMB: clipMb,
        cortesEnClip: batch.cuts.length,
        calidad: profile.shortLabel,
      });

      let clipSegmentsBytes = 0;

      // Step 2: Encode ONLY the selected segments belonging to this clip
      try {
        for (const cutJob of batch.cuts) {
          trackedTempFiles.add(cutJob.segmentFileName);
          let cutSubFile: string | undefined;

          try {
            cutSubFile = await prepareCutLocalSubtitleFile(
              ffmpeg,
              jobId,
              cutJob.orderIndex,
              cutJob.cut,
              exportQuality,
              renderConfig
            );
            if (cutSubFile) {
              trackedTempFiles.add(cutSubFile);
            }

            currentProgressBase =
              encodeRangeStart + (completedSegments / plan.totalSegments) * encodeRangeSpan;
            currentProgressSpan = encodeRangeSpan / plan.totalSegments;
            currentProgressLabel = `Recortando Clip ${clipNum}/${totalClips} · corte ${completedSegments + 1}/${plan.totalSegments} (${profile.shortLabel})`;

            const basePipelineOptions: FfmpegPipelineOptions = {
              framingMode: opts.framingMode,
              silenceTrimEnabled: opts.silenceTrimEnabled,
              audioNormalizeEnabled: opts.audioNormalizeEnabled,
              preserveOrder: true,
            };

            const runSegmentAttempt = async (
              audioMode: SegmentAudioMode,
              withSubtitles: boolean
            ): Promise<number> => {
              await ffmpeg.deleteFile(cutJob.segmentFileName).catch(() => {});
              const { args } = buildSingleSegmentFfmpegArgs(
                cutJob.cut,
                rawInputName,
                cutJob.segmentFileName,
                audioMode,
                exportQuality,
                {
                  ...basePipelineOptions,
                  subtitleFileName: withSubtitles ? cutSubFile : undefined,
                }
              );
              try {
                return await ffmpeg.exec(args);
              } catch {
                return 1;
              }
            };

            let exitCode = await runSegmentAttempt('source', Boolean(cutSubFile));

            // If subtitle burning failed in wasm, retry cleanly without subtitles
            if (exitCode !== 0 && cutSubFile) {
              exitCode = await runSegmentAttempt('source', false);
            }

            // If this clip has no audio track, inject matching 48kHz stereo silence so concat -c copy stays uniform
            if (exitCode !== 0) {
              exitCode = await runSegmentAttempt('silent', false);
            }

            // Last-resort fallback without audio
            if (exitCode !== 0) {
              exitCode = await runSegmentAttempt('none', false);
            }

            if (exitCode !== 0) {
              throw new Error(
                `FFmpeg.wasm no pudo recortar el Clip ${clipNum}/${totalClips} (${source.originalFileName}). En móvil usa "720p móvil".`
              );
            }

            try {
              const segData = await ffmpeg.readFile(cutJob.segmentFileName);
              if (segData instanceof Uint8Array) {
                clipSegmentsBytes += segData.byteLength;
              }
            } catch {
              // Non-fatal size telemetry check
            }

            completedSegments += 1;
          } finally {
            if (cutSubFile) {
              await ffmpeg.deleteFile(cutSubFile).catch(() => {});
              trackedTempFiles.delete(cutSubFile);
            }
          }
        }
      } finally {
        // Step 3: Immediately free raw clip from MEMFS and JS heap BEFORE touching the next clip
        await ffmpeg.deleteFile(rawInputName).catch(() => {});
        trackedTempFiles.delete(rawInputName);
        clipBlob = null;
        logInfo('FFmpeg', `Bruto ${clipNum}/${totalClips} liberado de RAM`, {
          archivo: source.originalFileName,
        });
      }

      logInfo('FFmpeg', `Clip ${clipNum}/${totalClips} recortado`, {
        archivo: source.originalFileName,
        segmentos: batch.cuts.length,
        segmentosMB: Number((clipSegmentsBytes / (1024 * 1024)).toFixed(2)),
        ms: Math.round(performance.now() - clipStartMs),
      });
    }

    // Step 4: Join all lightweight intermediate segments via concat demuxer with -c copy (zero re-encode!)
    let finalOutputFile = outputName;
    if (plan.orderedSegmentFileNames.length === 1) {
      finalOutputFile = plan.orderedSegmentFileNames[0];
      onProgress?.({ percent: 97, message: 'Empaquetando segmento final...' });
    } else {
      const concatStartMs = performance.now();
      onProgress?.({
        percent: 93,
        message: `Uniendo ${plan.orderedSegmentFileNames.length} segmentos sin recodificar (-c copy)...`,
      });
      logInfo('FFmpeg', `Uniendo ${plan.orderedSegmentFileNames.length} segmentos con concat -c copy`, {
        segmentos: plan.orderedSegmentFileNames.length,
      });

      const listContent = buildConcatListContent(plan.orderedSegmentFileNames);
      await ffmpeg.writeFile(concatListName, new TextEncoder().encode(listContent));

      const concatArgs = buildConcatCopyFfmpegArgs(concatListName, outputName);
      const concatExit = await ffmpeg.exec(concatArgs);
      if (concatExit !== 0) {
        throw new Error(
          'FFmpeg.wasm no pudo unir los segmentos finales con concat -c copy. Prueba el modo "720p móvil".'
        );
      }

      logInfo('FFmpeg', 'Concatenación final (-c copy) completada', {
        segmentos: plan.orderedSegmentFileNames.length,
        ms: Math.round(performance.now() - concatStartMs),
      });
    }

    onProgress?.({ percent: 99, message: 'Empaquetando MP4 combinado...' });
    const data = await ffmpeg.readFile(finalOutputFile);
    const bytes =
      data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(String(data));
    onProgress?.({ percent: 100, message: 'Combinación renderizada correctamente.' });
    return new Blob([bytes.buffer], { type: 'video/mp4' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    await purgeFfmpegVirtualFs(ffmpeg, Array.from(trackedTempFiles));
  }
}

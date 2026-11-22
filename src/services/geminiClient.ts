import type { EditStylePreset, GeminiEditPlan, GeminiModelId } from '../types';
import {
  AI_FRAME_MAX_COUNT,
  AI_MAX_JSON_PAYLOAD_BYTES,
  DEFAULT_GEMINI_MODEL,
  enforceAiPayloadBudget,
  formatBytes,
  formatPhaseError,
  mergeMultiClipEditPlans,
  parseGeminiEditPlan,
  parseHumanReadableApiError,
  sanitizeGeminiModelName,
  type ErrorPhase,
  type ExtractedVideoFrame,
  type PerClipEditPlanResult,
} from '../utils/videoPipeline';
import {
  FrameExtractionError,
  extractLightweightVideoFrames,
} from './frameExtractor';

const ANALYZE_FETCH_TIMEOUT_MS = 75_000;
const HEALTH_FETCH_TIMEOUT_MS = 10_000;

export interface AnalyzeVideoResult {
  plan: GeminiEditPlan;
  geminiFileCleaned: boolean;
  framesAnalyzed?: number;
  payloadBytes?: number;
}

export class GeminiClientError extends Error {
  phase: ErrorPhase;
  technicalDetail?: string;
  actionHint?: 'settings';

  constructor(
    message: string,
    phase: ErrorPhase = 'Análisis IA',
    technicalDetail?: string,
    actionHint?: 'settings'
  ) {
    super(formatPhaseError(phase, message));
    this.name = 'GeminiClientError';
    this.phase = phase;
    this.technicalDetail = technicalDetail;
    this.actionHint = actionHint;
  }
}

export function getDefaultClientGeminiModel(): string {
  const envModel =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.VITE_GEMINI_MODEL as string | undefined)
      : undefined;
  return sanitizeGeminiModelName(envModel, DEFAULT_GEMINI_MODEL);
}

async function fetchRelativeJsonWithTimeout(
  relativePath: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (!relativePath.startsWith('/')) {
    throw new GeminiClientError(
      'URL interna inválida (solo se permiten rutas relativas /api/...).',
      'Análisis IA'
    );
  }

  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(relativePath, {
      ...init,
      credentials: 'same-origin',
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort =
      err instanceof DOMException
        ? err.name === 'AbortError'
        : err instanceof Error && err.name === 'AbortError';

    if (isAbort) {
      const detail = `Timeout tras ${Math.round(timeoutMs / 1000)}s en ${relativePath}`;
      console.error(`[Análisis IA] ${detail}`);
      throw new GeminiClientError(
        `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s) al contactar con el servidor de IA. Comprueba tu conexión e inténtalo de nuevo.`,
        'Análisis IA',
        detail
      );
    }

    const rawMsg = err instanceof Error ? err.message : String(err);
    const parsed = parseHumanReadableApiError(rawMsg);
    console.error(`[Análisis IA] Fallo de red en ${relativePath}:`, err);
    throw new GeminiClientError(
      parsed.userMessage,
      'Análisis IA',
      parsed.technicalDetail || rawMsg,
      parsed.actionHint
    );
  } finally {
    window.clearTimeout(timerId);
  }
}

export interface AnalyzeStyleOptions {
  stylePreset?: EditStylePreset;
  customInstruction?: string;
  subtitlesEnabled?: boolean;
  silenceTrimEnabled?: boolean;
  clipIndex?: number;
}

interface LightweightAnalyzeRequestPayload {
  fileName: string;
  durationSec: number;
  model: string;
  stylePreset?: EditStylePreset;
  customInstruction?: string;
  subtitlesEnabled: boolean;
  silenceTrimEnabled: boolean;
  clipIndex: number;
  frames: ExtractedVideoFrame[];
}

/**
 * Analyzes a single video strictly via lightweight browser-extracted JPEG frames
 * (<= 16 frames, 480px wide, JPEG 0.55, total JSON < 2 MB). Never sends the raw video file.
 */
export async function analyzeVideoWithGemini(
  videoBlob: Blob,
  fileName: string,
  model: GeminiModelId = getDefaultClientGeminiModel(),
  durationSec?: number,
  onStatusUpdate?: (message: string, progress: number) => void,
  styleOptions?: AnalyzeStyleOptions
): Promise<AnalyzeVideoResult> {
  const safeModel = sanitizeGeminiModelName(model, getDefaultClientGeminiModel());

  // 1. Extract lightweight JPEG frames locally in the browser (<video> + <canvas>)
  let extracted;
  try {
    extracted = await extractLightweightVideoFrames(
      videoBlob,
      durationSec,
      (msg, pct) => onStatusUpdate?.(msg, pct)
    );
  } catch (err) {
    if (err instanceof FrameExtractionError) {
      throw new GeminiClientError(err.message, 'Extracción frames', err.technicalDetail);
    }
    const raw = err instanceof Error ? err.message : String(err);
    throw new GeminiClientError(
      'No se pudieron extraer los fotogramas ligeros del vídeo en el navegador.',
      'Extracción frames',
      raw
    );
  }

  const effectiveDuration =
    extracted.durationSec > 0 ? extracted.durationSec : durationSec && durationSec > 0 ? durationSec : 0;

  // 2. Enforce strict <= 16 frames and < 2 MB JSON payload ceiling
  let budgeted;
  try {
    const rawPayload: LightweightAnalyzeRequestPayload = {
      fileName,
      durationSec: effectiveDuration,
      model: safeModel,
      stylePreset: styleOptions?.stylePreset,
      customInstruction: styleOptions?.customInstruction?.trim() || undefined,
      subtitlesEnabled: Boolean(styleOptions?.subtitlesEnabled),
      silenceTrimEnabled: styleOptions?.silenceTrimEnabled !== false,
      clipIndex: styleOptions?.clipIndex ?? 0,
      frames: extracted.frames,
    };
    budgeted = enforceAiPayloadBudget(
      rawPayload,
      AI_MAX_JSON_PAYLOAD_BYTES,
      AI_FRAME_MAX_COUNT
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new GeminiClientError(raw, 'Extracción frames', raw);
  }

  onStatusUpdate?.(
    `Enviando ${budgeted.payload.frames.length} fotogramas ligeros (${formatBytes(budgeted.byteLength)}) a ${safeModel}...`,
    58
  );

  // 3. Call relative /api/gemini/analyze-video endpoint with timeout & JSON response
  const response = await fetchRelativeJsonWithTimeout(
    '/api/gemini/analyze-video',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: budgeted.serializedJson,
    },
    ANALYZE_FETCH_TIMEOUT_MS
  );

  if (!response.ok) {
    let rawErrorText = `Error del servidor (${response.status})`;
    let technicalDetail: string | undefined;
    let actionHint: 'settings' | undefined;

    try {
      const errJson = (await response.json()) as {
        error?: string;
        technicalDetail?: string;
        actionHint?: 'settings';
      };
      if (errJson?.error) rawErrorText = errJson.error;
      if (errJson?.technicalDetail) technicalDetail = errJson.technicalDetail;
      if (errJson?.actionHint) actionHint = errJson.actionHint;
    } catch {
      try {
        const text = await response.text();
        if (text.trim()) rawErrorText = text.trim();
      } catch {
        // Fallback to HTTP status message
      }
    }

    const parsed = parseHumanReadableApiError(rawErrorText);
    const detail = technicalDetail || parsed.technicalDetail;
    if (detail) {
      console.error('[Análisis IA] Detalle del error del servidor:', detail);
    }
    throw new GeminiClientError(
      parsed.userMessage,
      'Análisis IA',
      detail,
      actionHint || parsed.actionHint
    );
  }

  let data: {
    analysis?: unknown;
    geminiFileCleaned?: boolean;
    framesAnalyzed?: number;
    error?: string;
    technicalDetail?: string;
    actionHint?: 'settings';
  };

  try {
    data = (await response.json()) as typeof data;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new GeminiClientError(
      'El servidor devolvió una respuesta incompleta o no válida.',
      'Análisis IA',
      detail
    );
  }

  if (data.error) {
    const parsed = parseHumanReadableApiError(data.error);
    throw new GeminiClientError(
      parsed.userMessage,
      'Análisis IA',
      data.technicalDetail || parsed.technicalDetail,
      data.actionHint || parsed.actionHint
    );
  }

  if (!data.analysis) {
    throw new GeminiClientError(
      'Gemini terminó el análisis sin devolver cortes.',
      'Análisis IA'
    );
  }

  onStatusUpdate?.('Construyendo línea de tiempo editable (EDL)...', 92);

  const plan = parseGeminiEditPlan(data.analysis, {
    maxDurationSec: effectiveDuration > 0 ? effectiveDuration : undefined,
    clipCount: Math.max(1, (styleOptions?.clipIndex ?? 0) + 1),
    subtitlesEnabled: Boolean(styleOptions?.subtitlesEnabled),
  });

  // Ensure clip_index matches the requested clip
  const targetClipIdx = styleOptions?.clipIndex ?? 0;
  const normalizedPlan: GeminiEditPlan = {
    ...plan,
    cortes: plan.cortes.map((cut) => ({ ...cut, clip_index: targetClipIdx })),
    ...(plan.subtitulos
      ? {
          subtitulos: plan.subtitulos.map((sub) => ({
            ...sub,
            clip_index: targetClipIdx,
          })),
        }
      : {}),
  };

  onStatusUpdate?.(
    `Análisis completado (${budgeted.payload.frames.length} fotogramas · ${formatBytes(budgeted.byteLength)}).`,
    100
  );

  return {
    plan: normalizedPlan,
    geminiFileCleaned: Boolean(data.geminiFileCleaned ?? true),
    framesAnalyzed: data.framesAnalyzed ?? budgeted.payload.frames.length,
    payloadBytes: budgeted.byteLength,
  };
}

export interface MultiClipInput {
  blob: Blob;
  fileName: string;
  durationSec?: number;
}

/**
 * Analyzes each clip separately via lightweight JPEG frames (< 2 MB per request)
 * and merges the per-clip edit plans into a single coherent Multi-Clip EDL.
 */
export async function analyzeMultiClipWithGemini(
  clips: MultiClipInput[],
  model: GeminiModelId = getDefaultClientGeminiModel(),
  projectName?: string,
  onStatusUpdate?: (message: string, progress: number) => void,
  styleOptions?: AnalyzeStyleOptions
): Promise<AnalyzeVideoResult> {
  const safeModel = sanitizeGeminiModelName(model, getDefaultClientGeminiModel());
  const perClipResults: PerClipEditPlanResult[] = [];
  let totalFrames = 0;
  let totalPayloadBytes = 0;

  for (let i = 0; i < clips.length; i += 1) {
    const clip = clips[i];
    const clipStartPct = Math.round((i / clips.length) * 90);
    const clipSpanPct = Math.max(10, Math.round(90 / clips.length));

    const result = await analyzeVideoWithGemini(
      clip.blob,
      clip.fileName,
      safeModel,
      clip.durationSec,
      (msg, subPct) => {
        const overall = Math.min(94, clipStartPct + Math.round((subPct / 100) * clipSpanPct));
        onStatusUpdate?.(`Clip ${i + 1}/${clips.length} (${clip.fileName}): ${msg}`, overall);
      },
      {
        ...styleOptions,
        clipIndex: i,
      }
    );

    totalFrames += result.framesAnalyzed ?? 0;
    totalPayloadBytes += result.payloadBytes ?? 0;
    perClipResults.push({
      clipIndex: i,
      fileName: clip.fileName,
      durationSec: clip.durationSec ?? 0,
      plan: result.plan,
    });
  }

  onStatusUpdate?.(`Combinando planes de ${clips.length} clips en una sola historia...`, 96);

  const mergedPlan = mergeMultiClipEditPlans(perClipResults, {
    projectName,
    maxCombinedDurationSec: styleOptions?.stylePreset === 'express_summary' ? 30 : 60,
  });

  onStatusUpdate?.(
    `Plan Multi-Clip completado (${totalFrames} fotogramas analizados por separado).`,
    100
  );

  return {
    plan: mergedPlan,
    geminiFileCleaned: true,
    framesAnalyzed: totalFrames,
    payloadBytes: totalPayloadBytes,
  };
}

export async function checkServerHealth(): Promise<{
  status: string;
  geminiConfigured: boolean;
  defaultModel?: string;
}> {
  try {
    const res = await fetchRelativeJsonWithTimeout(
      '/api/health',
      { method: 'GET' },
      HEALTH_FETCH_TIMEOUT_MS
    );
    if (!res.ok) return { status: 'error', geminiConfigured: false };
    return (await res.json()) as {
      status: string;
      geminiConfigured: boolean;
      defaultModel?: string;
    };
  } catch {
    return { status: 'error', geminiConfigured: false };
  }
}

import type { EditStylePreset, GeminiEditPlan, GeminiModelId } from '../types';
import { parseGeminiEditPlan } from '../utils/videoPipeline';

export interface AnalyzeVideoResult {
  plan: GeminiEditPlan;
  geminiFileCleaned: boolean;
}

async function consumeAnalyzeStream(
  response: Response,
  parseOptions:
    | number
    | {
        maxDurationSec?: number;
        clipCount?: number;
        clipDurationsSec?: number[];
        preserveOrder?: boolean;
        subtitlesEnabled?: boolean;
      }
    | undefined,
  onStatusUpdate?: (message: string, progress: number) => void
): Promise<AnalyzeVideoResult> {
  if (!response.ok) {
    let errorText = `Error del servidor (${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson?.error) errorText = errJson.error;
    } catch {
      // Fallback to status text
    }
    throw new Error(errorText);
  }

  if (!response.body) {
    throw new Error('No se recibió respuesta del análisis de Gemini.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: AnalyzeVideoResult | null = null;

  const phaseProgressMap: Record<string, number> = {
    uploading: 30,
    polling: 55,
    analyzing: 82,
    cleaning: 95,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const event = JSON.parse(line) as {
        type: 'progress' | 'result' | 'error';
        phase?: string;
        message?: string;
        percent?: number;
        analysis?: unknown;
        geminiFileCleaned?: boolean;
        error?: string;
      };

      if (event.type === 'progress') {
        const pct =
          typeof event.percent === 'number'
            ? event.percent
            : event.phase
            ? phaseProgressMap[event.phase] ?? 50
            : 50;
        onStatusUpdate?.(event.message || 'Analizando con Gemini...', pct);
      } else if (event.type === 'error') {
        throw new Error(event.error || 'Error al analizar el vídeo con Gemini.');
      } else if (event.type === 'result') {
        const plan = parseGeminiEditPlan(event.analysis, parseOptions);
        finalResult = {
          plan,
          geminiFileCleaned: Boolean(event.geminiFileCleaned),
        };
      }
    }
  }

  if (!finalResult) {
    throw new Error('El análisis de Gemini terminó sin devolver cortes.');
  }

  onStatusUpdate?.('Análisis completado y archivos temporales limpiados.', 100);
  return finalResult;
}

export interface AnalyzeStyleOptions {
  stylePreset?: EditStylePreset;
  customInstruction?: string;
  subtitlesEnabled?: boolean;
  silenceTrimEnabled?: boolean;
}

export async function analyzeVideoWithGemini(
  videoBlob: Blob,
  fileName: string,
  model: GeminiModelId,
  durationSec?: number,
  onStatusUpdate?: (message: string, progress: number) => void,
  styleOptions?: AnalyzeStyleOptions
): Promise<AnalyzeVideoResult> {
  const formData = new FormData();
  formData.append('video', videoBlob, fileName);
  formData.append('fileName', fileName);
  formData.append('model', model);
  if (durationSec && Number.isFinite(durationSec)) {
    formData.append('durationSec', String(durationSec));
  }
  if (styleOptions?.stylePreset) {
    formData.append('stylePreset', styleOptions.stylePreset);
  }
  if (styleOptions?.customInstruction?.trim()) {
    formData.append('customInstruction', styleOptions.customInstruction.trim());
  }
  formData.append('subtitlesEnabled', String(Boolean(styleOptions?.subtitlesEnabled)));
  formData.append('silenceTrimEnabled', String(styleOptions?.silenceTrimEnabled !== false));

  onStatusUpdate?.('Enviando vídeo al servidor para Gemini Files API...', 12);

  const response = await fetch('/api/gemini/analyze-video', {
    method: 'POST',
    body: formData,
  });

  return consumeAnalyzeStream(
    response,
    {
      maxDurationSec: durationSec,
      subtitlesEnabled: Boolean(styleOptions?.subtitlesEnabled),
    },
    onStatusUpdate
  );
}

export interface MultiClipInput {
  blob: Blob;
  fileName: string;
  durationSec?: number;
}

export async function analyzeMultiClipWithGemini(
  clips: MultiClipInput[],
  model: GeminiModelId,
  projectName?: string,
  onStatusUpdate?: (message: string, progress: number) => void,
  styleOptions?: AnalyzeStyleOptions
): Promise<AnalyzeVideoResult> {
  const formData = new FormData();
  const clipsMeta = clips.map((clip) => ({
    name: clip.fileName,
    durationSec: clip.durationSec ?? 0,
  }));

  clips.forEach((clip) => {
    formData.append('videos', clip.blob, clip.fileName);
  });
  formData.append('model', model);
  formData.append('clipsMeta', JSON.stringify(clipsMeta));
  if (projectName?.trim()) {
    formData.append('projectName', projectName.trim());
  }
  if (styleOptions?.stylePreset) {
    formData.append('stylePreset', styleOptions.stylePreset);
  }
  if (styleOptions?.customInstruction?.trim()) {
    formData.append('customInstruction', styleOptions.customInstruction.trim());
  }
  formData.append('subtitlesEnabled', String(Boolean(styleOptions?.subtitlesEnabled)));
  formData.append('silenceTrimEnabled', String(styleOptions?.silenceTrimEnabled !== false));

  onStatusUpdate?.(`Enviando ${clips.length} clips al servidor para Gemini Files API...`, 8);

  const response = await fetch('/api/gemini/analyze-multi', {
    method: 'POST',
    body: formData,
  });

  return consumeAnalyzeStream(
    response,
    {
      clipCount: clips.length,
      clipDurationsSec: clips.map((c) => c.durationSec ?? 0),
      preserveOrder: true,
      subtitlesEnabled: Boolean(styleOptions?.subtitlesEnabled),
    },
    onStatusUpdate
  );
}

export async function checkServerHealth(): Promise<{ status: string; geminiConfigured: boolean }> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return { status: 'error', geminiConfigured: false };
    return (await res.json()) as { status: string; geminiConfigured: boolean };
  } catch {
    return { status: 'error', geminiConfigured: false };
  }
}

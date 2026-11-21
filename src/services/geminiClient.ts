import type { GeminiEditPlan, GeminiModelId } from '../types';
import { parseGeminiEditPlan } from '../utils/videoPipeline';

export interface AnalyzeVideoResult {
  plan: GeminiEditPlan;
  geminiFileCleaned: boolean;
}

export async function analyzeVideoWithGemini(
  videoBlob: Blob,
  fileName: string,
  model: GeminiModelId,
  durationSec?: number,
  onStatusUpdate?: (message: string, progress: number) => void
): Promise<AnalyzeVideoResult> {
  const formData = new FormData();
  formData.append('video', videoBlob, fileName);
  formData.append('fileName', fileName);
  formData.append('model', model);
  if (durationSec && Number.isFinite(durationSec)) {
    formData.append('durationSec', String(durationSec));
  }

  onStatusUpdate?.('Enviando vídeo al servidor para Gemini Files API...', 12);

  const response = await fetch('/api/gemini/analyze-video', {
    method: 'POST',
    body: formData,
  });

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
        analysis?: unknown;
        geminiFileCleaned?: boolean;
        error?: string;
      };

      if (event.type === 'progress') {
        const pct = event.phase ? phaseProgressMap[event.phase] ?? 50 : 50;
        onStatusUpdate?.(event.message || 'Analizando con Gemini...', pct);
      } else if (event.type === 'error') {
        throw new Error(event.error || 'Error al analizar el vídeo con Gemini.');
      } else if (event.type === 'result') {
        const plan = parseGeminiEditPlan(event.analysis, durationSec);
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

  onStatusUpdate?.('Análisis completado y archivo temporal limpiado.', 100);
  return finalResult;
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

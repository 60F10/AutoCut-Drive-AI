import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import {
  AI_FRAME_MAX_COUNT,
  AI_MAX_JSON_PAYLOAD_BYTES,
  DEFAULT_GEMINI_MODEL,
  buildGeminiSystemPrompt,
  formatPhaseError,
  normalizeStylePreset,
  parseHumanReadableApiError,
  sanitizeGeminiModelName,
} from './src/utils/videoPipeline.ts';
import {
  findMatchingWorkflowRun,
  isValidJobFileId,
  type GitHubWorkflowRunLike,
} from './src/utils/remoteJobsSync.ts';

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_SERVER_GEMINI_MODEL = sanitizeGeminiModelName(
  process.env.GEMINI_MODEL || process.env.VITE_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL
);

const JOB_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DISPATCH_RATE_LIMIT_MAX = 10;
const DISPATCH_RATE_WINDOW_MS = 60_000;
const dispatchRequestTimestamps: number[] = [];

function getCloudRenderServerConfig(): {
  configured: boolean;
  token: string;
  repo: string;
  ref: string;
} {
  const token = (process.env.GITHUB_DISPATCH_TOKEN || '').trim();
  const repo = (process.env.GITHUB_REPO || '').trim();
  const ref = (process.env.GITHUB_REF || 'main').trim() || 'main';
  const configured = Boolean(token && GITHUB_REPO_PATTERN.test(repo));
  return { configured, token, repo, ref };
}

function consumeDispatchRateLimitSlot(nowMs = Date.now()): boolean {
  while (
    dispatchRequestTimestamps.length > 0 &&
    nowMs - dispatchRequestTimestamps[0] >= DISPATCH_RATE_WINDOW_MS
  ) {
    dispatchRequestTimestamps.shift();
  }
  if (dispatchRequestTimestamps.length >= DISPATCH_RATE_LIMIT_MAX) {
    return false;
  }
  dispatchRequestTimestamps.push(nowMs);
  return true;
}

function humanizeGitHubDispatchError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Token de GitHub inválido o sin permisos de Actions (Read & Write). Revisa GITHUB_DISPATCH_TOKEN en Settings > Secrets.';
  }
  if (status === 404) {
    return 'No se encontró el repositorio o el workflow cloud-render.yml en GitHub. Verifica GITHUB_REPO y que el archivo exista en la rama.';
  }
  if (status === 422) {
    return 'GitHub rechazó el disparo del workflow (revisa GITHUB_REF o la definición de inputs en cloud-render.yml).';
  }
  if (status === 429) {
    return 'GitHub Actions ha limitado temporalmente las peticiones. Espera unos segundos y reintenta.';
  }
  return `GitHub Actions devolvió un error inesperado (HTTP ${status}).`;
}

function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY no está configurada en el entorno del servidor. Configúrala en Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function buildCutResponseSchema(includeSubtitles: boolean) {
  const properties: Record<string, unknown> = {
    etiqueta: {
      type: Type.STRING,
      description:
        'Una sola palabra en mayúsculas sin tildes que identifique el contenido (ej: COCINA, VLOG, RECETA, FAIL, COCHE, VIAJE).',
    },
    titulo_interno: {
      type: Type.STRING,
      description: 'Resumen breve y gracioso del vídeo editado.',
    },
    duracion_objetivo_seg: {
      type: Type.NUMBER,
      description: 'Duración objetivo aproximada en segundos del vídeo final.',
    },
    cortes: {
      type: Type.ARRAY,
      description: 'Lista ordenada de fragmentos seleccionados para el jump cut.',
      items: {
        type: Type.OBJECT,
        properties: {
          clip_index: {
            type: Type.INTEGER,
            description: 'Índice entero (0, 1, 2...) del clip de vídeo de origen.',
          },
          start_sec: {
            type: Type.NUMBER,
            description: 'Segundo de inicio del corte con precisión decimal.',
          },
          end_sec: {
            type: Type.NUMBER,
            description: 'Segundo de fin del corte con precisión decimal.',
          },
          motivo: {
            type: Type.STRING,
            description: 'Motivo breve por el que se conserva este fragmento.',
          },
          puntuacion_interes: {
            type: Type.INTEGER,
            description: 'Puntuación de interés/gancho del 1 al 10 para TikTok/Reels.',
          },
        },
        required: ['clip_index', 'start_sec', 'end_sec', 'motivo', 'puntuacion_interes'],
      },
    },
  };

  const required = ['etiqueta', 'titulo_interno', 'duracion_objetivo_seg', 'cortes'];

  if (includeSubtitles) {
    properties.subtitulos = {
      type: Type.ARRAY,
      description:
        'Bloques breves de subtítulos (2-5 palabras) sincronizados con los cortes seleccionados.',
      items: {
        type: Type.OBJECT,
        properties: {
          clip_index: {
            type: Type.INTEGER,
            description: 'Índice entero del clip de vídeo de origen.',
          },
          start_sec: {
            type: Type.NUMBER,
            description: 'Segundo de inicio de la frase en el vídeo bruto.',
          },
          end_sec: {
            type: Type.NUMBER,
            description: 'Segundo de fin de la frase en el vídeo bruto.',
          },
          text: {
            type: Type.STRING,
            description: 'Texto breve y legible del subtítulo (2 a 5 palabras).',
          },
        },
        required: ['clip_index', 'start_sec', 'end_sec', 'text'],
      },
    };
    required.push('subtitulos');
  }

  return {
    type: Type.OBJECT,
    properties,
    required,
  };
}

interface IncomingFramePayload {
  timestampSec?: unknown;
  dataBase64?: unknown;
  mimeType?: unknown;
}

async function startServer() {
  const app = express();

  // Lightweight JSON body parser (raw videos are NEVER sent to the server)
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    const cloudConfig = getCloudRenderServerConfig();
    res.json({
      status: 'ok',
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      cloudRenderConfigured: cloudConfig.configured,
      defaultModel: DEFAULT_SERVER_GEMINI_MODEL,
      maxFrames: AI_FRAME_MAX_COUNT,
      maxPayloadBytes: AI_MAX_JSON_PAYLOAD_BYTES,
    });
  });

  // Dispatches the GitHub Actions `cloud-render.yml` workflow via repository workflow_dispatch
  app.post('/api/cloud-render/dispatch', async (req, res) => {
    try {
      const rawJobFileId =
        typeof req.body?.jobFileId === 'string' ? req.body.jobFileId.trim() : '';

      if (!JOB_FILE_ID_PATTERN.test(rawJobFileId)) {
        res.status(400).json({
          error: 'El identificador jobFileId no es válido.',
        });
        return;
      }

      if (!consumeDispatchRateLimitSlot()) {
        res.status(429).json({
          error:
            'Has alcanzado el límite de 10 envíos a la nube por minuto. Espera unos segundos e inténtalo de nuevo.',
        });
        return;
      }

      const cloudConfig = getCloudRenderServerConfig();
      if (!cloudConfig.configured) {
        res.status(503).json({
          error:
            'El render en la nube no está configurado en el servidor. Añade GITHUB_DISPATCH_TOKEN y GITHUB_REPO en Settings > Secrets.',
          actionHint: 'settings',
        });
        return;
      }

      const dispatchUrl = `https://api.github.com/repos/${cloudConfig.repo}/actions/workflows/cloud-render.yml/dispatches`;
      const ghRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudConfig.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'autocut-drive-ai',
        },
        body: JSON.stringify({
          ref: cloudConfig.ref,
          inputs: {
            job_file_id: rawJobFileId,
          },
        }),
      });

      if (ghRes.status === 204) {
        res.status(202).json({
          ok: true,
          status: 'dispatched',
          jobFileId: rawJobFileId,
        });
        return;
      }

      const statusCode = ghRes.status >= 400 && ghRes.status < 600 ? ghRes.status : 502;
      res.status(statusCode).json({
        error: humanizeGitHubDispatchError(ghRes.status),
        githubStatus: ghRes.status,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Error de red al contactar con GitHub.';
      console.error('[Nube] Error en /api/cloud-render/dispatch:', msg);
      res.status(502).json({
        error:
          'No se pudo contactar con la API de GitHub Actions. Comprueba la conexión y vuelve a intentarlo.',
      });
    }
  });

  // Inspects recent GitHub Actions runs for cloud-render.yml to detect stuck/failed workflows
  app.get('/api/cloud-render/status', async (req, res) => {
    try {
      const rawJobFileId =
        typeof req.query?.jobFileId === 'string' ? req.query.jobFileId.trim() : '';

      if (!isValidJobFileId(rawJobFileId)) {
        res.status(400).json({
          error: 'El identificador jobFileId no es válido.',
        });
        return;
      }

      const cloudConfig = getCloudRenderServerConfig();
      if (!cloudConfig.configured) {
        res.status(503).json({
          error:
            'El render en la nube no está configurado en el servidor. Añade GITHUB_DISPATCH_TOKEN y GITHUB_REPO en Settings > Secrets.',
          actionHint: 'settings',
        });
        return;
      }

      const runsUrl = `https://api.github.com/repos/${cloudConfig.repo}/actions/workflows/cloud-render.yml/runs?event=workflow_dispatch&per_page=20`;
      const ghRes = await fetch(runsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cloudConfig.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'autocut-drive-ai',
        },
      });

      if (!ghRes.ok) {
        const statusCode = ghRes.status >= 400 && ghRes.status < 600 ? ghRes.status : 502;
        res.status(statusCode).json({
          error: humanizeGitHubDispatchError(ghRes.status),
          githubStatus: ghRes.status,
        });
        return;
      }

      const data = (await ghRes.json()) as { workflow_runs?: GitHubWorkflowRunLike[] };
      const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
      const matched = findMatchingWorkflowRun(runs, rawJobFileId);

      res.json({
        status: matched.status,
        conclusion: matched.conclusion,
        htmlUrl: matched.htmlUrl,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Error de red al contactar con GitHub.';
      console.error('[Nube] Error en /api/cloud-render/status:', msg);
      res.status(502).json({
        error: 'No se pudo consultar el estado del workflow en GitHub Actions.',
      });
    }
  });

  // Lightweight storyboard frame analysis endpoint (never receives raw .MOV/.MP4 video files)
  app.post('/api/gemini/analyze-video', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        fileName?: unknown;
        durationSec?: unknown;
        model?: unknown;
        stylePreset?: unknown;
        customInstruction?: unknown;
        subtitlesEnabled?: unknown;
        silenceTrimEnabled?: unknown;
        clipIndex?: unknown;
        frames?: unknown;
      };

      const rawFrames = Array.isArray(body.frames) ? (body.frames as IncomingFramePayload[]) : [];
      if (rawFrames.length === 0) {
        res.status(400).json({
          error: formatPhaseError(
            'Extracción frames',
            'No se recibieron fotogramas para analizar el vídeo.'
          ),
        });
        return;
      }

      if (rawFrames.length > AI_FRAME_MAX_COUNT) {
        res.status(400).json({
          error: formatPhaseError(
            'Extracción frames',
            `Se recibieron demasiados fotogramas (${rawFrames.length}). El máximo permitido es ${AI_FRAME_MAX_COUNT}.`
          ),
        });
        return;
      }

      const validFrames = rawFrames
        .map((frame) => {
          const ts = Number(frame?.timestampSec);
          const rawB64 = typeof frame?.dataBase64 === 'string' ? frame.dataBase64.trim() : '';
          const dataBase64 = rawB64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '');
          const mimeType =
            typeof frame?.mimeType === 'string' && frame.mimeType.startsWith('image/')
              ? frame.mimeType
              : 'image/jpeg';
          return {
            timestampSec: Number.isFinite(ts) && ts >= 0 ? Number(ts.toFixed(2)) : 0,
            dataBase64,
            mimeType,
          };
        })
        .filter((f) => f.dataBase64.length > 32);

      if (validFrames.length === 0) {
        res.status(400).json({
          error: formatPhaseError(
            'Extracción frames',
            'Los fotogramas enviados están vacíos o dañados.'
          ),
        });
        return;
      }

      const model = sanitizeGeminiModelName(body.model, DEFAULT_SERVER_GEMINI_MODEL);
      const stylePreset = normalizeStylePreset(body.stylePreset);
      const customInstruction =
        typeof body.customInstruction === 'string'
          ? body.customInstruction.trim().slice(0, 400)
          : '';
      const subtitlesEnabled = body.subtitlesEnabled === true || body.subtitlesEnabled === 'true';
      const silenceTrimEnabled =
        body.silenceTrimEnabled !== false && body.silenceTrimEnabled !== 'false';
      const durationSec = Math.max(0, Number(body.durationSec) || 0);
      const clipIndex = Math.max(0, Math.floor(Number(body.clipIndex) || 0));
      const originalName =
        typeof body.fileName === 'string' && body.fileName.trim()
          ? body.fileName.trim().slice(0, 140)
          : 'video.mp4';

      const ai = createGeminiClient();

      const contentsParts: Array<string | { inlineData: { mimeType: string; data: string } }> = [];
      const frameTimelineSummary: string[] = [];

      for (const frame of validFrames) {
        const label = `Fotograma en t=${frame.timestampSec.toFixed(2)}s`;
        frameTimelineSummary.push(`${frame.timestampSec.toFixed(2)}s`);
        contentsParts.push(label);
        contentsParts.push({
          inlineData: {
            mimeType: frame.mimeType,
            data: frame.dataBase64,
          },
        });
      }

      const durationHint =
        durationSec > 0
          ? `La duración total real del vídeo bruto es de ${durationSec.toFixed(2)} segundos (de 0.00s a ${durationSec.toFixed(2)}s).`
          : 'Estima la duración según las marcas de tiempo de los fotogramas adjuntos.';

      const instructionNote = customInstruction
        ? `\nInstrucción rápida adicional del usuario: "${customInstruction}".`
        : '';

      const subtitleNote = subtitlesEnabled
        ? '\nComo los subtítulos están activados, propone bloques cortos de subtítulos visuales/narrativos (2-5 palabras) sincronizados con los momentos clave de cada corte.'
        : '';

      const userPrompt = `Analiza esta secuencia de ${validFrames.length} fotogramas extraídos del vídeo bruto (Clip ${clipIndex}: "${originalName}").
${durationHint}
Marcas de tiempo muestreadas: ${frameTimelineSummary.join(', ')}.
Usa siempre "clip_index": ${clipIndex} en cada corte.
Propón entre 2 y 7 cortes concretos (con "start_sec" y "end_sec" estrictamente dentro de [0, ${
        durationSec > 0 ? durationSec.toFixed(2) : validFrames[validFrames.length - 1].timestampSec.toFixed(2)
      }]) que capturen las escenas más dinámicas, expresivas o interesantes siguiendo el estilo del sistema y respetando estrictamente el esquema JSON.${subtitleNote}${instructionNote}`;

      contentsParts.push(userPrompt);

      const systemInstruction = buildGeminiSystemPrompt('single', stylePreset, customInstruction, {
        subtitlesEnabled,
        silenceTrimEnabled,
      });

      const response = await ai.models.generateContent({
        model,
        contents: contentsParts,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: buildCutResponseSchema(subtitlesEnabled),
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        throw new Error('Gemini devolvió una respuesta vacía al analizar los fotogramas.');
      }

      const parsed = JSON.parse(rawText);

      res.json({
        analysis: parsed,
        geminiFileCleaned: true,
        framesAnalyzed: validFrames.length,
        model,
      });
    } catch (error: unknown) {
      const parsedError = parseHumanReadableApiError(error);
      console.error('[Análisis IA] Error en /api/gemini/analyze-video:', error);
      res.status(500).json({
        error: formatPhaseError('Análisis IA', parsedError.userMessage),
        technicalDetail: parsedError.technicalDetail,
        actionHint: parsedError.actionHint,
      });
    }
  });

  // Explicit handler for oversized JSON requests so we always return clean JSON instead of HTML
  app.use(
    (
      err: { status?: number; type?: string; message?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err?.type === 'entity.too.large' || err?.status === 413) {
        res.status(413).json({
          error: formatPhaseError(
            'Extracción frames',
            'El paquete de fotogramas superó el límite del servidor. Reintenta con menos fotogramas.'
          ),
          technicalDetail: err.message,
        });
        return;
      }
      next(err);
    }
  );

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AutoCut Drive AI server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

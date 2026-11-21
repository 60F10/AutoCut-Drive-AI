import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { GoogleGenAI, Type, createPartFromUri } from '@google/genai';

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro']);

const SYSTEM_PROMPT = `Eres un editor de vídeo experto en contenido vertical (Reels/TikTok/Shorts) de estilo natural, dinámico y gracioso. Tu objetivo es transformar un vídeo bruto en una pieza ágil mediante cortes secos (jump cuts), eliminando TODOS los silencios, pausas muertas, tiempos de espera y partes aburridas.
Reglas de edición:

Mantén una narrativa clara: inicio rápido con gancho -> desarrollo con el momento cómico, improviso o problema/fail cotidiano -> remate final gracioso o reacción.

Prioriza frases espontáneas, quejas cómicas, risas, gestos expresivos y acciones clave visuales.

Duración adaptativa: si el bruto dura menos de 2-3 minutos, apunta a un vídeo final de unos 30 segundos. Si el bruto es más largo (3 a 10 minutos), apunta a unos 45-60 segundos.

Los cortes deben ser precisos al decimal para que no se corten palabras a medias.

Genera una etiqueta corta de 1 palabra en mayúsculas sin tildes que identifique el contenido (ej: COCINA, VLOG, RECETA, FAIL, COCHE, VIAJE).`;

const uploadDir = path.join(os.tmpdir(), 'autocut-drive-ai-uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname || '.mp4').replace(/[^a-zA-Z0-9.]/g, '') || '.mp4';
      cb(null, `raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 600 * 1024 * 1024, // 600 MB max temp file
  },
});

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

function writeNdjson(res: express.Response, payload: Record<string, unknown>) {
  res.write(`${JSON.stringify(payload)}\n`);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  app.post('/api/gemini/analyze-video', upload.single('video'), async (req, res) => {
    const tempFile = req.file;
    if (!tempFile) {
      res.status(400).json({ error: 'No se recibió ningún archivo de vídeo.' });
      return;
    }

    const requestedModel = typeof req.body?.model === 'string' ? req.body.model : 'gemini-2.5-flash';
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-2.5-flash';
    const durationSec = Number(req.body?.durationSec) || 0;
    const originalName = typeof req.body?.fileName === 'string' ? req.body.fileName : tempFile.originalname;
    const mimeType = tempFile.mimetype && tempFile.mimetype.startsWith('video/')
      ? tempFile.mimetype
      : 'video/mp4';

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let uploadedGeminiFileName: string | null = null;
    let ai: GoogleGenAI | null = null;

    try {
      ai = createGeminiClient();

      writeNdjson(res, {
        type: 'progress',
        phase: 'uploading',
        message: 'Subiendo vídeo a Gemini Files API (resumable upload)...',
      });

      const uploaded = await ai.files.upload({
        file: tempFile.path,
        config: {
          mimeType,
          displayName: originalName.slice(0, 120),
        },
      });

      if (!uploaded.name) {
        throw new Error('La Gemini Files API no devolvió un identificador de archivo.');
      }
      uploadedGeminiFileName = uploaded.name;

      writeNdjson(res, {
        type: 'progress',
        phase: 'polling',
        message: 'Esperando a que Gemini procese el vídeo (estado ACTIVE)...',
      });

      let fileInfo = await ai.files.get({ name: uploadedGeminiFileName });
      const maxAttempts = 80;
      let attempts = 0;

      while (fileInfo.state === 'PROCESSING' && attempts < maxAttempts) {
        attempts += 1;
        await sleep(2500);
        fileInfo = await ai.files.get({ name: uploadedGeminiFileName });
        writeNdjson(res, {
          type: 'progress',
          phase: 'polling',
          message: `Procesando vídeo en Gemini (${attempts * 2.5}s)...`,
        });
      }

      if (fileInfo.state !== 'ACTIVE' || !fileInfo.uri) {
        throw new Error(
          `El archivo en Gemini Files API no alcanzó el estado ACTIVE (estado actual: ${fileInfo.state ?? 'desconocido'}).`
        );
      }

      writeNdjson(res, {
        type: 'progress',
        phase: 'analyzing',
        message: `Analizando ritmo, pausas y momentos cómicos con ${model}...`,
      });

      const durationHint =
        durationSec > 0
          ? `La duración total aproximada del vídeo bruto es de ${durationSec.toFixed(1)} segundos.`
          : 'Analiza la duración real del vídeo adjunto.';

      const userPrompt = `Analiza este vídeo bruto llamado "${originalName}". ${durationHint}
Selecciona los mejores momentos para crear un vídeo corto vertical súper ágil mediante jump cuts, eliminando todos los silencios, pausas muertas y tiempos de espera.
Asegúrate de que todos los timestamps start_sec y end_sec estén ordenados cronológicamente, no se solapen, y respeten palabras completas al decimal.`;

      const response = await ai.models.generateContent({
        model,
        contents: [
          createPartFromUri(fileInfo.uri, fileInfo.mimeType || mimeType),
          userPrompt,
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
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
                description: 'Lista cronológica de fragmentos seleccionados para el jump cut.',
                items: {
                  type: Type.OBJECT,
                  properties: {
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
                  },
                  required: ['start_sec', 'end_sec', 'motivo'],
                },
              },
            },
            required: ['etiqueta', 'titulo_interno', 'duracion_objetivo_seg', 'cortes'],
          },
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        throw new Error('Gemini devolvió una respuesta vacía al analizar el vídeo.');
      }

      const parsed = JSON.parse(rawText);

      writeNdjson(res, {
        type: 'progress',
        phase: 'cleaning',
        message: 'Limpiando archivo temporal de Gemini Files API...',
      });

      let cleaned = false;
      if (uploadedGeminiFileName && ai) {
        try {
          await ai.files.delete({ name: uploadedGeminiFileName });
          uploadedGeminiFileName = null;
          cleaned = true;
        } catch (cleanupErr) {
          console.warn('No se pudo eliminar el archivo temporal de Gemini:', cleanupErr);
        }
      }

      writeNdjson(res, {
        type: 'result',
        analysis: parsed,
        geminiFileCleaned: cleaned,
      });
      res.end();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error inesperado al analizar el vídeo con Gemini.';
      console.error('[Gemini Analyze Error]:', error);

      if (uploadedGeminiFileName && ai) {
        try {
          await ai.files.delete({ name: uploadedGeminiFileName });
        } catch {
          // Best-effort cleanup on failure
        }
      }

      writeNdjson(res, {
        type: 'error',
        error: message,
      });
      res.end();
    } finally {
      if (tempFile?.path) {
        fs.promises.unlink(tempFile.path).catch(() => {});
      }
    }
  });

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

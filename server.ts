import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { GoogleGenAI, Type, createPartFromUri } from '@google/genai';
import {
  buildGeminiSystemPrompt,
  normalizeStylePreset,
} from './src/utils/videoPipeline';

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro']);

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
    fileSize: 600 * 1024 * 1024, // 600 MB per file
    files: 12,
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

async function waitForGeminiFileActive(
  ai: GoogleGenAI,
  fileName: string,
  onPoll?: (secondsElapsed: number) => void
) {
  let fileInfo = await ai.files.get({ name: fileName });
  const maxAttempts = 80;
  let attempts = 0;

  while (fileInfo.state === 'PROCESSING' && attempts < maxAttempts) {
    attempts += 1;
    await sleep(2500);
    fileInfo = await ai.files.get({ name: fileName });
    onPoll?.(attempts * 2.5);
  }

  if (fileInfo.state !== 'ACTIVE' || !fileInfo.uri) {
    throw new Error(
      `El archivo en Gemini Files API no alcanzó el estado ACTIVE (estado actual: ${fileInfo.state ?? 'desconocido'}).`
    );
  }

  return fileInfo;
}

const CUT_RESPONSE_SCHEMA = {
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
        },
        required: ['clip_index', 'start_sec', 'end_sec', 'motivo'],
      },
    },
  },
  required: ['etiqueta', 'titulo_interno', 'duracion_objetivo_seg', 'cortes'],
};

async function startServer() {
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // Single-clip Gemini analysis
  app.post('/api/gemini/analyze-video', upload.single('video'), async (req, res) => {
    const tempFile = req.file;
    if (!tempFile) {
      res.status(400).json({ error: 'No se recibió ningún archivo de vídeo.' });
      return;
    }

    const requestedModel = typeof req.body?.model === 'string' ? req.body.model : 'gemini-2.5-flash';
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-2.5-flash';
    const stylePreset = normalizeStylePreset(req.body?.stylePreset);
    const customInstruction =
      typeof req.body?.customInstruction === 'string'
        ? req.body.customInstruction.trim().slice(0, 400)
        : '';
    const durationSec = Number(req.body?.durationSec) || 0;
    const originalName = typeof req.body?.fileName === 'string' ? req.body.fileName : tempFile.originalname;
    const mimeType =
      tempFile.mimetype && tempFile.mimetype.startsWith('video/')
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

      const fileInfo = await waitForGeminiFileActive(ai, uploadedGeminiFileName, (elapsed) => {
        writeNdjson(res, {
          type: 'progress',
          phase: 'polling',
          message: `Procesando vídeo en Gemini (${elapsed}s)...`,
        });
      });

      writeNdjson(res, {
        type: 'progress',
        phase: 'analyzing',
        message: `Analizando ritmo, pausas y momentos cómicos con ${model}...`,
      });

      const durationHint =
        durationSec > 0
          ? `La duración total aproximada del vídeo bruto es de ${durationSec.toFixed(1)} segundos.`
          : 'Analiza la duración real del vídeo adjunto.';

      const instructionNote = customInstruction
        ? `\nInstrucción rápida adicional del usuario: "${customInstruction}".`
        : '';

      const userPrompt = `Analiza este vídeo bruto (Clip 0: "${originalName}"). ${durationHint}
Usa siempre "clip_index": 0 en cada corte.
Selecciona los mejores momentos siguiendo el estilo indicado en las instrucciones del sistema y respetando estrictamente el esquema JSON.${instructionNote}`;

      const systemInstruction = buildGeminiSystemPrompt('single', stylePreset, customInstruction);

      const response = await ai.models.generateContent({
        model,
        contents: [
          createPartFromUri(fileInfo.uri!, fileInfo.mimeType || mimeType),
          userPrompt,
        ],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: CUT_RESPONSE_SCHEMA,
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
          // Best-effort cleanup
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

  // Multi-clip Gemini analysis (combines multiple raw videos into one jump-cut story)
  app.post('/api/gemini/analyze-multi', upload.array('videos', 12), async (req, res) => {
    const tempFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (tempFiles.length === 0) {
      res.status(400).json({ error: 'No se recibieron archivos de vídeo para combinar.' });
      return;
    }

    const requestedModel = typeof req.body?.model === 'string' ? req.body.model : 'gemini-2.5-flash';
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'gemini-2.5-flash';
    const stylePreset = normalizeStylePreset(req.body?.stylePreset);
    const customInstruction =
      typeof req.body?.customInstruction === 'string'
        ? req.body.customInstruction.trim().slice(0, 400)
        : '';
    const projectName = typeof req.body?.projectName === 'string' ? req.body.projectName.trim() : '';

    let clipMetadata: Array<{ name?: string; durationSec?: number }> = [];
    try {
      if (typeof req.body?.clipsMeta === 'string') {
        clipMetadata = JSON.parse(req.body.clipsMeta);
      }
    } catch {
      clipMetadata = [];
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const uploadedGeminiFileNames: string[] = [];
    let ai: GoogleGenAI | null = null;

    try {
      ai = createGeminiClient();

      // 1. Upload every clip via Gemini Files API (resumable upload)
      const uploadedMeta: Array<{
        index: number;
        geminiName: string;
        displayName: string;
        mimeType: string;
        durationSec: number;
      }> = [];

      for (let idx = 0; idx < tempFiles.length; idx += 1) {
        const file = tempFiles[idx];
        const displayName = clipMetadata[idx]?.name || file.originalname || `clip_${idx}.mp4`;
        const durationSec = Number(clipMetadata[idx]?.durationSec) || 0;
        const mimeType =
          file.mimetype && file.mimetype.startsWith('video/') ? file.mimetype : 'video/mp4';

        writeNdjson(res, {
          type: 'progress',
          phase: 'uploading',
          message: `Subiendo Clip ${idx + 1}/${tempFiles.length} (${displayName}) a Gemini Files API...`,
          percent: Math.round(10 + ((idx + 0.5) / tempFiles.length) * 30),
        });

        const uploaded = await ai.files.upload({
          file: file.path,
          config: {
            mimeType,
            displayName: displayName.slice(0, 120),
          },
        });

        if (!uploaded.name) {
          throw new Error(`Gemini Files API no devolvió identificador para Clip ${idx}.`);
        }

        uploadedGeminiFileNames.push(uploaded.name);
        uploadedMeta.push({
          index: idx,
          geminiName: uploaded.name,
          displayName,
          mimeType,
          durationSec,
        });
      }

      // 2. Poll until EVERY uploaded file is ACTIVE
      const activeParts: Array<{ uri: string; mimeType: string; index: number; displayName: string; durationSec: number }> = [];
      for (let idx = 0; idx < uploadedMeta.length; idx += 1) {
        const meta = uploadedMeta[idx];
        writeNdjson(res, {
          type: 'progress',
          phase: 'polling',
          message: `Esperando estado ACTIVE para Clip ${idx + 1}/${uploadedMeta.length} (${meta.displayName})...`,
          percent: Math.round(42 + ((idx + 1) / uploadedMeta.length) * 24),
        });

        const activeInfo = await waitForGeminiFileActive(ai, meta.geminiName);
        activeParts.push({
          uri: activeInfo.uri!,
          mimeType: activeInfo.mimeType || meta.mimeType,
          index: meta.index,
          displayName: meta.displayName,
          durationSec: meta.durationSec,
        });
      }

      // 3. Build multi-clip prompt and contents array with explicit Clip 0, Clip 1... markers
      writeNdjson(res, {
        type: 'progress',
        phase: 'analyzing',
        message: `Construyendo historia combinada de ${activeParts.length} clips con ${model}...`,
        percent: 78,
      });

      const contentsParts: Array<ReturnType<typeof createPartFromUri> | string> = [];
      const clipIndexSummary: string[] = [];

      for (const clip of activeParts) {
        const durLabel = clip.durationSec > 0 ? ` (~${clip.durationSec.toFixed(1)}s)` : '';
        const header = `Clip ${clip.index}: ${clip.displayName}${durLabel}`;
        clipIndexSummary.push(`- ${header}`);
        contentsParts.push(header);
        contentsParts.push(createPartFromUri(clip.uri, clip.mimeType));
      }

      const projectContext = projectName ? `Nombre del proyecto: "${projectName}".\n` : '';
      const instructionNote = customInstruction
        ? `\nInstrucción rápida adicional del usuario: "${customInstruction}".`
        : '';

      contentsParts.push(
        `${projectContext}Aquí tienes ${activeParts.length} vídeos brutos:\n${clipIndexSummary.join('\n')}\n\n` +
          `Combina y ordena los mejores fragmentos de todos los clips siguiendo el estilo indicado en las instrucciones del sistema. ` +
          `Recuerda devolver "clip_index" (0 a ${activeParts.length - 1}), "start_sec", "end_sec" y "motivo" en cada corte.${instructionNote}`
      );

      const systemInstruction = buildGeminiSystemPrompt('multi', stylePreset, customInstruction);

      const response = await ai.models.generateContent({
        model,
        contents: contentsParts,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: CUT_RESPONSE_SCHEMA,
        },
      });

      const rawText = response.text?.trim();
      if (!rawText) {
        throw new Error('Gemini devolvió una respuesta vacía en el análisis Multi-Clip.');
      }

      const parsed = JSON.parse(rawText);

      // 4. Clean up ALL temporary files from Gemini Files API
      writeNdjson(res, {
        type: 'progress',
        phase: 'cleaning',
        message: `Eliminando ${uploadedGeminiFileNames.length} archivos temporales de Gemini Files API...`,
        percent: 94,
      });

      let cleanedCount = 0;
      for (const fileName of uploadedGeminiFileNames) {
        try {
          await ai.files.delete({ name: fileName });
          cleanedCount += 1;
        } catch (cleanupErr) {
          console.warn(`No se pudo borrar ${fileName} de Gemini Files API:`, cleanupErr);
        }
      }
      uploadedGeminiFileNames.length = 0;

      writeNdjson(res, {
        type: 'result',
        analysis: parsed,
        geminiFileCleaned: cleanedCount === activeParts.length,
      });
      res.end();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Error inesperado en el análisis Multi-Clip.';
      console.error('[Gemini Multi-Clip Error]:', error);

      if (ai && uploadedGeminiFileNames.length > 0) {
        await Promise.allSettled(
          uploadedGeminiFileNames.map((name) => ai!.files.delete({ name }))
        );
      }

      writeNdjson(res, {
        type: 'error',
        error: message,
      });
      res.end();
    } finally {
      await Promise.allSettled(
        tempFiles.map((f) => fs.promises.unlink(f.path).catch(() => {}))
      );
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

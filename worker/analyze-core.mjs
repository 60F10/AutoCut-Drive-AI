/**
 * AutoCut Drive AI — Cloud Multimodal Video Analysis Core (Node 20+, zero deps)
 *
 * Pipeline:
 * 1. Extract 16kHz mono WAV per clip -> run `worker/transcribe.py` (or reuse Drive cache)
 * 2. Split Whisper word-level transcript into addressable sentences `C{clip}-F{nnn}`
 * 3. Generate lightweight 640p 2fps + 48kbps mono proxy per clip & upload to Gemini Files API
 * 4. Phase A (per clip): Gemini watches video + audio proxy with numbered sentences
 * 5. Phase B (global): Gemini writes a cohesive vertical story script across all clips
 * 6. Deterministic conversion: phrase/recurso -> exact timestamps, silence sub-cuts (> 0.45 s),
 *    target duration trimming (±15 %)
 * 7. Phase C (review): Coherence audit; if `coherente: false`, re-runs Phase B once with feedback
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  fileHasAudioStream,
  resolveFfprobeBin,
  runProcess,
  summarizeFfmpegError,
} from './render-core.mjs';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
const RETRY_DELAYS_MS = [2000, 5000, 15000];
const VALID_FUNCTIONS = new Set([
  'gancho',
  'contexto',
  'desarrollo',
  'climax',
  'remate',
  'cierre',
  'recurso',
]);

const SENTENCE_GAP_SEC = 0.7;
const PHRASE_PRE_MARGIN_SEC = 0.12;
const PHRASE_POST_MARGIN_SEC = 0.25;
const SILENCE_SPLIT_GAP_SEC = 0.45;
const SILENCE_SUBCUT_MARGIN_SEC = 0.08;
const MIN_SUBCUT_DURATION_SEC = 0.35;
const RECURSO_MIN_SEC = 1.0;
const RECURSO_MAX_SEC = 4.0;

const PRESET_GUIDANCE = {
  funny_jumpcut:
    'Estilo GRACIOSO / JUMP-CUT: ritmo ágil, prioriza comentarios divertidos, reacciones, improvisos y remates cómicos; corta pausas y rodeos sin piedad.',
  agile_vlog:
    'Estilo VLOG ÁGIL: narrativa fluida y cercana con contexto claro de qué ocurre y adónde vamos, transiciones limpias y cierre redondo.',
  express_summary:
    'Estilo RESUMEN EXPRÉS: máximo valor informativo en poco tiempo, directo al grano, priorizando momentos clave y conclusiones claras.',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round3(n) {
  return Number((Number(n) || 0).toFixed(3));
}

export function sanitizeTag(rawTag) {
  const cleaned = String(rawTag || 'GENERAL')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)[0];
  return cleaned || 'GENERAL';
}

export function sanitizeModelName(model, fallback = 'gemini-3.8-flash') {
  const cleaned = String(model || '')
    .trim()
    .replace(/^models\//i, '');
  if (!cleaned || !/^[a-zA-Z0-9._-]{3,80}$/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

export function normalizeWhisperDevice(raw, fallback = 'cpu') {
  const cleaned = String(raw || '').trim().toLowerCase();
  if (cleaned === 'auto' || cleaned === 'cuda' || cleaned === 'cpu') {
    return cleaned;
  }
  return fallback;
}

export function buildTranscriptCacheFilename(driveFileId, modifiedTime = '') {
  const safeId = String(driveFileId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const safeMod = String(modifiedTime || 'nomod').replace(/[^A-Za-z0-9_-]/g, '_');
  return `transcript_${safeId}_${safeMod}.json`;
}

/**
 * Atomic double-read job claim shared by `pc-worker.mjs` and `cloud-worker.mjs`:
 * 1. Re-read the manifest and verify `status === "pending"` (and optional `canClaim`).
 * 2. Write `status: "processing"`, `claimedBy: "pc" | "cloud"`, and `claimedAt` (ISO).
 * 3. Re-read the manifest and confirm `claimedBy` and `claimedAt` match before proceeding.
 */
export async function claimJobAtomically({
  readManifest,
  writeManifest,
  workerId,
  canClaim,
  extraPatch,
  nowIso,
}) {
  const latest = await readManifest();
  if (!latest || typeof latest !== 'object') {
    return { claimed: false, manifest: latest ?? null };
  }
  if (latest.status !== 'pending') {
    return { claimed: false, manifest: latest };
  }
  if (typeof canClaim === 'function' && !canClaim(latest)) {
    return { claimed: false, manifest: latest };
  }

  const claimedAt =
    typeof nowIso === 'function'
      ? nowIso()
      : typeof nowIso === 'string' && nowIso.trim()
      ? nowIso.trim()
      : new Date().toISOString();

  const candidate = {
    ...latest,
    ...(extraPatch && typeof extraPatch === 'object' ? extraPatch : {}),
    status: 'processing',
    claimedBy: workerId,
    claimedAt,
    errorMessage: undefined,
  };
  delete candidate.errorMessage;

  await writeManifest(candidate);

  const confirmed = await readManifest();
  const matched = Boolean(
    confirmed &&
      typeof confirmed === 'object' &&
      confirmed.status === 'processing' &&
      confirmed.claimedBy === workerId &&
      confirmed.claimedAt === claimedAt
  );

  return {
    claimed: matched,
    manifest: confirmed ?? null,
    claimedAt,
  };
}

/**
 * Splits a Whisper transcript JSON into sentence units with deterministic IDs `C{clip}-F{nnn}`.
 * Cuts a sentence after `.`, `?`, `!` or whenever the silence gap between consecutive words > 0.7 s.
 */
export function splitTranscriptIntoSentences(transcript, clipIndex) {
  const safeClipIdx = Math.max(0, Number(clipIndex) || 0);
  const clipNumber = safeClipIdx + 1;
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];

  const allWords = [];
  for (const seg of segments) {
    const segWords = Array.isArray(seg?.words) ? seg.words : [];
    if (segWords.length > 0) {
      for (const w of segWords) {
        const text = String(w?.text || '').trim();
        const start = Number(w?.start);
        const end = Number(w?.end);
        if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
        allWords.push({
          start: round3(Math.max(0, start)),
          end: round3(Math.max(start, end)),
          text,
          prob: Number.isFinite(Number(w?.prob)) ? Number(w.prob) : 1,
        });
      }
    } else if (typeof seg?.text === 'string' && seg.text.trim()) {
      // Graceful fallback if a segment has no word timestamps
      const start = Number(seg.start);
      const end = Number(seg.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        allWords.push({
          start: round3(Math.max(0, start)),
          end: round3(Math.max(start, end)),
          text: seg.text.trim(),
          prob: 1,
        });
      }
    }
  }

  allWords.sort((a, b) => a.start - b.start || a.end - b.end);

  const sentences = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    const seq = sentences.length + 1;
    sentences.push({
      id: `C${clipNumber}-F${String(seq).padStart(3, '0')}`,
      clipIndex: safeClipIdx,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.text).join(' '),
      words: current.map((w) => ({ start: w.start, end: w.end, text: w.text })),
    });
    current = [];
  };

  for (const word of allWords) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      if (word.start - prev.end > SENTENCE_GAP_SEC) {
        flush();
      }
    }

    current.push(word);

    // Close sentence after terminal punctuation (., ?, !) optionally followed by quotes/closing brackets
    if (/[.?!]["'»)\]]*$/.test(word.text)) {
      flush();
    }
  }

  flush();
  return sentences;
}

/**
 * Formats sentences for Gemini prompts: `C2-F014 [83.42–88.10] "texto"`.
 */
export function formatSentencesForPrompt(sentences) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return '(Sin voz detectada en este clip)';
  }
  return sentences
    .map(
      (s) =>
        `${s.id} [${Number(s.start).toFixed(2)}–${Number(s.end).toFixed(2)}] "${s.text.replace(/"/g, "'")}"`
    )
    .join('\n');
}

/**
 * Computes chronological clip order from `creationTimeMs` metadata.
 * Falls back cleanly to user order when creation timestamps are missing.
 */
export function sortClipsChronologically(clipsMeta) {
  if (!Array.isArray(clipsMeta) || clipsMeta.length === 0) return [];
  const hasAnyTimestamp = clipsMeta.some((c) => Number.isFinite(c?.creationTimeMs));
  if (!hasAnyTimestamp) {
    return clipsMeta.map((c, idx) => (Number.isInteger(c?.originalIndex) ? c.originalIndex : idx));
  }

  return [...clipsMeta]
    .map((c, idx) => ({
      originalIndex: Number.isInteger(c?.originalIndex) ? c.originalIndex : idx,
      creationTimeMs: Number.isFinite(c?.creationTimeMs) ? c.creationTimeMs : null,
    }))
    .sort((a, b) => {
      if (a.creationTimeMs !== null && b.creationTimeMs !== null) {
        if (a.creationTimeMs !== b.creationTimeMs) return a.creationTimeMs - b.creationTimeMs;
        return a.originalIndex - b.originalIndex;
      }
      if (a.creationTimeMs !== null) return -1;
      if (b.creationTimeMs !== null) return 1;
      return a.originalIndex - b.originalIndex;
    })
    .map((c) => c.originalIndex);
}

/**
 * Probes clip duration and QuickTime/MP4 creation timestamp via ffprobe.
 */
export async function probeClipMediaInfo(ffprobeBin, clipPath) {
  try {
    const res = await runProcess(ffprobeBin, [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags=creation_time,com.apple.quicktime.creationdate:stream_tags=creation_time',
      '-of',
      'json',
      clipPath,
    ]);
    if (res.code !== 0) {
      return { durationSec: 0, creationTimeIso: null, creationTimeMs: null };
    }
    const parsed = JSON.parse(res.stdout || '{}');
    const durationSec = Math.max(0, Number(parsed?.format?.duration) || 0);
    const fmtTags = parsed?.format?.tags || {};
    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const streamCreation = streams.find((s) => s?.tags?.creation_time)?.tags?.creation_time;

    const rawDate =
      fmtTags['com.apple.quicktime.creationdate'] ||
      fmtTags['COM.APPLE.QUICKTIME.CREATIONDATE'] ||
      fmtTags.creation_time ||
      streamCreation ||
      null;

    const parsedMs = rawDate ? Date.parse(String(rawDate)) : NaN;
    return {
      durationSec: round3(durationSec),
      creationTimeIso: Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : null,
      creationTimeMs: Number.isFinite(parsedMs) ? parsedMs : null,
    };
  } catch {
    return { durationSec: 0, creationTimeIso: null, creationTimeMs: null };
  }
}

/**
 * Extracts 16 kHz mono PCM WAV from `0:a:0` for faster-whisper.
 */
export async function extractAudioWavForWhisper(ffmpegBin, inputPath, outputWavPath) {
  const res = await runProcess(ffmpegBin, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputWavPath,
  ]);
  if (res.code !== 0) {
    throw new Error(`No se pudo extraer audio WAV para Whisper: ${summarizeFfmpegError(res.stderr)}`);
  }
  return outputWavPath;
}

/**
 * Creates a lightweight 640p 2 fps + 48 kbps mono proxy MP4 for Gemini video+audio understanding.
 */
export async function createGeminiProxyVideo(ffmpegBin, inputPath, outputProxyPath, hasAudio = true) {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0'] : []),
    '-vf',
    'scale=-2:640,fps=2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '32',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '48k', '-ac', '1'] : ['-an']),
    '-movflags',
    '+faststart',
    outputProxyPath,
  ];
  const res = await runProcess(ffmpegBin, args);
  if (res.code !== 0) {
    throw new Error(`No se pudo generar proxy para Gemini: ${summarizeFfmpegError(res.stderr)}`);
  }
  return outputProxyPath;
}

/**
 * Runs `worker/transcribe.py` via Python 3 and returns parsed transcript JSON.
 */
export async function runWhisperTranscription({
  pythonBin = process.env.AUTOCUT_PYTHON_BIN || 'python3',
  scriptPath,
  wavPath,
  outJsonPath,
  whisperModel = 'small',
  whisperDevice = normalizeWhisperDevice(process.env.WHISPER_DEVICE, 'cpu'),
  whisperComputeType = '',
  lang = 'es',
  onWhisperFallbackCpu,
}) {
  const device = normalizeWhisperDevice(whisperDevice, 'cpu');
  const args = [
    scriptPath,
    '--in',
    wavPath,
    '--out',
    outJsonPath,
    '--model',
    whisperModel,
    '--lang',
    lang,
    '--device',
    device,
  ];
  if (whisperComputeType && String(whisperComputeType).trim()) {
    args.push('--compute-type', String(whisperComputeType).trim());
  }

  const res = await runProcess(pythonBin, args);
  if (typeof res.stderr === 'string' && res.stderr.includes('fallback-cpu')) {
    if (typeof onWhisperFallbackCpu === 'function') {
      await onWhisperFallbackCpu();
    }
  }
  if (res.code !== 0) {
    throw new Error(`Fallo en Whisper (${whisperModel}): ${summarizeFfmpegError(res.stderr)}`);
  }
  const raw = await fsp.readFile(outJsonPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * HTTP fetch with exponential backoff (2 s, 5 s, 15 s) on 429 / 500 / 503 or transient network errors.
 */
export async function fetchWithRetry(url, init = {}, retryDelaysMs = RETRY_DELAYS_MS) {
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status === 500 || res.status === 503) && attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
    }
  }
  throw lastError || new Error('Error de red al conectar con Gemini.');
}

/**
 * Uploads a proxy MP4 to Gemini Files API using the resumable protocol and waits for `state === "ACTIVE"`.
 */
export async function uploadProxyToGeminiFilesApi(apiKey, filePath, displayName = 'autocut_proxy') {
  const stat = await fsp.stat(filePath);
  const numBytes = stat.size;
  if (numBytes <= 0) {
    throw new Error('[Análisis IA] El vídeo proxy para Gemini está vacío.');
  }

  // 1. Start resumable upload session
  const startRes = await fetchWithRetry(`${GEMINI_API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  if (!startRes.ok) {
    throw new Error(`[Análisis IA] Error iniciando subida a Gemini Files API (HTTP ${startRes.status}).`);
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('[Análisis IA] Gemini Files API no devolvió x-goog-upload-url.');
  }

  // 2. Upload proxy bytes & finalize
  const fileBuffer = await fsp.readFile(filePath);
  const uploadRes = await fetchWithRetry(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`[Análisis IA] Error subiendo proxy a Gemini Files API (HTTP ${uploadRes.status}).`);
  }

  const uploadedData = await uploadRes.json();
  const fileObj = uploadedData?.file || uploadedData;
  const fileName = fileObj?.name;
  let fileUri = fileObj?.uri;
  let state = fileObj?.state || 'PROCESSING';

  if (!fileName || !fileUri) {
    throw new Error('[Análisis IA] Respuesta incompleta de Gemini Files API al subir proxy.');
  }

  // 3. Poll until state === ACTIVE (up to 4 minutes)
  const deadline = Date.now() + 4 * 60 * 1000;
  while (state !== 'ACTIVE') {
    if (state === 'FAILED') {
      throw new Error('[Análisis IA] Gemini no pudo procesar el vídeo proxy (state=FAILED).');
    }
    if (Date.now() > deadline) {
      throw new Error('[Análisis IA] Tiempo de espera agotado esperando activación en Gemini Files API.');
    }
    await sleep(2500);
    const pollRes = await fetchWithRetry(`${GEMINI_API_BASE}/v1beta/${fileName}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!pollRes.ok) {
      throw new Error(`[Análisis IA] Error consultando estado de archivo en Gemini (HTTP ${pollRes.status}).`);
    }
    const pollData = await pollRes.json();
    const polled = pollData?.file || pollData;
    state = polled?.state || state;
    if (polled?.uri) fileUri = polled.uri;
  }

  return { name: fileName, uri: fileUri, mimeType: 'video/mp4' };
}

export async function deleteGeminiUploadedFile(apiKey, fileName) {
  if (!apiKey || !fileName) return;
  try {
    await fetch(`${GEMINI_API_BASE}/v1beta/${fileName}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey },
    });
  } catch {
    // Best-effort cleanup
  }
}

function extractGeminiJsonText(responseJson) {
  const parts = responseJson?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('[Análisis IA] Gemini devolvió una respuesta vacía.');
  }
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) {
    throw new Error('[Análisis IA] Gemini no devolvió contenido JSON.');
  }
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    throw new Error('[Análisis IA] La respuesta JSON de Gemini no es válida.');
  }
}

export async function callGeminiGenerateContent({
  apiKey,
  model,
  systemInstruction,
  parts,
  responseSchema,
  mediaResolution = 'MEDIA_RESOLUTION_LOW',
}) {
  const cleanModel = sanitizeModelName(model);
  const isGemini4 = /^gemini-4-/i.test(cleanModel);

  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema,
    ...(mediaResolution ? { mediaResolution } : {}),
    ...(isGemini4 ? {} : { temperature: 0.4 }),
  };

  const payload = {
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) {
        reason = `HTTP ${res.status}: ${String(errJson.error.message).slice(0, 180)}`;
      }
    } catch {
      // ignore
    }
    throw new Error(`[Análisis IA] Error en Gemini (${cleanModel}): ${reason}`);
  }

  const data = await res.json();
  return extractGeminiJsonText(data);
}

// ---------- Gemini JSON Schemas for Phases A, B, C ----------

const PHASE_A_SCHEMA = {
  type: 'OBJECT',
  properties: {
    resumen: { type: 'STRING' },
    lugar: { type: 'STRING' },
    momentos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          desde: { type: 'NUMBER' },
          hasta: { type: 'NUMBER' },
          tipo: { type: 'STRING', enum: ['habla', 'visual', 'transicion'] },
          descripcion: { type: 'STRING' },
          energia: { type: 'INTEGER' },
          calidad: { type: 'STRING', enum: ['ok', 'movido', 'oscuro', 'desenfocado'] },
        },
        required: ['desde', 'hasta', 'tipo', 'descripcion', 'energia', 'calidad'],
      },
    },
    frases_destacadas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id_frase: { type: 'STRING' },
          puntuacion: { type: 'INTEGER' },
          por_que: { type: 'STRING' },
        },
        required: ['id_frase', 'puntuacion', 'por_que'],
      },
    },
  },
  required: ['resumen', 'lugar', 'momentos', 'frases_destacadas'],
};

export const PHASE_B_SCHEMA = {
  type: 'OBJECT',
  properties: {
    titulo: { type: 'STRING' },
    etiqueta: { type: 'STRING' },
    gancho: { type: 'STRING' },
    historia: { type: 'STRING' },
    segmentos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tipo: { type: 'STRING', enum: ['frases', 'recurso'] },
          desde_frase: {
            type: 'STRING',
            description:
              'ID de frase existente en la transcripción con formato exacto C{clip}-F{nnn} (ej. C1-F004), o vacío solo si funcion es "recurso".',
          },
          hasta_frase: {
            type: 'STRING',
            description:
              'ID de frase existente del mismo clip con formato exacto C{clip}-F{nnn} (>= desde_frase), o vacío solo si funcion es "recurso".',
          },
          clip_index: { type: 'INTEGER' },
          desde: { type: 'NUMBER' },
          hasta: { type: 'NUMBER' },
          funcion: {
            type: 'STRING',
            enum: ['gancho', 'contexto', 'desarrollo', 'climax', 'remate', 'cierre', 'recurso'],
          },
          motivo: { type: 'STRING' },
        },
        required: ['tipo', 'funcion', 'motivo'],
      },
    },
    guion_resultante: { type: 'STRING' },
  },
  required: ['titulo', 'etiqueta', 'gancho', 'historia', 'segmentos', 'guion_resultante'],
};

const PHASE_C_SCHEMA = {
  type: 'OBJECT',
  properties: {
    coherente: { type: 'BOOLEAN' },
    problemas: { type: 'ARRAY', items: { type: 'STRING' } },
    cambios: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['coherente', 'problemas', 'cambios'],
};

// ---------- Phase A: Per-Clip Multimodal Logging ----------

export async function runPhaseAClipLog({
  apiKey,
  model,
  clipIndex,
  durationSec,
  fileUri,
  sentences,
}) {
  const clipNum = clipIndex + 1;
  const transcriptText = formatSentencesForPrompt(sentences);
  const prompt = `Analiza el Clip ${clipNum} (duración ${durationSec.toFixed(1)} s) viendo el vídeo con audio y usando esta transcripción numerada real:

${transcriptText}

Devuelve un registro estructurado en español con:
- resumen: 1 o 2 frases describiendo qué pasa realmente en este clip.
- lugar: escenario/ubicación visible (ej. "cocina", "calle", "coche", "playa").
- momentos[]: intervalos relevantes (habla, visual o transicion) con desde/hasta en segundos, descripcion breve, energia (1-10) y calidad ("ok", "movido", "oscuro", "desenfocado").
- frases_destacadas[]: las frases más potentes usando EXCLUSIVAMENTE los IDs existentes arriba (ej. C${clipNum}-F001), con puntuacion (1-10) y por_que (gracioso, información clave, reacción, remate, gancho...).

REGLA ESTRICTA: NO inventes frases ni IDs. Referencia únicamente IDs presentes en la lista anterior.`;

  return callGeminiGenerateContent({
    apiKey,
    model,
    systemInstruction:
      'Eres un documentalista y editor de vídeo experto en formatos cortos verticales. Registras con precisión visual y narrativa lo que ocurre en cada clip sin inventar texto ni IDs.',
    parts: [
      { fileData: { fileUri, mimeType: 'video/mp4' } },
      { text: prompt },
    ],
    responseSchema: PHASE_A_SCHEMA,
    mediaResolution: 'MEDIA_RESOLUTION_LOW',
  });
}

// ---------- Phase B: Global Cohesive Story Script ----------

export function buildPhaseBSystemInstruction(stylePreset) {
  const presetText = PRESET_GUIDANCE[stylePreset] || PRESET_GUIDANCE.funny_jumpcut;
  return `Eres editor de vídeo vertical para TikTok/Reels. Construye UNA historia con sentido a partir de todos los clips. Estructura: GANCHO (0-3 s, la frase o imagen más potente; puedes adelantar un momento posterior) → CONTEXTO (qué está pasando y adónde vamos) → DESARROLLO (lo mejor de lo que se cuenta, en orden cronológico) → CLÍMAX o momento más gracioso → REMATE/CIERRE. Reglas: usa frases completas, nunca cortes una frase a la mitad; una idea por corte; elimina repeticiones y divagaciones; los planos sin voz (\`recurso\`) duran 1-4 s y sirven de transición entre lugares; respeta la duración objetivo ±15 %; cada corte debe hacer avanzar la historia. Si la instrucción del usuario pide algo concreto, prevalece.

${presetText}

REGLA DE IDENTIDAD: Para segmentos de tipo "frases", usa EXCLUSIVAMENTE IDs exactos (desde_frase y hasta_frase) de la lista de frases numeradas proporcionada, ambos pertenecientes al mismo clip y con hasta_frase >= desde_frase. Nunca inventes IDs. Para segmentos "recurso", indica clip_index (0-based), desde y hasta en segundos (1-4 s).`;
}

export async function runPhaseBGlobalScript({
  apiKey,
  model,
  stylePreset,
  customInstruction,
  targetDurationSec,
  orderedClipIndices,
  clipLogsByIndex,
  sentencesByClip,
  clipDurations,
  revisionFeedback = null,
}) {
  const sections = orderedClipIndices.map((clipIdx, chronoPos) => {
    const log = clipLogsByIndex.get(clipIdx) || {};
    const sentences = sentencesByClip.get(clipIdx) || [];
    const dur = clipDurations[clipIdx] || 0;
    const momentsText = Array.isArray(log.momentos) && log.momentos.length > 0
      ? log.momentos
          .map(
            (m) =>
              `  - [${Number(m.desde || 0).toFixed(1)}–${Number(m.hasta || 0).toFixed(1)}s] (${m.tipo}, energía ${m.energia}/10, ${m.calidad}): ${m.descripcion}`
          )
          .join('\n')
      : '  - (Sin momentos registrados)';

    const featuredText = Array.isArray(log.frases_destacadas) && log.frases_destacadas.length > 0
      ? log.frases_destacadas
          .map((f) => `  - ${f.id_frase} (${f.puntuacion}/10): ${f.por_que}`)
          .join('\n')
      : '  - (Sin frases destacadas)';

    return `=== CLIP (clip_index=${clipIdx}, orden cronológico #${chronoPos + 1}, duración ${dur.toFixed(1)}s) ===
Lugar: ${log.lugar || 'desconocido'}
Resumen: ${log.resumen || 'Sin resumen'}
Momentos visuales/habla:
${momentsText}
Frases destacadas:
${featuredText}
Frases numeradas completas:
${formatSentencesForPrompt(sentences)}`;
  });

  const userDirectiveBlock = customInstruction?.trim()
    ? `\nINSTRUCCIÓN PRIORITARIA DEL USUARIO (prevalece sobre todo lo demás):\n${customInstruction.trim()}\n`
    : '';

  const feedbackBlock = revisionFeedback
    ? `\nFEEDBACK DE REVISIÓN (CORRIGE ESTOS PROBLEMAS EN ESTA NUEVA VERSIÓN):\nProblemas detectados:\n${(revisionFeedback.problemas || [])
        .map((p) => `- ${p}`)
        .join('\n')}\nCambios sugeridos:\n${(revisionFeedback.cambios || [])
        .map((c) => `- ${c}`)
        .join('\n')}\n`
    : '';

  const userPrompt = `Monta el guion global definitivo para un vídeo vertical de aproximadamente ${targetDurationSec} segundos (±15 %, es decir entre ${Math.round(
    targetDurationSec * 0.85
  )} s y ${Math.round(targetDurationSec * 1.15)} s).
${userDirectiveBlock}${feedbackBlock}
Material disponible en orden cronológico:

${sections.join('\n\n')}

Devuelve JSON con:
- titulo: título atractivo en español.
- etiqueta: 1 sola palabra en MAYÚSCULAS sin tildes (ej. VIAJE, COCINA, VLOG, HUMOR).
- gancho: la frase o momento gancho elegido para los primeros 0-3 s.
- historia: resumen narrativo de 3 a 5 líneas explicando principio, nudo y final.
- segmentos[]: lista ordenada de montaje ("frases" con desde_frase y hasta_frase exactos, o "recurso" con clip_index, desde y hasta de 1 a 4 s), cada uno con funcion y motivo.
- guion_resultante: texto completo seguido de lo que se oirá en el vídeo final.`;

  return callGeminiGenerateContent({
    apiKey,
    model,
    systemInstruction: buildPhaseBSystemInstruction(stylePreset),
    parts: [{ text: userPrompt }],
    responseSchema: PHASE_B_SCHEMA,
    mediaResolution: 'MEDIA_RESOLUTION_LOW',
  });
}

// ---------- Deterministic Segment-to-Cut Conversion ----------

/**
 * Splits a word list into sub-cuts whenever silence gap between adjacent words exceeds 0.45 s.
 * Discards sub-cuts shorter than 0.35 s.
 */
export function splitWordsBySilencePauses({
  words,
  cutStartSec,
  cutEndSec,
  minBoundSec,
  maxBoundSec,
}) {
  if (!Array.isArray(words) || words.length === 0) {
    return [{ start_sec: round3(cutStartSec), end_sec: round3(cutEndSec), words: [] }];
  }

  const groups = [];
  let currentGroup = [words[0]];

  for (let i = 1; i < words.length; i += 1) {
    const prev = words[i - 1];
    const curr = words[i];
    if (curr.start - prev.end > SILENCE_SPLIT_GAP_SEC) {
      groups.push(currentGroup);
      currentGroup = [curr];
    } else {
      currentGroup.push(curr);
    }
  }
  groups.push(currentGroup);

  if (groups.length === 1) {
    return [
      {
        start_sec: round3(cutStartSec),
        end_sec: round3(cutEndSec),
        words,
      },
    ];
  }

  const subCuts = [];
  for (let gIdx = 0; gIdx < groups.length; gIdx += 1) {
    const group = groups[gIdx];
    const isFirst = gIdx === 0;
    const isLast = gIdx === groups.length - 1;
    const rawStart = isFirst ? cutStartSec : group[0].start - SILENCE_SUBCUT_MARGIN_SEC;
    const rawEnd = isLast
      ? cutEndSec
      : group[group.length - 1].end + SILENCE_SUBCUT_MARGIN_SEC;

    const clampedStart = round3(Math.max(minBoundSec, rawStart));
    const clampedEnd = round3(Math.min(maxBoundSec, rawEnd));
    if (clampedEnd - clampedStart < MIN_SUBCUT_DURATION_SEC) {
      continue;
    }

    const groupWords = group.filter((w) => w.start >= clampedStart - 0.001 && w.end <= clampedEnd + 0.001);
    subCuts.push({
      start_sec: clampedStart,
      end_sec: clampedEnd,
      words: groupWords.length > 0 ? groupWords : group,
    });
  }

  return subCuts;
}

/**
 * Enforces `targetDurationSec ± 15%`:
 * - If total > +15 %, removes lowest-scored `"desarrollo"` cuts first (then `"recurso"`, then `"contexto"`).
 * - If total < -15 %, records a clear Spanish note.
 */
export function enforceTargetDuration(cuts, targetDurationSec) {
  const target = Math.max(10, Number(targetDurationSec) || 45);
  const maxSec = target * 1.15;
  const minSec = target * 0.85;
  const notes = [];

  const working = [...cuts];
  const calcTotal = (list) =>
    list.reduce((sum, c) => sum + Math.max(0, (Number(c.end_sec) || 0) - (Number(c.start_sec) || 0)), 0);

  const removalPriority = ['desarrollo', 'recurso', 'contexto'];

  while (calcTotal(working) > maxSec && working.length > 1) {
    let victimIdx = -1;

    for (const funcName of removalPriority) {
      let lowestScore = Infinity;
      for (let i = 0; i < working.length; i += 1) {
        if (working[i].funcion !== funcName) continue;
        const score = Number(working[i].puntuacion_interes) || 5;
        if (score < lowestScore) {
          lowestScore = score;
          victimIdx = i;
        }
      }
      if (victimIdx !== -1) break;
    }

    if (victimIdx === -1) {
      // Fallback: remove lowest-scored non-gancho cut
      let lowestScore = Infinity;
      for (let i = 0; i < working.length; i += 1) {
        if (working[i].funcion === 'gancho' && working.length > 2) continue;
        const score = Number(working[i].puntuacion_interes) || 5;
        if (score < lowestScore) {
          lowestScore = score;
          victimIdx = i;
        }
      }
    }

    if (victimIdx === -1) break;
    working.splice(victimIdx, 1);
  }

  const finalTotal = round3(calcTotal(working));
  if (finalTotal < minSec) {
    notes.push(
      `La duración resultante (${finalTotal.toFixed(1)} s) queda por debajo del objetivo (${target} s ±15 %) con el material sólido disponible.`
    );
  }

  return {
    cuts: working,
    duracionTotalSec: finalTotal,
    notes,
  };
}

export const PHASE_B_MAX_DISCARD_RATIO = 0.3;

function parseOptionalFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * Tolerant deterministic converter from Gemini Phase B segments (`frases` / `recurso`) into `PlanCut[]`.
 * Evaluates every segment, routes empty-ID `funcion: "recurso"` segments through the visual resource path
 * when clip + timestamps are valid, discards invalid entries without aborting the entire script, and
 * returns human-readable Spanish `validationNotes` plus discard metrics for guided Phase B retry.
 */
export function convertPlanSegmentsToCuts({
  segmentos,
  sentencesByClip,
  clipDurations,
  featuredScoresById = new Map(),
  silenceTrimEnabled = true,
  targetDurationSec = 45,
}) {
  const safeSegmentos = Array.isArray(segmentos) ? segmentos : [];
  const totalSegments = safeSegmentos.length;

  // Index every sentence by ID and its position within its clip
  const sentenceLookup = new Map();
  for (const [clipIdx, list] of sentencesByClip.entries()) {
    for (let pos = 0; pos < list.length; pos += 1) {
      sentenceLookup.set(list[pos].id, {
        clipIndex: clipIdx,
        pos,
        sentence: list[pos],
      });
    }
  }

  const rawCuts = [];
  const invalidSegments = [];
  const invalidIdsSet = new Set();
  const validationNotes = [];
  let cutCounter = 1;

  const recordDiscard = ({ index, reason, note, invalidId, tipo, funcion }) => {
    invalidSegments.push({
      index,
      reason,
      invalidId: invalidId ?? null,
      tipo: tipo ?? null,
      funcion: funcion ?? null,
    });
    if (invalidId !== undefined && invalidId !== null) {
      invalidIdsSet.add(String(invalidId));
    }
    if (note) {
      validationNotes.push(note);
    }
  };

  for (let segIdx = 0; segIdx < safeSegmentos.length; segIdx += 1) {
    const seg = safeSegmentos[segIdx];
    const tipo = seg?.tipo;
    const funcion = VALID_FUNCTIONS.has(seg?.funcion) ? seg.funcion : 'desarrollo';
    const motivo = String(seg?.motivo || 'Momento seleccionado').trim();

    const startId = String(seg?.desde_frase || '').trim();
    const rawEndId = String(seg?.hasta_frase || '').trim();
    const routeAsRecurso = tipo === 'recurso' || (funcion === 'recurso' && !startId);

    if (routeAsRecurso) {
      const rawClip = seg?.clip_index;
      const clipIndex =
        rawClip !== undefined && rawClip !== null && rawClip !== '' ? Number(rawClip) : NaN;
      const validClip =
        Number.isInteger(clipIndex) && clipIndex >= 0 && clipIndex < clipDurations.length;

      if (!validClip) {
        recordDiscard({
          index: segIdx,
          reason: 'recurso_clip_invalido',
          note: 'Se descartó 1 corte de recurso sin clip válido.',
          tipo,
          funcion,
        });
        continue;
      }

      const clipDur = Math.max(0, Number(clipDurations[clipIndex]) || 0);
      const rawStart = parseOptionalFiniteNumber(seg?.desde ?? seg?.start_sec);
      const rawEnd = parseOptionalFiniteNumber(seg?.hasta ?? seg?.end_sec);

      if (
        clipDur < 0.5 ||
        !Number.isFinite(rawStart) ||
        !Number.isFinite(rawEnd) ||
        rawStart < 0 ||
        rawEnd <= rawStart ||
        rawStart >= clipDur
      ) {
        recordDiscard({
          index: segIdx,
          reason: 'recurso_tiempos_invalidos',
          note: 'Se descartó 1 corte de recurso sin clip o tiempos válidos.',
          tipo,
          funcion,
        });
        continue;
      }

      let startSec = Math.max(0, Math.min(clipDur - 0.5, rawStart));
      let endSec = Math.min(clipDur, rawEnd);

      // Enforce 1..4 s window inside [0, clipDur]
      if (endSec - startSec > RECURSO_MAX_SEC) {
        endSec = startSec + RECURSO_MAX_SEC;
      }
      if (endSec - startSec < RECURSO_MIN_SEC) {
        endSec = Math.min(clipDur, startSec + RECURSO_MIN_SEC);
        if (endSec - startSec < RECURSO_MIN_SEC) {
          startSec = Math.max(0, endSec - RECURSO_MIN_SEC);
        }
      }
      endSec = Math.min(clipDur, endSec);
      if (endSec - startSec < 0.5) {
        recordDiscard({
          index: segIdx,
          reason: 'recurso_duracion_insuficiente',
          note: 'Se descartó 1 corte de recurso sin tiempos válidos suficientes.',
          tipo,
          funcion,
        });
        continue;
      }

      rawCuts.push({
        id: `cut-${String(cutCounter++).padStart(3, '0')}`,
        clip_index: clipIndex,
        start_sec: round3(startSec),
        end_sec: round3(endSec),
        funcion: funcion === 'gancho' || funcion === 'cierre' ? funcion : 'recurso',
        motivo,
        texto: '',
        words: [],
        puntuacion_interes: funcion === 'gancho' ? 8 : 6,
      });
      continue;
    }

    if (tipo === 'frases' || !tipo) {
      if (!startId) {
        recordDiscard({
          index: segIdx,
          reason: 'frase_vacia',
          invalidId: '',
          note: 'Se descartó 1 corte con referencia de frase inválida (ID vacío).',
          tipo,
          funcion,
        });
        continue;
      }

      const endId = rawEndId || startId;
      const startEntry = sentenceLookup.get(startId);
      const endEntry = sentenceLookup.get(endId);

      if (!startEntry) {
        recordDiscard({
          index: segIdx,
          reason: 'frase_inexistente',
          invalidId: startId,
          note: `Se descartó 1 corte con referencia de frase inválida ("${startId}").`,
          tipo,
          funcion,
        });
        continue;
      }
      if (!endEntry) {
        recordDiscard({
          index: segIdx,
          reason: 'frase_inexistente',
          invalidId: endId,
          note: `Se descartó 1 corte con referencia de frase inválida ("${endId}").`,
          tipo,
          funcion,
        });
        continue;
      }
      if (startEntry.clipIndex !== endEntry.clipIndex) {
        recordDiscard({
          index: segIdx,
          reason: 'rango_clips_distintos',
          invalidId: `${startId}→${endId}`,
          note: `Se descartó 1 corte con rango de frases inválido entre clips distintos ("${startId}" → "${endId}").`,
          tipo,
          funcion,
        });
        continue;
      }
      if (endEntry.pos < startEntry.pos) {
        recordDiscard({
          index: segIdx,
          reason: 'rango_invertido',
          invalidId: `${startId}→${endId}`,
          note: `Se descartó 1 corte con rango de frases invertido ("${startId}" → "${endId}").`,
          tipo,
          funcion,
        });
        continue;
      }

      const clipIndex = startEntry.clipIndex;
      const clipSentences = sentencesByClip.get(clipIndex) || [];
      const clipDur = Math.max(
        Number(clipDurations[clipIndex]) || 0,
        endEntry.sentence.end + PHRASE_POST_MARGIN_SEC
      );

      const includedSentences = clipSentences.slice(startEntry.pos, endEntry.pos + 1);
      const includedWords = includedSentences.flatMap((s) => s.words || []);
      if (includedWords.length === 0) {
        recordDiscard({
          index: segIdx,
          reason: 'frase_sin_palabras',
          invalidId: startId,
          note: `Se descartó 1 corte con referencia de frase sin palabras ("${startId}").`,
          tipo,
          funcion,
        });
        continue;
      }

      const prevSentence = startEntry.pos > 0 ? clipSentences[startEntry.pos - 1] : null;
      const nextSentence =
        endEntry.pos + 1 < clipSentences.length ? clipSentences[endEntry.pos + 1] : null;

      // Never invade words of neighboring sentences
      const minAllowedStart = prevSentence ? prevSentence.end : 0;
      const maxAllowedEnd = nextSentence ? Math.min(clipDur, nextSentence.start) : clipDur;

      const firstWordStart = includedWords[0].start;
      const lastWordEnd = includedWords[includedWords.length - 1].end;

      const startSec = round3(
        Math.min(firstWordStart, Math.max(minAllowedStart, firstWordStart - PHRASE_PRE_MARGIN_SEC))
      );
      const endSec = round3(
        Math.max(lastWordEnd, Math.min(maxAllowedEnd, lastWordEnd + PHRASE_POST_MARGIN_SEC))
      );

      if (endSec - startSec < 0.2) {
        recordDiscard({
          index: segIdx,
          reason: 'frase_duracion_insuficiente',
          invalidId: startId,
          note: `Se descartó 1 corte demasiado corto ("${startId}").`,
          tipo,
          funcion,
        });
        continue;
      }

      // Best score among included featured sentences
      let bestScore =
        funcion === 'gancho' || funcion === 'climax' || funcion === 'remate' ? 9 : 7;
      for (const s of includedSentences) {
        const sc = featuredScoresById.get(s.id);
        if (Number.isFinite(sc) && sc > bestScore) {
          bestScore = sc;
        }
      }

      const pieces = silenceTrimEnabled
        ? splitWordsBySilencePauses({
            words: includedWords,
            cutStartSec: startSec,
            cutEndSec: endSec,
            minBoundSec: minAllowedStart,
            maxBoundSec: maxAllowedEnd,
          })
        : [{ start_sec: startSec, end_sec: endSec, words: includedWords }];

      for (const piece of pieces) {
        const pieceWords = piece.words.map((w) => ({
          start: round3(w.start),
          end: round3(w.end),
          text: w.text,
        }));
        rawCuts.push({
          id: `cut-${String(cutCounter++).padStart(3, '0')}`,
          clip_index: clipIndex,
          start_sec: piece.start_sec,
          end_sec: piece.end_sec,
          funcion,
          motivo,
          texto: pieceWords.map((w) => w.text).join(' ').trim(),
          words: pieceWords,
          puntuacion_interes: Math.max(1, Math.min(10, Math.round(bestScore))),
        });
      }
      continue;
    }

    recordDiscard({
      index: segIdx,
      reason: 'tipo_desconocido',
      note: `Se descartó 1 corte con tipo de segmento inválido ("${String(tipo)}").`,
      tipo,
      funcion,
    });
  }

  const discardedCount = invalidSegments.length;
  const discardRatio = totalSegments > 0 ? discardedCount / totalSegments : 1;
  const invalidIds = Array.from(invalidIdsSet);

  if (rawCuts.length === 0) {
    return {
      cortes: [],
      duracionTotalSec: 0,
      guionResultante: '',
      durationNotes: [],
      validationNotes,
      invalidSegments,
      invalidIds,
      totalSegments,
      discardedCount,
      discardRatio,
    };
  }

  const enforced = enforceTargetDuration(rawCuts, targetDurationSec);
  const guionResultante = enforced.cuts
    .map((c) => (c.texto ? c.texto : `[Recurso visual · ${(c.end_sec - c.start_sec).toFixed(1)}s]`))
    .join('\n');

  return {
    cortes: enforced.cuts,
    duracionTotalSec: enforced.duracionTotalSec,
    guionResultante,
    durationNotes: enforced.notes,
    validationNotes,
    invalidSegments,
    invalidIds,
    totalSegments,
    discardedCount,
    discardRatio,
  };
}

/**
 * Executes Phase B script generation with tolerant validation and 1 guided retry
 * whenever > 30% of segments are discarded or the resulting script is empty.
 * Counted independently from Phase C's narrative coherence retry.
 */
export async function runPhaseBWithValidationRetry({
  runPhaseB,
  sentencesByClip,
  clipDurations,
  featuredScoresById = new Map(),
  silenceTrimEnabled = true,
  targetDurationSec = 45,
  baseFeedback = null,
}) {
  const executeAndValidate = async (feedback) => {
    const phaseBResult = await runPhaseB(feedback);
    const converted = convertPlanSegmentsToCuts({
      segmentos: phaseBResult?.segmentos,
      sentencesByClip,
      clipDurations,
      featuredScoresById,
      silenceTrimEnabled,
      targetDurationSec,
    });
    return { phaseBResult, converted };
  };

  const first = await executeAndValidate(baseFeedback);
  const needsGuidedRetry =
    first.converted.cortes.length === 0 ||
    first.converted.discardRatio > PHASE_B_MAX_DISCARD_RATIO;

  if (!needsGuidedRetry) {
    return {
      phaseBResult: first.phaseBResult,
      converted: first.converted,
      validationRetried: false,
    };
  }

  const invalidIdsText =
    first.converted.invalidIds.length > 0
      ? first.converted.invalidIds
          .map((id) => (id === '' ? '"" (vacío)' : `"${id}"`))
          .join(', ')
      : '(sin IDs válidos o recursos sin clip/tiempos)';

  const guidedFeedback = {
    problemas: [
      ...(Array.isArray(baseFeedback?.problemas) ? baseFeedback.problemas : []),
      `Se descartaron ${first.converted.discardedCount} de ${first.converted.totalSegments} cortes por referencias inválidas. IDs inválidos detectados: ${invalidIdsText}.`,
    ],
    cambios: [
      ...(Array.isArray(baseFeedback?.cambios) ? baseFeedback.cambios : []),
      'Usa solo los IDs C{clip}-F{nnn} proporcionados en la lista de frases, o funcion "recurso" (tipo "recurso") con clip_index, desde y hasta válidos (1-4 s).',
    ],
  };

  const second = await executeAndValidate(guidedFeedback);

  if (second.converted.cortes.length === 0) {
    const invalidCount =
      second.converted.discardedCount > 0
        ? second.converted.discardedCount
        : first.converted.discardedCount;
    throw new Error(
      `[Análisis IA] Gemini no devolvió un guion válido tras 2 intentos (${invalidCount} cortes inválidos).`
    );
  }

  return {
    phaseBResult: second.phaseBResult,
    converted: second.converted,
    validationRetried: true,
  };
}

// ---------- Phase C: Script Coherence Review ----------

export async function runPhaseCScriptReview({ apiKey, model, cortes, guionResultante }) {
  const timelineSummary = cortes
    .map((c, idx) => {
      const dur = (c.end_sec - c.start_sec).toFixed(1);
      const body = c.texto ? `"${c.texto}"` : `[Plano visual sin voz: ${c.motivo}]`;
      return `${idx + 1}. [${c.funcion.toUpperCase()} · ${dur}s · Clip ${c.clip_index + 1}] ${body}`;
    })
    .join('\n');

  const prompt = `Revisa este guion de montaje final para un vídeo vertical de TikTok/Reels:

Cortes en orden de montaje:
${timelineSummary}

Guion resultante completo:
${guionResultante}

Responde con honestidad editorial a estas tres preguntas:
1. ¿Se entiende como historia completa para alguien que no estuvo allí?
2. ¿El gancho de los primeros segundos engancha de verdad?
3. ¿Hay saltos sin sentido o frases que dependen de algo que se cortó?

Devuelve JSON con:
- coherente: true si funciona bien tal cual; false si hay fallos narrativos claros.
- problemas: lista breve de problemas encontrados (vacía si todo está bien).
- cambios: lista breve de mejoras concretas si coherente es false.`;

  return callGeminiGenerateContent({
    apiKey,
    model,
    systemInstruction:
      'Eres director de montaje exigente. Detectas saltos narrativos, frases huérfanas y ganchos flojos. Sé conciso y constructivo.',
    parts: [{ text: prompt }],
    responseSchema: PHASE_C_SCHEMA,
    mediaResolution: 'MEDIA_RESOLUTION_LOW',
  });
}

// ---------- Full Orchestrator (shared by worker/cloud-worker.mjs and worker/pc-worker.mjs) ----------

export async function analyzeCloudJob({
  manifest,
  sourcePaths,
  workDir,
  apiKey,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = resolveFfprobeBin(ffmpegBin),
  pythonBin = process.env.AUTOCUT_PYTHON_BIN || 'python3',
  transcribeScriptPath,
  whisperModel = 'small',
  whisperDevice = normalizeWhisperDevice(process.env.WHISPER_DEVICE, 'cpu'),
  whisperComputeType = '',
  getCachedTranscript,
  saveCachedTranscript,
  onProgress,
  onWhisperFallbackCpu,
}) {
  if (!apiKey) {
    throw new Error(
      '[Análisis IA] Falta la clave GEMINI_API_KEY (configúrala en worker/.env.local o en GitHub Secrets).'
    );
  }

  const options = manifest.options || {};
  const model = sanitizeModelName(options.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash');
  const stylePreset = options.stylePreset || 'funny_jumpcut';
  const customInstruction = String(options.customInstruction || '').trim();
  const targetDurationSec = Math.max(15, Number(options.targetDurationSec) || 45);
  const silenceTrimEnabled = options.silenceTrimEnabled !== false;
  const clipCount = sourcePaths.length;

  const report = async (stage, progress) => {
    if (onProgress) {
      await onProgress({ stage, progress: Math.max(0, Math.min(100, Math.round(progress))) });
    }
  };

  // 1. Probe metadata (duration + creation date) for chronological ordering
  const clipInfos = [];
  const clipDurations = [];
  const clipHasAudio = [];

  for (let i = 0; i < clipCount; i += 1) {
    const info = await probeClipMediaInfo(ffprobeBin, sourcePaths[i]);
    const hasAudio = await fileHasAudioStream(ffmpegBin, sourcePaths[i]);
    clipInfos.push({
      originalIndex: i,
      durationSec: info.durationSec,
      creationTimeIso: info.creationTimeIso,
      creationTimeMs: info.creationTimeMs,
    });
    clipDurations.push(info.durationSec);
    clipHasAudio.push(hasAudio);
  }

  const ordenClips = sortClipsChronologically(clipInfos);

  // 2. Transcription stage (20..55) with Drive cache lookup/save
  await report('transcripcion', 22);
  const sentencesByClip = new Map();

  for (let i = 0; i < clipCount; i += 1) {
    const srcMeta = manifest.sourceFiles?.[i] || {};
    let transcript = null;

    if (getCachedTranscript && srcMeta.driveFileId) {
      transcript = await getCachedTranscript(srcMeta.driveFileId, srcMeta.modifiedTime || '');
    }

    if (!transcript) {
      if (!clipHasAudio[i]) {
        transcript = { duration: clipDurations[i], language: 'es', segments: [] };
      } else {
        const wavPath = path.join(workDir, `audio_${String(i).padStart(3, '0')}.wav`);
        const jsonPath = path.join(workDir, `transcript_${String(i).padStart(3, '0')}.json`);
        await extractAudioWavForWhisper(ffmpegBin, sourcePaths[i], wavPath);
        transcript = await runWhisperTranscription({
          pythonBin,
          scriptPath: transcribeScriptPath,
          wavPath,
          outJsonPath: jsonPath,
          whisperModel,
          whisperDevice,
          whisperComputeType,
          lang: 'es',
          onWhisperFallbackCpu,
        });
        await fsp.rm(wavPath, { force: true }).catch(() => {});
      }

      if (saveCachedTranscript && srcMeta.driveFileId) {
        await saveCachedTranscript(srcMeta.driveFileId, srcMeta.modifiedTime || '', transcript);
      }
    }

    if ((!clipDurations[i] || clipDurations[i] <= 0) && Number(transcript?.duration) > 0) {
      clipDurations[i] = round3(transcript.duration);
    }

    const sentences = splitTranscriptIntoSentences(transcript, i);
    sentencesByClip.set(i, sentences);

    const pct = 22 + Math.round(((i + 1) / clipCount) * 33);
    await report('transcripcion', pct);
  }

  // 3. Vision stage — Phase A per clip (55..80)
  await report('vision', 56);
  const clipLogsByIndex = new Map();
  const featuredScoresById = new Map();

  for (let i = 0; i < clipCount; i += 1) {
    const proxyPath = path.join(workDir, `proxy_${String(i).padStart(3, '0')}.mp4`);
    let uploadedFile = null;

    try {
      await createGeminiProxyVideo(ffmpegBin, sourcePaths[i], proxyPath, clipHasAudio[i]);
      uploadedFile = await uploadProxyToGeminiFilesApi(
        apiKey,
        proxyPath,
        `autocut_clip_${String(i + 1).padStart(2, '0')}`
      );
      const clipLog = await runPhaseAClipLog({
        apiKey,
        model,
        clipIndex: i,
        durationSec: clipDurations[i] || 10,
        fileUri: uploadedFile.uri,
        sentences: sentencesByClip.get(i) || [],
      });
      clipLogsByIndex.set(i, clipLog);

      if (Array.isArray(clipLog?.frases_destacadas)) {
        for (const f of clipLog.frases_destacadas) {
          const id = String(f?.id_frase || '').trim();
          const score = Number(f?.puntuacion);
          if (id && Number.isFinite(score)) {
            featuredScoresById.set(id, Math.max(1, Math.min(10, Math.round(score))));
          }
        }
      }
    } finally {
      if (uploadedFile?.name) {
        await deleteGeminiUploadedFile(apiKey, uploadedFile.name);
      }
      await fsp.rm(proxyPath, { force: true }).catch(() => {});
    }

    const pct = 56 + Math.round(((i + 1) / clipCount) * 24);
    await report('vision', pct);
  }

  // 4. Script stage — Phase B global script (80..92), with tolerant validation & 1 guided retry (>30% invalid or empty)
  await report('guion', 82);
  const invokePhaseB = (feedback = null) =>
    runPhaseBGlobalScript({
      apiKey,
      model,
      stylePreset,
      customInstruction,
      targetDurationSec,
      orderedClipIndices: ordenClips,
      clipLogsByIndex,
      sentencesByClip,
      clipDurations,
      revisionFeedback: feedback,
    });

  let phaseBAttempt = await runPhaseBWithValidationRetry({
    runPhaseB: invokePhaseB,
    sentencesByClip,
    clipDurations,
    featuredScoresById,
    silenceTrimEnabled,
    targetDurationSec,
  });
  let phaseBResult = phaseBAttempt.phaseBResult;
  let converted = phaseBAttempt.converted;

  // 5. Review stage — Phase C (92..100), max 1 Phase B coherence retry if coherente === false (separate from validation retry)
  await report('revision', 92);
  let review = await runPhaseCScriptReview({
    apiKey,
    model,
    cortes: converted.cortes,
    guionResultante: converted.guionResultante,
  });

  if (review && review.coherente === false) {
    await report('revision', 95);
    phaseBAttempt = await runPhaseBWithValidationRetry({
      runPhaseB: invokePhaseB,
      sentencesByClip,
      clipDurations,
      featuredScoresById,
      silenceTrimEnabled,
      targetDurationSec,
      baseFeedback: review,
    });
    phaseBResult = phaseBAttempt.phaseBResult;
    converted = phaseBAttempt.converted;

    review = await runPhaseCScriptReview({
      apiKey,
      model,
      cortes: converted.cortes,
      guionResultante: converted.guionResultante,
    });
  }

  const notas = [
    ...(Array.isArray(converted.validationNotes) ? converted.validationNotes : []),
    ...converted.durationNotes,
    ...(Array.isArray(review?.problemas) ? review.problemas.filter(Boolean) : []),
    ...(Array.isArray(review?.cambios) ? review.cambios.filter(Boolean) : []),
  ]
    .map((n) => String(n).trim())
    .filter(Boolean);

  await report('revision', 100);

  return {
    titulo: String(phaseBResult.titulo || 'Historia editada con IA').trim(),
    etiqueta: sanitizeTag(phaseBResult.etiqueta),
    gancho: String(phaseBResult.gancho || converted.cortes[0]?.texto || '').trim(),
    historia: String(phaseBResult.historia || '').trim(),
    ordenClips,
    duracionTotalSec: converted.duracionTotalSec,
    guionResultante: converted.guionResultante || String(phaseBResult.guion_resultante || '').trim(),
    revision: {
      coherente: review?.coherente !== false,
      notas,
    },
    cortes: converted.cortes,
  };
}

export const analyzeJob = analyzeCloudJob;

/**
 * Shared analyze job lifecycle orchestration used by both `cloud-worker.mjs` and `pc-worker.mjs`:
 * validates inputs, resolves/downloads sources, runs Whisper + Gemini Phases A/B/C, updates progress,
 * and writes either `status: "analyzed"` with `plan` or `status: "error"` with `errorMessage`.
 */
export async function orchestrateAnalyzeJob({
  manifest,
  target = 'cloud',
  workDir,
  apiKey,
  missingApiKeyMessage,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = resolveFfprobeBin(ffmpegBin),
  pythonBin = process.env.AUTOCUT_PYTHON_BIN || 'python3',
  transcribeScriptPath,
  whisperModel = 'small',
  whisperDevice = 'cpu',
  progressThrottleMs = 10_000,
  prepareSourcePaths,
  getCachedTranscript,
  saveCachedTranscript,
  patchManifest,
  onLog,
  onWhisperFallbackCpu,
}) {
  const jobId = String(manifest.jobId || 'unknown').slice(0, 48);
  const tJobStart = Date.now();
  let lastProgressWriteMs = 0;
  let lastStage = '';

  const workingManifest = {
    ...manifest,
    kind: 'analyze',
    target,
    status: 'processing',
    stage: 'descarga',
    progress: 5,
  };
  delete workingManifest.errorMessage;

  const writeProgress = async (stage, progress, force = false) => {
    const now = Date.now();
    const stageChanged = Boolean(stage && stage !== lastStage);
    workingManifest.stage = stage || workingManifest.stage;
    workingManifest.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (!force && !stageChanged && now - lastProgressWriteMs < progressThrottleMs) {
      return;
    }
    lastStage = workingManifest.stage;
    lastProgressWriteMs = now;
    await patchManifest(workingManifest);
  };

  onLog?.('INFO', 'analyze_started', {
    jobId,
    kind: 'analyze',
    clips: manifest.sourceFiles?.length ?? 0,
    whisperModel,
    whisperDevice,
  });

  try {
    await writeProgress('descarga', 5, true);

    if (!apiKey) {
      throw new Error(
        missingApiKeyMessage ||
          '[Análisis IA] Falta la clave GEMINI_API_KEY (configúrala en worker/.env.local o en GitHub Secrets).'
      );
    }

    if (!Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0) {
      throw new Error('[Drive] El manifiesto de análisis no contiene archivos fuente.');
    }

    const sourcePaths = await prepareSourcePaths({
      manifest,
      workDir,
      writeProgress,
    });

    const plan = await analyzeCloudJob({
      manifest,
      sourcePaths,
      workDir,
      apiKey,
      ffmpegBin,
      ffprobeBin,
      pythonBin,
      transcribeScriptPath,
      whisperModel,
      whisperDevice,
      getCachedTranscript,
      saveCachedTranscript,
      onWhisperFallbackCpu,
      onProgress: async ({ stage, progress }) => {
        await writeProgress(stage, progress, false);
        onLog?.('INFO', 'analyze_progress', { jobId, stage, progress });
      },
    });

    workingManifest.status = 'analyzed';
    workingManifest.stage = 'revision';
    workingManifest.progress = 100;
    workingManifest.plan = plan;
    workingManifest.finishedAt = new Date().toISOString();
    delete workingManifest.errorMessage;

    await patchManifest(workingManifest);
    onLog?.('INFO', 'analyze_completed', {
      jobId,
      kind: 'analyze',
      cuts: plan.cortes.length,
      coherent: Boolean(plan.revision?.coherente),
      sec: Number(((Date.now() - tJobStart) / 1000).toFixed(1)),
      progress: 100,
    });
    return plan;
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const message = rawMsg.startsWith('[') ? rawMsg : `[Análisis IA] ${rawMsg}`;
    onLog?.('ERROR', 'analyze_failed', {
      jobId,
      kind: 'analyze',
      stage: workingManifest.stage,
      sec: Number(((Date.now() - tJobStart) / 1000).toFixed(1)),
    });
    try {
      await patchManifest({
        ...workingManifest,
        status: 'error',
        errorMessage: message.slice(0, 480),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      onLog?.('ERROR', 'analyze_error_patch_failed', { jobId });
    }
    throw err;
  }
}

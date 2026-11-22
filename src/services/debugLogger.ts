import type { AppSettings, EditStylePreset, TikTokEditOptions } from '../types';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export type LogCategory = 'UI' | 'Drive' | 'Frames' | 'IA' | 'FFmpeg' | 'Sistema';

export interface DebugLogEntry {
  id: number;
  timestamp: string;
  epochMs: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
  stack?: string;
}

export interface DiagnosticQueueSummary {
  total: number;
  pending: number;
  active: number;
  completed: number;
  error: number;
}

export interface DiagnosticContextSnapshot {
  settings?: Pick<
    AppSettings,
    'model' | 'exportQuality' | 'autoWatchEnabled' | 'watchIntervalSec' | 'autoUploadEnabled'
  > & { hasFolderId?: boolean };
  tiktokOptions?: TikTokEditOptions;
  stylePreset?: EditStylePreset;
  queueSummary?: DiagnosticQueueSummary;
  activeError?: string | null;
}

export const MAX_DEBUG_LOG_ENTRIES = 200;

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|bearer|secret|password|credential|cookie|token)/i;
const BASE64_KEY_PATTERN = /(base64|dataurl|imagedata|videodata|buffer)/i;

const DATA_URI_BASE64_PATTERN =
  /data:(?:image|video|audio)\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]{24,})/gi;
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const GOOGLE_OAUTH_TOKEN_PATTERN = /\bya29\.[0-9A-Za-z._-]{16,}\b/g;
const INLINE_SECRET_KV_PATTERN =
  /\b(access_token|refresh_token|id_token|api_key|apikey|authorization|client_secret|gemini_api_key)\s*([:=])\s*["']?[^\s"',;&}]+["']?/gi;
const RAW_BASE64_BLOB_PATTERN = /\b[A-Za-z0-9+/]{160,}={0,2}\b/g;

let entries: DebugLogEntry[] = [];
let nextEntryId = 1;
let globalHandlersInstalled = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  });
}

function estimateBase64Kb(base64Length: number): string {
  const approxBytes = Math.round((base64Length * 3) / 4);
  const kb = Math.max(1, Math.round(approxBytes / 1024));
  return `${kb} KB`;
}

export function formatLogTimestamp(date: Date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Redacts API keys, OAuth tokens, Authorization/Bearer headers, and base64 blobs
 * so diagnostic reports are always safe to copy and paste into a support chat.
 */
export function sanitizeLogString(input: string): string {
  if (!input) return '';
  let out = input;

  out = out.replace(DATA_URI_BASE64_PATTERN, (_match, b64: string) => {
    const cleanLen = b64.replace(/\s+/g, '').length;
    return `[base64: ${estimateBase64Kb(cleanLen)}]`;
  });
  out = out.replace(BEARER_PATTERN, '$1 [OMITIDO]');
  out = out.replace(GOOGLE_API_KEY_PATTERN, '[OMITIDO]');
  out = out.replace(GOOGLE_OAUTH_TOKEN_PATTERN, '[OMITIDO]');
  out = out.replace(INLINE_SECRET_KV_PATTERN, '$1$2[OMITIDO]');
  out = out.replace(RAW_BASE64_BLOB_PATTERN, (match) => `[base64: ${estimateBase64Kb(match.length)}]`);

  if (out.length > 500) {
    out = `${out.slice(0, 497)}...`;
  }
  return out;
}

export function sanitizeLogData(
  data?: Record<string, unknown>,
  depth = 0
): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || depth > 3) return undefined;

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;

    if (SENSITIVE_KEY_PATTERN.test(key)) {
      clean[key] = '[OMITIDO]';
      continue;
    }

    if (typeof value === 'string') {
      if (BASE64_KEY_PATTERN.test(key) && value.length > 32) {
        clean[key] = `[base64: ${estimateBase64Kb(value.length)}]`;
      } else {
        clean[key] = sanitizeLogString(value);
      }
      continue;
    }

    if (typeof value === 'number') {
      clean[key] = Number.isFinite(value) ? value : String(value);
      continue;
    }

    if (typeof value === 'boolean' || value === null) {
      clean[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      clean[key] = `[array:${value.length}]`;
      continue;
    }

    if (typeof value === 'object') {
      clean[key] = sanitizeLogData(value as Record<string, unknown>, depth + 1) ?? '[object]';
    }
  }

  return Object.keys(clean).length > 0 ? clean : undefined;
}

export function summarizeErrorStack(error?: unknown): string | undefined {
  if (!error) return undefined;
  const rawStack =
    error instanceof Error
      ? error.stack || error.message
      : typeof error === 'object' && error !== null && 'stack' in error
      ? String((error as { stack?: unknown }).stack ?? '')
      : typeof error === 'string'
      ? error
      : '';

  if (!rawStack.trim()) return undefined;
  const lines = rawStack
    .split('\n')
    .map((line) => sanitizeLogString(line.trim()))
    .filter(Boolean)
    .slice(0, 4);

  return lines.length > 0 ? lines.join(' | ') : undefined;
}

export function logDebug(
  level: LogLevel,
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown
): DebugLogEntry {
  const now = new Date();
  const entry: DebugLogEntry = {
    id: nextEntryId++,
    timestamp: formatLogTimestamp(now),
    epochMs: now.getTime(),
    level,
    category,
    message: sanitizeLogString(message),
    data: sanitizeLogData(data),
    stack: level === 'ERROR' || error ? summarizeErrorStack(error) : undefined,
  };

  entries.push(entry);
  if (entries.length > MAX_DEBUG_LOG_ENTRIES) {
    entries = entries.slice(entries.length - MAX_DEBUG_LOG_ENTRIES);
  }

  notifyListeners();
  return entry;
}

export function logInfo(
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>
): DebugLogEntry {
  return logDebug('INFO', category, message, data);
}

export function logWarn(
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown
): DebugLogEntry {
  return logDebug('WARN', category, message, data, error);
}

export function logError(
  category: LogCategory,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown
): DebugLogEntry {
  return logDebug('ERROR', category, message, data, error);
}

export function getDebugLogs(): DebugLogEntry[] {
  return [...entries];
}

export interface DebugLogStats {
  total: number;
  errors: number;
  warnings: number;
  maxEntries: number;
}

export function getDebugLogStats(): DebugLogStats {
  let errors = 0;
  let warnings = 0;
  for (const e of entries) {
    if (e.level === 'ERROR') errors += 1;
    else if (e.level === 'WARN') warnings += 1;
  }
  return {
    total: entries.length,
    errors,
    warnings,
    maxEntries: MAX_DEBUG_LOG_ENTRIES,
  };
}

export function clearDebugLogs(): void {
  entries = [];
  notifyListeners();
}

export function subscribeDebugLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Installs global browser error listeners (window.onerror & unhandledrejection)
 * once per session so silent crashes on mobile Safari/Chrome are always recorded.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') return;
  globalHandlersInstalled = true;

  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

  logInfo('Sistema', 'Sesión iniciada', {
    pantalla: `${window.innerWidth}x${window.innerHeight}`,
    pwa: isStandalone ? 'Sí' : 'No',
    online: navigator.onLine ? 'Sí' : 'No',
  });

  window.addEventListener('error', (event) => {
    const errMessage = event.message || 'Error global no controlado';
    logError(
      'Sistema',
      `window.onerror: ${errMessage}`,
      {
        origen: event.filename ? event.filename.split('/').slice(-2).join('/') : 'desconocido',
        linea: event.lineno || 0,
        columna: event.colno || 0,
      },
      event.error
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
        ? reason
        : 'Promesa rechazada sin controlar';
    logError('Sistema', `unhandledrejection: ${msg}`, undefined, reason);
  });

  window.addEventListener('online', () => {
    logInfo('Sistema', 'Conexión de red restaurada');
  });

  window.addEventListener('offline', () => {
    logWarn('Sistema', 'Conexión de red perdida (offline)');
  });
}

function formatDataInline(data?: Record<string, unknown>): string {
  if (!data) return '';
  const parts = Object.entries(data).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? ` | ${parts.join(', ')}` : '';
}

function detectEnvironmentInfo(): {
  userAgent: string;
  screen: string;
  pwaMode: string;
  connection: string;
} {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      userAgent: 'Node/Test',
      screen: 'N/A',
      pwaMode: 'No',
      connection: 'N/A',
    };
  }

  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

  const navWithConn = navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number };
  };
  const netType = navWithConn.connection?.effectiveType
    ? ` (${navWithConn.connection.effectiveType})`
    : '';
  const dpr = window.devicePixelRatio ? ` @${window.devicePixelRatio}x` : '';

  return {
    userAgent: sanitizeLogString(navigator.userAgent || 'Desconocido'),
    screen: `${window.innerWidth}×${window.innerHeight} (pantalla ${window.screen?.width ?? 0}×${window.screen?.height ?? 0}${dpr})`,
    pwaMode: isStandalone ? 'Sí (instalada / standalone)' : 'No (navegador)',
    connection: `${navigator.onLine ? 'Online' : 'Offline'}${netType}`,
  };
}

/**
 * Generates a clean, plain-text diagnostic report ready to paste into a support chat.
 */
export function buildDiagnosticReport(context?: DiagnosticContextSnapshot): string {
  const now = new Date();
  const env = detectEnvironmentInfo();
  const stats = getDebugLogStats();
  const snapshot = getDebugLogs();

  const lines: string[] = [
    '=== INFORME DE DIAGNÓSTICO — AUTOCUT DRIVE AI ===',
    `Fecha y hora: ${now.toLocaleString('es-ES')} (${now.toISOString()})`,
    '',
    '--- ENTORNO ---',
    `Navegador: ${env.userAgent}`,
    `Resolución: ${env.screen}`,
    `Modo PWA: ${env.pwaMode}`,
    `Conexión: ${env.connection}`,
  ];

  if (context?.settings || context?.tiktokOptions || context?.stylePreset) {
    lines.push('', '--- CONFIGURACIÓN ACTIVA ---');
    if (context.settings) {
      lines.push(
        `Modelo Gemini: ${context.settings.model}`,
        `Resolución render: ${
          context.settings.exportQuality === 'mobile_fast' ? '720p móvil (mobile_fast)' : '1080p HD (high_1080p)'
        }`,
        `Carpeta Drive configurada: ${context.settings.hasFolderId ? 'Sí' : 'No'}`,
        `Vigilancia automática: ${
          context.settings.autoWatchEnabled ? `Sí (${context.settings.watchIntervalSec}s)` : 'No'
        }`,
        `Confirmar subida a Drive: ${context.settings.autoUploadEnabled ? 'Sí' : 'No'}`
      );
    }
    if (context.stylePreset) {
      lines.push(`Estilo de edición: ${context.stylePreset}`);
    }
    if (context.tiktokOptions) {
      lines.push(
        `Subtítulos automáticos: ${context.tiktokOptions.subtitlesEnabled ? 'Sí' : 'No'}`,
        `Recorte de silencios: ${context.tiktokOptions.silenceTrimEnabled ? 'Sí' : 'No'}`,
        `Normalización audio (-14 LUFS): ${context.tiktokOptions.audioNormalizeEnabled ? 'Sí' : 'No'}`,
        `Encuadre 9:16: ${
          context.tiktokOptions.framingMode === 'blur_pad'
            ? 'Fondo desenfocado (blur_pad)'
            : 'Recorte centrado (center_crop)'
        }`
      );
    }
  }

  if (context?.queueSummary) {
    const q = context.queueSummary;
    lines.push(
      '',
      '--- ESTADO DE LA COLA ---',
      `Total: ${q.total} | Pendientes: ${q.pending} | En proceso: ${q.active} | Completados: ${q.completed} | Con error: ${q.error}`
    );
  }

  if (context?.activeError) {
    lines.push(`Último error visible: ${sanitizeLogString(context.activeError)}`);
  }

  lines.push(
    '',
    `--- CRONOLOGÍA (${stats.total} eventos · ${stats.errors} errores · ${stats.warnings} avisos) ---`
  );

  if (snapshot.length === 0) {
    lines.push('(Sin eventos registrados en esta sesión)');
  } else {
    for (const entry of snapshot) {
      lines.push(
        `[${entry.timestamp}] [${entry.level}] [${entry.category}] ${entry.message}${formatDataInline(entry.data)}`
      );
      if (entry.stack) {
        lines.push(`    stack: ${entry.stack}`);
      }
    }
  }

  lines.push('=== FIN DEL INFORME ===');
  return lines.join('\n');
}

export interface CopyReportResult {
  ok: boolean;
  method: 'clipboard' | 'execCommand' | 'manual';
}

/**
 * Copies text reliably on desktop and mobile (iOS Safari / Chrome) using
 * navigator.clipboard.writeText with an automatic hidden textarea + execCommand('copy') fallback.
 */
export async function copyTextWithFallback(text: string): Promise<CopyReportResult> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Fallback to execCommand below
    }
  }

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.fontSize = '16px'; // Prevents iOS Safari auto-zoom

    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const copied = document.execCommand('copy');
      if (copied) {
        return { ok: true, method: 'execCommand' };
      }
    } catch {
      // Fallback to manual modal
    } finally {
      document.body.removeChild(textarea);
    }
  }

  return { ok: false, method: 'manual' };
}

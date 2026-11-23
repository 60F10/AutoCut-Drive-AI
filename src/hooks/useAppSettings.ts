import { useCallback, useState } from 'react';
import type {
  AppSettings,
  BrollDensity,
  EditStylePreset,
  ExportQuality,
  TikTokEditOptions,
} from '../types';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_PROCESS_ENGINE,
  DEFAULT_TIKTOK_OPTIONS,
  DEFAULT_WHISPER_MODEL,
  detectDefaultExportQuality,
  extractDriveFolderId,
  normalizeExportQuality,
  normalizeProcessEngine,
  normalizeStylePreset,
  normalizeTikTokOptions,
  normalizeWhisperModel,
  sanitizeGeminiModelName,
} from '../utils/videoPipeline';
import {
  MAX_CACHED_VIDEOS,
  getVideoCacheStats,
  type VideoCacheStats,
} from '../services/videoStorage';
import { logInfo } from '../services/debugLogger';

const SETTINGS_STORAGE_KEY = 'autocut_drive_ai_settings_v1';
const STYLE_PRESET_STORAGE_KEY = 'autocut_drive_ai_style_preset_v1';
const TIKTOK_OPTIONS_STORAGE_KEY = 'autocut_drive_ai_tiktok_options_v1';

export function resolveEnvDefaultGeminiModel(): string {
  const envModel =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.VITE_GEMINI_MODEL as string | undefined)
      : undefined;
  return sanitizeGeminiModelName(envModel, DEFAULT_GEMINI_MODEL);
}

function normalizeBrollDensity(raw: unknown): BrollDensity {
  return raw === 'baja' || raw === 'alta' ? raw : 'media';
}

export function createDefaultSettings(): AppSettings {
  return {
    folderId: '',
    model: resolveEnvDefaultGeminiModel(),
    whisperModel: DEFAULT_WHISPER_MODEL,
    processEngine: DEFAULT_PROCESS_ENGINE,
    watchIntervalSec: 60,
    autoWatchEnabled: false,
    autoUploadEnabled: true,
    exportQuality: detectDefaultExportQuality(),
    voiceoverBrollEnabled: true,
    brollDensity: 'media',
    brollSmoothPanEnabled: true,
    brollAmbientAudioEnabled: false,
  };
}

function loadInitialSettings(): AppSettings {
  const defaults = createDefaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const validModel = sanitizeGeminiModelName(parsed.model, defaults.model);
    const validInterval =
      parsed.watchIntervalSec === 30 ||
      parsed.watchIntervalSec === 60 ||
      parsed.watchIntervalSec === 300
        ? parsed.watchIntervalSec
        : 60;
    const validQuality =
      parsed.exportQuality === 'mobile_fast' || parsed.exportQuality === 'high_1080p'
        ? parsed.exportQuality
        : defaults.exportQuality;
    return {
      folderId: extractDriveFolderId(String(parsed.folderId ?? '')),
      model: validModel,
      whisperModel: normalizeWhisperModel(parsed.whisperModel),
      processEngine: normalizeProcessEngine(parsed.processEngine),
      watchIntervalSec: validInterval,
      autoWatchEnabled: Boolean(parsed.autoWatchEnabled),
      autoUploadEnabled: parsed.autoUploadEnabled !== false,
      exportQuality: normalizeExportQuality(validQuality),
      voiceoverBrollEnabled: parsed.voiceoverBrollEnabled !== false,
      brollDensity: normalizeBrollDensity(parsed.brollDensity),
      brollSmoothPanEnabled: parsed.brollSmoothPanEnabled !== false,
      brollAmbientAudioEnabled: Boolean(parsed.brollAmbientAudioEnabled),
    };
  } catch {
    return defaults;
  }
}

function loadInitialStylePreset(): EditStylePreset {
  try {
    const raw = window.localStorage.getItem(STYLE_PRESET_STORAGE_KEY);
    return normalizeStylePreset(raw);
  } catch {
    return 'funny_jumpcut';
  }
}

function loadInitialTikTokOptions(): TikTokEditOptions {
  try {
    const raw = window.localStorage.getItem(TIKTOK_OPTIONS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TIKTOK_OPTIONS };
    const parsed = JSON.parse(raw) as Partial<TikTokEditOptions>;
    return normalizeTikTokOptions(parsed);
  } catch {
    return { ...DEFAULT_TIKTOK_OPTIONS };
  }
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadInitialSettings);
  const [stylePreset, setStylePreset] = useState<EditStylePreset>(loadInitialStylePreset);
  const [customInstruction, setCustomInstruction] = useState('');
  const [tiktokOptions, setTikTokOptions] = useState<TikTokEditOptions>(loadInitialTikTokOptions);
  const [cacheStats, setCacheStats] = useState<VideoCacheStats>({
    count: 0,
    totalBytes: 0,
    maxItems: MAX_CACHED_VIDEOS,
  });

  const refreshCacheStats = useCallback(async () => {
    const stats = await getVideoCacheStats();
    setCacheStats(stats);
  }, []);

  const persistSettings = useCallback((next: AppSettings) => {
    const sanitized: AppSettings = {
      ...next,
      model: sanitizeGeminiModelName(next.model, resolveEnvDefaultGeminiModel()),
      whisperModel: normalizeWhisperModel(next.whisperModel),
      processEngine: normalizeProcessEngine(next.processEngine),
      folderId: extractDriveFolderId(next.folderId),
      exportQuality: normalizeExportQuality(next.exportQuality),
      voiceoverBrollEnabled: next.voiceoverBrollEnabled !== false,
      brollDensity: normalizeBrollDensity(next.brollDensity),
      brollSmoothPanEnabled: next.brollSmoothPanEnabled !== false,
      brollAmbientAudioEnabled: Boolean(next.brollAmbientAudioEnabled),
    };
    setSettings(sanitized);
    logInfo('UI', 'Ajustes guardados', {
      modelo: sanitized.model,
      whisper: sanitized.whisperModel,
      motor: sanitized.processEngine,
      calidad: sanitized.exportQuality === 'mobile_fast' ? '720p' : '1080p',
      vigilancia: sanitized.autoWatchEnabled ? `${sanitized.watchIntervalSec}s` : 'off',
      carpeta: sanitized.folderId ? 'sí' : 'no',
      vozRecursos: sanitized.voiceoverBrollEnabled ? sanitized.brollDensity : 'off',
    });
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitized));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const resetSettings = useCallback(() => {
    logInfo('UI', 'Ajustes restablecidos a valores por defecto');
    persistSettings(createDefaultSettings());
  }, [persistSettings]);

  const handleChangeStylePreset = useCallback((next: EditStylePreset) => {
    const normalized = normalizeStylePreset(next);
    setStylePreset(normalized);
    logInfo('UI', 'Estilo de edición cambiado', { estilo: normalized });
    try {
      window.localStorage.setItem(STYLE_PRESET_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const handleChangeTikTokOptions = useCallback((patch: Partial<TikTokEditOptions>) => {
    setTikTokOptions((prev) => {
      const next = normalizeTikTokOptions({ ...prev, ...patch });
      logInfo('UI', 'Opciones de edición TikTok actualizadas', {
        subtitulos: next.subtitlesEnabled ? 'sí' : 'no',
        silencios: next.silenceTrimEnabled ? 'sí' : 'no',
        loudnorm: next.audioNormalizeEnabled ? 'sí' : 'no',
        encuadre: next.framingMode,
      });
      try {
        window.localStorage.setItem(TIKTOK_OPTIONS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }, []);

  const handleChangeExportQuality = useCallback(
    (quality: ExportQuality) => {
      const normalized = normalizeExportQuality(quality);
      logInfo('UI', 'Modo de resolución cambiado', {
        calidad: normalized === 'mobile_fast' ? '720p móvil' : '1080p HD',
      });
      persistSettings({
        ...settings,
        exportQuality: normalized,
      });
    },
    [settings, persistSettings]
  );

  return {
    settings,
    persistSettings,
    resetSettings,
    stylePreset,
    handleChangeStylePreset,
    customInstruction,
    setCustomInstruction,
    tiktokOptions,
    handleChangeTikTokOptions,
    handleChangeExportQuality,
    cacheStats,
    refreshCacheStats,
  };
}

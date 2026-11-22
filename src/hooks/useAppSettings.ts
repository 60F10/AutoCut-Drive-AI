import { useCallback, useState } from 'react';
import type {
  AppSettings,
  EditStylePreset,
  ExportQuality,
  TikTokEditOptions,
} from '../types';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_TIKTOK_OPTIONS,
  detectDefaultExportQuality,
  extractDriveFolderId,
  normalizeExportQuality,
  normalizeStylePreset,
  normalizeTikTokOptions,
  sanitizeGeminiModelName,
} from '../utils/videoPipeline';
import {
  MAX_CACHED_VIDEOS,
  getVideoCacheStats,
  type VideoCacheStats,
} from '../services/videoStorage';

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

export function createDefaultSettings(): AppSettings {
  return {
    folderId: '',
    model: resolveEnvDefaultGeminiModel(),
    watchIntervalSec: 60,
    autoWatchEnabled: false,
    autoUploadEnabled: true,
    exportQuality: detectDefaultExportQuality(),
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
      watchIntervalSec: validInterval,
      autoWatchEnabled: Boolean(parsed.autoWatchEnabled),
      autoUploadEnabled: parsed.autoUploadEnabled !== false,
      exportQuality: normalizeExportQuality(validQuality),
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
      folderId: extractDriveFolderId(next.folderId),
      exportQuality: normalizeExportQuality(next.exportQuality),
    };
    setSettings(sanitized);
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitized));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(createDefaultSettings());
  }, [persistSettings]);

  const handleChangeStylePreset = useCallback((next: EditStylePreset) => {
    const normalized = normalizeStylePreset(next);
    setStylePreset(normalized);
    try {
      window.localStorage.setItem(STYLE_PRESET_STORAGE_KEY, normalized);
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const handleChangeTikTokOptions = useCallback((patch: Partial<TikTokEditOptions>) => {
    setTikTokOptions((prev) => {
      const next = normalizeTikTokOptions({ ...prev, ...patch });
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
      persistSettings({
        ...settings,
        exportQuality: normalizeExportQuality(quality),
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

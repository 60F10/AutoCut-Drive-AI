import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppErrorBanner, SubtitleStyleProfile } from '../types';
import {
  DEFAULT_SUBTITLE_STYLE_ID,
  cloneSubtitleStyleProfile,
  createCustomSubtitleStyleId,
  duplicateSubtitleStyleProfile,
  isBuiltInSubtitleStyleId,
  mergeSubtitleStyleProfiles,
  normalizeSubtitleStyleProfile,
  resolveSubtitleStyleById,
} from '../utils/subtitleStyles';
import {
  DriveAuthExpiredError,
  deleteDriveSubtitleStyle,
  listDriveSubtitleStylesAndFonts,
  saveDriveSubtitleStyle,
} from '../services/driveApi';
import { getCachedDriveToken } from '../services/googleAuth';
import { formatPhaseError } from '../utils/videoPipeline';
import { logError, logInfo } from '../services/debugLogger';

const CUSTOM_STYLES_STORAGE_KEY = 'autocut_drive_ai_subtitle_styles_v1';

function loadLocalCustomProfiles(): SubtitleStyleProfile[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_STYLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Partial<SubtitleStyleProfile> => Boolean(item && typeof item === 'object'))
      .map((item) => normalizeSubtitleStyleProfile(item))
      .filter((p) => !isBuiltInSubtitleStyleId(p.id));
  } catch {
    return [];
  }
}

function saveLocalCustomProfiles(profiles: SubtitleStyleProfile[]) {
  try {
    const customOnly = profiles.filter((p) => !isBuiltInSubtitleStyleId(p.id));
    window.localStorage.setItem(CUSTOM_STYLES_STORAGE_KEY, JSON.stringify(customOnly));
  } catch {
    // Ignore storage quota errors
  }
}

interface UseSubtitleStylesParams {
  folderId: string;
  accessToken: string | null;
  isDriveConnected: boolean;
  defaultSubtitleStyleId: string;
  onChangeDefaultStyleId: (nextId: string) => void;
  clearAuthSession: () => void;
  onError: (error: string | AppErrorBanner | null) => void;
}

export function useSubtitleStyles({
  folderId,
  accessToken,
  isDriveConnected,
  defaultSubtitleStyleId,
  onChangeDefaultStyleId,
  clearAuthSession,
  onError,
}: UseSubtitleStylesParams) {
  const [customProfiles, setCustomProfiles] = useState<SubtitleStyleProfile[]>(
    loadLocalCustomProfiles
  );
  const [driveFonts, setDriveFonts] = useState<string[]>([]);
  const [isSyncingStyles, setIsSyncingStyles] = useState(false);
  const [isSavingStyle, setIsSavingStyle] = useState(false);
  const [lastSyncSource, setLastSyncSource] = useState<'local' | 'drive'>('local');

  const fileIdByProfileIdRef = useRef<Record<string, string>>({});
  const trimmedFolderId = folderId.trim();

  const resolveDriveToken = useCallback((): string | null => {
    return accessToken || getCachedDriveToken();
  }, [accessToken]);

  const profiles = useMemo(
    () => mergeSubtitleStyleProfiles(customProfiles),
    [customProfiles]
  );

  const defaultProfile = useMemo(
    () => resolveSubtitleStyleById(profiles, defaultSubtitleStyleId),
    [profiles, defaultSubtitleStyleId]
  );

  const syncSubtitleStyles = useCallback(
    async (silent = false) => {
      const token = resolveDriveToken();
      if (!token || !trimmedFolderId) {
        setLastSyncSource('local');
        return;
      }

      setIsSyncingStyles(true);
      try {
        const snapshot = await listDriveSubtitleStylesAndFonts(trimmedFolderId, token);
        const normalizedRemote = snapshot.profiles
          .map((p) => normalizeSubtitleStyleProfile(p))
          .filter((p) => !isBuiltInSubtitleStyleId(p.id));

        fileIdByProfileIdRef.current = snapshot.fileIdByProfileId;
        setDriveFonts(snapshot.fonts);
        setLastSyncSource('drive');

        setCustomProfiles((prev) => {
          // Merge remote profiles with any local-only custom profiles not yet in Drive
          const byId = new Map<string, SubtitleStyleProfile>();
          for (const local of prev) {
            if (!isBuiltInSubtitleStyleId(local.id)) {
              byId.set(local.id, local);
            }
          }
          for (const remote of normalizedRemote) {
            byId.set(remote.id, remote);
          }
          const mergedCustom = Array.from(byId.values()).sort((a, b) =>
            a.nombre.localeCompare(b.nombre, 'es')
          );
          saveLocalCustomProfiles(mergedCustom);
          return mergedCustom;
        });

        logInfo('Drive', 'Perfiles de subtítulos sincronizados', {
          personalizados: normalizedRemote.length,
          fuentes: snapshot.fonts.length,
        });
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          if (!silent) onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudieron cargar los perfiles de subtítulos desde Drive.';
          logError('Drive', 'Error al sincronizar perfiles de subtítulos', { error: msg });
          if (!silent) onError(formatPhaseError('Drive', msg));
        }
      } finally {
        setIsSyncingStyles(false);
      }
    },
    [resolveDriveToken, trimmedFolderId, clearAuthSession, onError]
  );

  useEffect(() => {
    if (!isDriveConnected || !trimmedFolderId) return;
    void syncSubtitleStyles(true);
  }, [isDriveConnected, trimmedFolderId, syncSubtitleStyles]);

  const saveProfile = useCallback(
    async (draft: SubtitleStyleProfile): Promise<SubtitleStyleProfile | null> => {
      if (isBuiltInSubtitleStyleId(draft.id)) {
        onError('Los perfiles de serie no se pueden sobrescribir. Duplícalo para personalizarlo.');
        return null;
      }

      const normalized = normalizeSubtitleStyleProfile(draft);
      setIsSavingStyle(true);

      try {
        const token = resolveDriveToken();
        if (token && trimmedFolderId) {
          const existingFileId = fileIdByProfileIdRef.current[normalized.id];
          const res = await saveDriveSubtitleStyle(
            trimmedFolderId,
            normalized,
            token,
            existingFileId
          );
          fileIdByProfileIdRef.current[normalized.id] = res.fileId;
          setLastSyncSource('drive');
        }

        setCustomProfiles((prev) => {
          const next = [
            ...prev.filter((p) => p.id !== normalized.id),
            normalized,
          ].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
          saveLocalCustomProfiles(next);
          return next;
        });

        return normalized;
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo guardar el perfil de subtítulos.';
          logError('Drive', 'Error al guardar perfil de subtítulos', { error: msg });
          onError(formatPhaseError('Drive', msg));
        }
        return null;
      } finally {
        setIsSavingStyle(false);
      }
    },
    [resolveDriveToken, trimmedFolderId, clearAuthSession, onError]
  );

  const createProfile = useCallback(
    async (base?: SubtitleStyleProfile, customName?: string): Promise<SubtitleStyleProfile | null> => {
      const existingIds = profiles.map((p) => p.id);
      const source = base ? cloneSubtitleStyleProfile(base) : cloneSubtitleStyleProfile(defaultProfile);
      const nombre = (customName || 'Mi estilo').trim().slice(0, 64);
      const id = createCustomSubtitleStyleId(nombre, existingIds);
      const created = normalizeSubtitleStyleProfile({ ...source, id, nombre }, source);
      return saveProfile(created);
    },
    [profiles, defaultProfile, saveProfile]
  );

  const duplicateProfile = useCallback(
    async (source: SubtitleStyleProfile): Promise<SubtitleStyleProfile | null> => {
      const existingIds = profiles.map((p) => p.id);
      const copy = duplicateSubtitleStyleProfile(source, existingIds);
      return saveProfile(copy);
    },
    [profiles, saveProfile]
  );

  const deleteProfile = useCallback(
    async (profileId: string): Promise<boolean> => {
      if (isBuiltInSubtitleStyleId(profileId)) {
        onError('Los perfiles de serie no se pueden borrar.');
        return false;
      }

      setIsSavingStyle(true);
      try {
        const token = resolveDriveToken();
        const fileId = fileIdByProfileIdRef.current[profileId];
        if (token && fileId) {
          await deleteDriveSubtitleStyle(fileId, token);
          delete fileIdByProfileIdRef.current[profileId];
        }

        setCustomProfiles((prev) => {
          const next = prev.filter((p) => p.id !== profileId);
          saveLocalCustomProfiles(next);
          return next;
        });

        if (defaultSubtitleStyleId === profileId) {
          onChangeDefaultStyleId(DEFAULT_SUBTITLE_STYLE_ID);
        }

        return true;
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          clearAuthSession();
          onError(formatPhaseError('Drive', err.message));
        } else {
          const msg =
            err instanceof Error
              ? err.message
              : 'No se pudo borrar el perfil de subtítulos.';
          logError('Drive', 'Error al borrar perfil de subtítulos', { error: msg });
          onError(formatPhaseError('Drive', msg));
        }
        return false;
      } finally {
        setIsSavingStyle(false);
      }
    },
    [
      resolveDriveToken,
      defaultSubtitleStyleId,
      onChangeDefaultStyleId,
      clearAuthSession,
      onError,
    ]
  );

  const getProfileById = useCallback(
    (styleId?: string | null) => resolveSubtitleStyleById(profiles, styleId),
    [profiles]
  );

  return {
    profiles,
    defaultProfile,
    driveFonts,
    isSyncingStyles,
    isSavingStyle,
    lastSyncSource,
    syncSubtitleStyles,
    saveProfile,
    createProfile,
    duplicateProfile,
    deleteProfile,
    getProfileById,
  };
}

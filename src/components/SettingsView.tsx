import { useEffect, useState } from 'react';
import {
  Bug,
  Check,
  ClipboardCopy,
  Cloud,
  Cpu,
  ExternalLink,
  Film,
  Folder,
  HardDrive,
  Mic,
  Monitor,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type {
  AppSettings,
  BrollDensity,
  ExportQuality,
  GeminiModelId,
  PcWorkerStatus,
  ProcessEngineMode,
  RenderJobTarget,
  SubtitleStyleProfile,
  WatchIntervalSec,
  WhisperModelId,
} from '../types';
import type { VideoCacheStats } from '../services/videoStorage';
import {
  clearDebugLogs,
  getDebugLogStats,
  subscribeDebugLogs,
  type DebugLogStats,
} from '../services/debugLogger';
import {
  DEFAULT_GEMINI_MODEL,
  RECOMMENDED_GEMINI_MODELS,
  extractDriveFolderId,
  formatBytes,
  sanitizeGeminiModelName,
} from '../utils/videoPipeline';
import { GoogleSignInButton } from './GoogleSignInButton';
import { SubtitleStyleEditor } from './SubtitleStyleEditor';

interface SettingsViewProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings) => void;
  onResetSettings: () => void;
  user: User | null;
  isLoggingIn: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  geminiConfigured: boolean;
  cloudRenderConfigured: boolean;
  pcWorkerStatus: PcWorkerStatus | null;
  isPcOnline: boolean;
  resolvedTarget: RenderJobTarget;
  isSyncingPcJobs: boolean;
  onSyncPcJobs: () => void;
  cacheStats: VideoCacheStats;
  isClearingCache: boolean;
  onClearVideoCache: () => void;
  onCopyDiagnosticReport: () => Promise<boolean>;
  subtitleProfiles: SubtitleStyleProfile[];
  driveFonts: string[];
  isSyncingSubtitleStyles: boolean;
  isSavingSubtitleStyle: boolean;
  subtitleStylesSyncSource: 'local' | 'drive';
  onChangeDefaultSubtitleStyleId: (styleId: string) => void;
  onSyncSubtitleStyles: () => void;
  onCreateSubtitleProfile: (
    base?: SubtitleStyleProfile,
    customName?: string
  ) => Promise<SubtitleStyleProfile | null>;
  onDuplicateSubtitleProfile: (
    source: SubtitleStyleProfile
  ) => Promise<SubtitleStyleProfile | null>;
  onSaveSubtitleProfile: (
    profile: SubtitleStyleProfile
  ) => Promise<SubtitleStyleProfile | null>;
  onDeleteSubtitleProfile: (profileId: string) => Promise<boolean>;
}

const CLOUD_SETUP_DOC_URL =
  'https://github.com/60F10/AutoCut-Drive-AI/blob/main/worker/CLOUD_SETUP.md';
const PC_WORKER_DOC_URL =
  'https://github.com/60F10/AutoCut-Drive-AI/blob/main/worker/README.md';

export function SettingsView({
  settings,
  onSaveSettings,
  onResetSettings,
  user,
  isLoggingIn,
  onGoogleLogin,
  onGoogleLogout,
  geminiConfigured,
  cloudRenderConfigured,
  pcWorkerStatus,
  isPcOnline,
  resolvedTarget,
  isSyncingPcJobs,
  onSyncPcJobs,
  cacheStats,
  isClearingCache,
  onClearVideoCache,
  onCopyDiagnosticReport,
  subtitleProfiles,
  driveFonts,
  isSyncingSubtitleStyles,
  isSavingSubtitleStyle,
  subtitleStylesSyncSource,
  onChangeDefaultSubtitleStyleId,
  onSyncSubtitleStyles,
  onCreateSubtitleProfile,
  onDuplicateSubtitleProfile,
  onSaveSubtitleProfile,
  onDeleteSubtitleProfile,
}: SettingsViewProps) {
  const [folderInput, setFolderInput] = useState(settings.folderId);
  const [model, setModel] = useState<GeminiModelId>(settings.model);
  const [whisperModel, setWhisperModel] = useState<WhisperModelId>(settings.whisperModel);
  const [processEngine, setProcessEngine] = useState<ProcessEngineMode>(settings.processEngine);
  const [watchIntervalSec, setWatchIntervalSec] = useState<WatchIntervalSec>(
    settings.watchIntervalSec
  );
  const [autoWatchEnabled, setAutoWatchEnabled] = useState(settings.autoWatchEnabled);
  const [autoUploadEnabled, setAutoUploadEnabled] = useState(settings.autoUploadEnabled);
  const [exportQuality, setExportQuality] = useState<ExportQuality>(settings.exportQuality);
  const [voiceoverBrollEnabled, setVoiceoverBrollEnabled] = useState(
    settings.voiceoverBrollEnabled
  );
  const [brollDensity, setBrollDensity] = useState<BrollDensity>(settings.brollDensity);
  const [brollSmoothPanEnabled, setBrollSmoothPanEnabled] = useState(
    settings.brollSmoothPanEnabled
  );
  const [brollAmbientAudioEnabled, setBrollAmbientAudioEnabled] = useState(
    settings.brollAmbientAudioEnabled
  );
  const [savedBanner, setSavedBanner] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [logStats, setLogStats] = useState<DebugLogStats>(() => getDebugLogStats());
  const [copiedReport, setCopiedReport] = useState(false);

  useEffect(() => {
    setLogStats(getDebugLogStats());
    return subscribeDebugLogs(() => setLogStats(getDebugLogStats()));
  }, []);

  const handleCopyReportClick = async () => {
    const ok = await onCopyDiagnosticReport();
    if (ok) {
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 2000);
    }
  };

  const handleClearLogsClick = () => {
    clearDebugLogs();
  };

  useEffect(() => {
    setFolderInput(settings.folderId);
    setModel(settings.model);
    setWhisperModel(settings.whisperModel);
    setProcessEngine(settings.processEngine);
    setWatchIntervalSec(settings.watchIntervalSec);
    setAutoWatchEnabled(settings.autoWatchEnabled);
    setAutoUploadEnabled(settings.autoUploadEnabled);
    setExportQuality(settings.exportQuality);
    setVoiceoverBrollEnabled(settings.voiceoverBrollEnabled);
    setBrollDensity(settings.brollDensity);
    setBrollSmoothPanEnabled(settings.brollSmoothPanEnabled);
    setBrollAmbientAudioEnabled(settings.brollAmbientAudioEnabled);
  }, [settings]);

  const parsedFolderId = extractDriveFolderId(folderInput);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (autoWatchEnabled && !parsedFolderId) {
      setValidationError(
        'Introduce un ID o enlace de carpeta de Google Drive antes de activar la vigilancia automática.'
      );
      return;
    }

    const rawModel = model.trim().replace(/^models\//i, '');
    if (rawModel && !/^[a-zA-Z0-9._-]{3,80}$/.test(rawModel)) {
      setValidationError(
        'El nombre del modelo de Gemini solo puede contener letras, números, puntos, guiones y guiones bajos.'
      );
      return;
    }

    const cleanedModel = sanitizeGeminiModelName(rawModel, DEFAULT_GEMINI_MODEL);

    onSaveSettings({
      folderId: parsedFolderId,
      model: cleanedModel,
      whisperModel,
      processEngine,
      watchIntervalSec,
      autoWatchEnabled,
      autoUploadEnabled,
      exportQuality,
      voiceoverBrollEnabled,
      brollDensity,
      brollSmoothPanEnabled,
      brollAmbientAudioEnabled,
      defaultSubtitleStyleId: settings.defaultSubtitleStyleId,
    });
    setFolderInput(parsedFolderId);
    setModel(cleanedModel);
    setSavedBanner(true);
    window.setTimeout(() => setSavedBanner(false), 3000);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      <form
        onSubmit={handleSubmit}
        className="xl:col-span-7 cyber-panel rounded-md divide-y divide-[#00f0ff]/20 overflow-hidden"
      >
        {/* Section 1: Google Drive Folder */}
        <div className="p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Carpeta vigilada de Google Drive
            </h2>
            <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
              Pega el ID de tu carpeta o la URL completa de Google Drive. La app ignorará cualquier archivo con <span className="font-mono text-[#fcee0a]">_EDITADO</span> para evitar bucles infinitos.
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="drive-folder-id"
              className="block text-xs font-medium text-[#C8D7EC]"
            >
              ID o enlace de carpeta de Google Drive
            </label>
            <div className="relative">
              <Folder
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#00f0ff]"
                aria-hidden="true"
              />
              <input
                id="drive-folder-id"
                type="text"
                value={folderInput}
                onChange={(e) => {
                  setFolderInput(e.target.value);
                  setValidationError(null);
                }}
                placeholder="Ej: 1A2B3C4D5E6F7G8H9I0J o https://drive.google.com/drive/folders/..."
                className="h-11 sm:h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] pl-9 pr-3 font-mono text-xs text-[#EEF5FF] placeholder:text-[#5F738E] focus:border-[#00f0ff] focus:outline-none"
              />
            </div>

            {folderInput.trim() && parsedFolderId !== folderInput.trim() && (
              <p className="text-xs text-[#00f0ff]">
                ID detectado automáticamente:{' '}
                <span className="font-mono font-semibold text-[#fcee0a]">{parsedFolderId}</span>
              </p>
            )}
          </div>
        </div>

        {/* Section 2: Gemini Model */}
        <div className="p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Modelo de análisis Gemini
            </h2>
            <p className="mt-1 text-xs text-[#94A8C4]">
              Tu vídeo bruto nunca sale del dispositivo: el navegador extrae entre 12 y 16 fotogramas ligeros (480px JPEG, &lt; 2 MB) para analizarlos con Gemini sin errores 413.
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label="Seleccionar modelo de Gemini"
            className="grid grid-cols-1 sm:grid-cols-3 gap-3"
          >
            {RECOMMENDED_GEMINI_MODELS.map((option) => {
              const selected = model.trim().replace(/^models\//i, '') === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-model-${option.id}`}
                  onClick={() => {
                    setModel(option.id);
                    setValidationError(null);
                  }}
                  className={`min-h-[44px] rounded-md border p-3.5 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 hover:border-[#00f0ff]/45'
                  }`}
                >
                  <p
                    className={`font-mono text-xs font-semibold break-all ${
                      selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                    }`}
                  >
                    {option.title}
                  </p>
                  <p className="mt-1.5 text-[11px] text-[#94A8C4] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5 pt-1">
            <label
              htmlFor="gemini-model-input"
              className="block text-xs font-medium text-[#C8D7EC]"
            >
              Modelo personalizado o sobrescritura directa
            </label>
            <div className="relative">
              <Cpu
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#00f0ff]"
                aria-hidden="true"
              />
              <input
                id="gemini-model-input"
                data-testid="gemini-model-input"
                type="text"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setValidationError(null);
                }}
                placeholder={DEFAULT_GEMINI_MODEL}
                className="h-11 sm:h-10 w-full rounded-md border border-[#00f0ff]/25 bg-[#05060a] pl-9 pr-3 font-mono text-xs text-[#EEF5FF] placeholder:text-[#5F738E] focus:border-[#00f0ff] focus:outline-none"
              />
            </div>
            <p className="text-[11px] text-[#8EA2BD] leading-relaxed">
              Si Google jubila o lanza un nuevo modelo, puedes escribir aquí su identificador exacto (por defecto{' '}
              <span className="font-mono text-[#00f0ff]">{DEFAULT_GEMINI_MODEL}</span>) o configurarlo mediante{' '}
              <span className="font-mono text-[#fcee0a]">VITE_GEMINI_MODEL</span> /{' '}
              <span className="font-mono text-[#fcee0a]">GEMINI_MODEL</span>.
            </p>
          </div>
        </div>

        {/* Section 2.1: Process Engine Routing (PC primary + Cloud fallback) */}
        <div
          data-testid="settings-process-engine-section"
          className="p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-2.5">
            <Monitor className="h-4 w-4 text-[#00f0ff] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Motor de proceso
              </h2>
              <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
                Elige dónde se ejecutan el análisis (Whisper + Gemini) y el renderizado (FFmpeg). En modo automático, usa tu PC cuando está en línea y pasa a GitHub Actions si está apagado.
              </p>
            </div>
          </div>

          <div
            role="radiogroup"
            aria-label="Motor de proceso"
            className="grid grid-cols-1 sm:grid-cols-3 gap-3"
          >
            {(
              [
                {
                  id: 'auto',
                  title: 'Automático (recomendado)',
                  badge: resolvedTarget === 'pc' ? 'Destino actual: PC' : 'Destino actual: NUBE',
                  desc: 'Envía al PC si envió latido en los últimos 3 min; si está apagado, usa GitHub Actions.',
                },
                {
                  id: 'pc',
                  title: 'Solo PC',
                  badge: 'RTX / CUDA + NVENC',
                  desc: 'Deja siempre los trabajos en cola para tu PC Windows (nunca dispara GitHub Actions automáticamente).',
                },
                {
                  id: 'cloud',
                  title: 'Solo nube',
                  badge: 'GitHub Actions',
                  desc: 'Envía siempre análisis y renders a GitHub Actions aunque el PC esté encendido.',
                },
              ] as Array<{ id: ProcessEngineMode; title: string; badge: string; desc: string }>
            ).map((option) => {
              const selected = processEngine === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-engine-${option.id}`}
                  onClick={() => setProcessEngine(option.id)}
                  className={`min-h-[44px] rounded-md border p-3.5 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 hover:border-[#00f0ff]/45'
                  }`}
                >
                  <p
                    className={`font-mono text-xs font-semibold ${
                      selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                    }`}
                  >
                    {option.title}
                  </p>
                  <p className="mt-1 font-mono text-[10px] font-medium text-[#fcee0a]">
                    {option.badge}
                  </p>
                  <p className="mt-1.5 text-[11px] text-[#94A8C4] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 2.2: Whisper Transcription Model */}
        <div
          data-testid="settings-whisper-section"
          className="p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-2.5">
            <Mic className="h-4 w-4 text-[#00f0ff] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Modelo de transcripción
              </h2>
              <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
                Usado por Whisper (<span className="font-mono text-[#00f0ff]">faster-whisper</span> en GitHub Actions) para transcribir el audio real y sincronizar cortes y subtítulos. Tiene prioridad sobre la variable <span className="font-mono text-[#fcee0a]">WHISPER_MODEL</span> del repositorio.
              </p>
            </div>
          </div>

          <div
            role="radiogroup"
            aria-label="Modelo de transcripción Whisper"
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            {(
              [
                {
                  id: 'small',
                  title: 'small (recomendado)',
                  specs: 'Rápido · ~3–5 min por 10 min de bruto',
                  desc: 'Equilibrio óptimo entre velocidad y precisión en español para la mayoría de vlogs y vídeos grabados con móvil.',
                },
                {
                  id: 'medium',
                  title: 'medium (más preciso y más lento)',
                  specs: 'Alta precisión · ~6–9 min por 10 min de bruto',
                  desc: 'Mejor reconocimiento con ruido de fondo, música o varios hablantes. Las transcripciones se guardan en caché en Drive.',
                },
              ] as Array<{ id: WhisperModelId; title: string; specs: string; desc: string }>
            ).map((option) => {
              const selected = whisperModel === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-whisper-${option.id}`}
                  onClick={() => setWhisperModel(option.id)}
                  className={`min-h-[44px] rounded-md border p-4 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 hover:border-[#00f0ff]/45'
                  }`}
                >
                  <p
                    className={`font-mono text-xs font-semibold ${
                      selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                    }`}
                  >
                    {option.title}
                  </p>
                  <p className="mt-1 font-mono text-[11px] font-medium text-[#fcee0a]">
                    {option.specs}
                  </p>
                  <p className="mt-1.5 text-xs text-[#94A8C4] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 2.5: FFmpeg.wasm Render Quality / Mobile Performance Mode */}
        <div className="p-5 sm:p-6 space-y-4">
          <div className="flex items-start gap-2.5">
            <Zap className="h-4 w-4 text-[#fcee0a] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Modo de renderizado FFmpeg.wasm
              </h2>
              <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
                El modo rápido móvil (720p) reduce el uso de RAM y acelera el exportado ~3× en Safari iOS y Android.
              </p>
            </div>
          </div>

          <div
            role="radiogroup"
            aria-label="Modo de renderizado de vídeo"
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            {(
              [
                {
                  id: 'mobile_fast',
                  title: 'Rápido móvil — 720p',
                  specs: '720×1280 · 30fps · ultrafast · CRF 26',
                  desc: 'Recomendado en iPhone y Android. Exportado mucho más rápido y menos memoria.',
                },
                {
                  id: 'high_1080p',
                  title: 'Máxima calidad — 1080p',
                  specs: '1080×1920 · 30fps · veryfast · CRF 21',
                  desc: 'Máxima nitidez vertical para escritorio o clips cortos con buena RAM disponible.',
                },
              ] as Array<{ id: ExportQuality; title: string; specs: string; desc: string }>
            ).map((option) => {
              const selected = exportQuality === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-quality-${option.id}`}
                  onClick={() => setExportQuality(option.id)}
                  className={`min-h-[44px] rounded-md border p-4 text-left transition-all ${
                    selected
                      ? 'border-[#00f0ff] bg-[#00f0ff]/10 shadow-[0_0_16px_rgba(0,240,255,0.16)]'
                      : 'border-[#00f0ff]/20 bg-[#05060a]/85 hover:border-[#00f0ff]/45'
                  }`}
                >
                  <p
                    className={`text-xs font-semibold ${
                      selected ? 'text-[#00f0ff]' : 'text-[#EEF5FF]'
                    }`}
                  >
                    {option.title}
                  </p>
                  <p className="mt-1 font-mono text-[11px] font-medium text-[#fcee0a]">
                    {option.specs}
                  </p>
                  <p className="mt-1.5 text-xs text-[#94A8C4] leading-relaxed">{option.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section 2.6: Voiceover B-Roll ("Voz sobre recursos") */}
        <div
          data-testid="settings-broll-section"
          className="p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-2.5">
            <Film className="h-4 w-4 text-[#a855f7] shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Voz sobre recursos (B-roll)
              </h2>
              <p className="mt-1 text-xs text-[#94A8C4] leading-relaxed">
                Mientras hablas a cámara de algo que aparece en otro plano, el vídeo muestra ese recurso manteniendo tu voz continua sin cortes.
              </p>
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              data-testid="settings-broll-toggle"
              checked={voiceoverBrollEnabled}
              onChange={(e) => setVoiceoverBrollEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
            />
            <span>
              <span className="block text-sm font-medium text-[#EEF5FF]">
                Activar Voz sobre recursos
              </span>
              <span className="block text-xs text-[#94A8C4]">
                Activado por defecto. Si se desactiva, el montaje conserva exactamente el comportamiento tradicional.
              </span>
            </span>
          </label>

          <div className={`space-y-4 transition-opacity ${voiceoverBrollEnabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
            <div className="space-y-2">
              <label className="block text-xs font-medium text-[#C8D7EC]">
                Densidad de recursos sobre la voz
              </label>
              <div
                role="radiogroup"
                aria-label="Densidad de recursos B-roll"
                className="inline-flex flex-wrap items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-1"
              >
                {(
                  [
                    { value: 'baja', label: 'Baja (1 cada 20s)' },
                    { value: 'media', label: 'Media (1 cada 10s)' },
                    { value: 'alta', label: 'Alta (1 cada 6s)' },
                  ] as Array<{ value: BrollDensity; label: string }>
                ).map((opt) => {
                  const active = brollDensity === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!voiceoverBrollEnabled}
                      data-testid={`settings-broll-density-${opt.value}`}
                      onClick={() => setBrollDensity(opt.value)}
                      className={`min-h-[36px] rounded-sm px-3.5 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-[#a855f7]/22 text-[#e9d5ff] border border-[#a855f7]/50'
                          : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!voiceoverBrollEnabled}
                  data-testid="settings-broll-pan-toggle"
                  checked={brollSmoothPanEnabled}
                  onChange={(e) => setBrollSmoothPanEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
                />
                <span>
                  <span className="block text-sm font-medium text-[#EEF5FF]">
                    Paneo suave en planos horizontales
                  </span>
                  <span className="block text-xs text-[#94A8C4]">
                    Desplaza suavemente un 8 % el recorte 9:16 centrado en el sujeto cuando el recurso es horizontal.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!voiceoverBrollEnabled}
                  data-testid="settings-broll-ambient-toggle"
                  checked={brollAmbientAudioEnabled}
                  onChange={(e) => setBrollAmbientAudioEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
                />
                <span>
                  <span className="block text-sm font-medium text-[#EEF5FF]">
                    Sonido ambiente del recurso
                  </span>
                  <span className="block text-xs text-[#94A8C4]">
                    Silenciado por defecto. Si se activa, mezcla el sonido ambiente del plano recurso a −20 dB bajo tu voz.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Section 3: Watch Mode & Interval */}
        <div className="p-5 sm:p-6 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
              Vigilancia automática y subida
            </h2>
            <p className="mt-1 text-xs text-[#94A8C4]">
              Escanea la carpeta automáticamente mientras esta pestaña permanezca abierta.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-[#C8D7EC]">
              Intervalo de vigilancia
            </label>
            <div className="inline-flex items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#05060a] p-1">
              {(
                [
                  { value: 30, label: '30s' },
                  { value: 60, label: '60s' },
                  { value: 300, label: '5min' },
                ] as Array<{ value: WatchIntervalSec; label: string }>
              ).map((opt) => {
                const active = watchIntervalSec === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setWatchIntervalSec(opt.value)}
                    aria-pressed={active}
                    className={`min-h-[36px] rounded-sm px-4 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[#00f0ff]/18 text-[#00f0ff]'
                        : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoWatchEnabled}
                onChange={(e) => setAutoWatchEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
              />
              <span>
                <span className="block text-sm font-medium text-[#EEF5FF]">
                  Activar Modo Vigilancia Automática
                </span>
                <span className="block text-xs text-[#94A8C4]">
                  Busca nuevos vídeos brutos en la carpeta según el intervalo elegido y los añade a la cola.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoUploadEnabled}
                onChange={(e) => setAutoUploadEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#00f0ff]"
              />
              <span>
                <span className="block text-sm font-medium text-[#EEF5FF]">
                  Solicitar subida a Google Drive al terminar el render
                </span>
                <span className="block text-xs text-[#94A8C4]">
                  Al finalizar FFmpeg.wasm te pedirá confirmación antes de guardar el archivo <span className="font-mono text-[#fcee0a]">_EDITADO_ETIQUETA.mp4</span> en tu carpeta.
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Form Footer */}
        <div className="p-5 sm:p-6 flex flex-wrap items-center justify-between gap-3 bg-[#05060a]/80">
          <div className="min-w-0">
            {validationError ? (
              <p className="font-mono text-xs text-[#ff6ca9]">{validationError}</p>
            ) : savedBanner ? (
              <p className="inline-flex items-center gap-1.5 font-mono text-xs text-[#00f0ff]">
                <Check className="h-3.5 w-3.5" />
                Ajustes guardados en este navegador
              </p>
            ) : (
              <p className="text-xs text-[#8EA2BD]">
                Preferencias guardadas localmente en localStorage.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onResetSettings}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border border-[#00f0ff]/25 px-3 text-xs font-medium text-[#8EA2BD] hover:border-[#00f0ff]/55 hover:text-white transition-colors whitespace-nowrap"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Restablecer
            </button>
            <button
              type="submit"
              className="cyber-btn-primary inline-flex h-10 items-center gap-2 px-4 text-xs whitespace-nowrap"
            >
              <Save className="h-3.5 w-3.5" />
              Guardar ajustes
            </button>
          </div>
        </div>
      </form>

      {/* Right column: Connections, IndexedDB Cache & Quick Folder Guide */}
      <div className="xl:col-span-5 space-y-5">
        <section className="cyber-panel rounded-md p-5 sm:p-6 space-y-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-[#00f0ff] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Conexiones y seguridad
              </h2>
              <p className="text-xs text-[#94A8C4] leading-relaxed">
                Las llamadas a Gemini se ejecutan en el servidor usando la clave del entorno (
                <span className="font-mono text-[#00f0ff]">
                  {geminiConfigured ? 'Gemini disponible' : 'pendiente en Secrets'}
                </span>
                ). Tu token de Google Drive se guarda solo en memoria mientras la pestaña está abierta.
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-3 border-t border-[#00f0ff]/20">
            <div className="text-xs">
              <p className="font-medium text-[#EEF5FF]">Cuenta de Google Drive</p>
              <p className="mt-0.5 font-mono text-[#94A8C4]">
                {user ? `Conectada como ${user.email}` : 'No conectada todavía'}
              </p>
            </div>

            {user ? (
              <button
                type="button"
                onClick={onGoogleLogout}
                className="h-10 w-full rounded-md border border-[#ff2a85]/40 bg-[#ff2a85]/10 px-3 text-xs font-medium text-[#EEF5FF] hover:bg-[#ff2a85]/20 transition-colors"
              >
                Desconectar Google Drive
              </button>
            ) : (
              <GoogleSignInButton onClick={onGoogleLogin} loading={isLoggingIn} />
            )}
          </div>
        </section>

        {/* PC Worker Status Card (Heartbeat from _AutoCut_Jobs/_worker_status.json) */}
        <section
          data-testid="pc-worker-status-card"
          className="cyber-panel rounded-md p-5 sm:p-6 space-y-4 border border-[#00f0ff]/35"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <Monitor className="h-5 w-5 text-[#00f0ff] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                  Estado del PC
                </h2>
                <p className="text-xs text-[#94A8C4] leading-relaxed">
                  Motor principal con GPU NVIDIA (Whisper CUDA + NVENC). Lee el latido de{' '}
                  <span className="font-mono text-[#C8D7EC]">_worker_status.json</span> en Drive.
                </p>
              </div>
            </div>
            <span
              data-testid="pc-worker-status-badge"
              className={`font-mono text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-sm border shrink-0 ${
                isPcOnline
                  ? 'border-[#00f0ff]/55 bg-[#00f0ff]/12 text-[#00f0ff]'
                  : 'border-[#fcee0a]/45 bg-[#fcee0a]/10 text-[#fcee0a]'
              }`}
            >
              {isPcOnline ? 'En línea' : 'Apagado'}
            </span>
          </div>

          {pcWorkerStatus ? (
            <div className="grid grid-cols-2 gap-2.5 text-[11px]">
              <div className="rounded-sm border border-[#00f0ff]/18 bg-[#05060a] px-3 py-2">
                <p className="text-[#8EA2BD]">Encoder</p>
                <p className="mt-0.5 font-mono font-semibold text-[#00f0ff]">
                  {pcWorkerStatus.encoder || 'auto'}
                </p>
              </div>
              <div className="rounded-sm border border-[#00f0ff]/18 bg-[#05060a] px-3 py-2">
                <p className="text-[#8EA2BD]">Whisper</p>
                <p className="mt-0.5 font-mono font-semibold text-[#EEF5FF]">
                  {pcWorkerStatus.whisperModel || 'medium'} ·{' '}
                  {(pcWorkerStatus.whisperDevice || 'auto').toUpperCase()}
                </p>
              </div>
              <div className="rounded-sm border border-[#00f0ff]/18 bg-[#05060a] px-3 py-2">
                <p className="text-[#8EA2BD]">Actividad</p>
                <p
                  className={`mt-0.5 font-mono font-semibold ${
                    pcWorkerStatus.busy ? 'text-[#fcee0a]' : 'text-[#00f0ff]'
                  }`}
                >
                  {pcWorkerStatus.busy ? 'Procesando trabajo' : 'Disponible'}
                </p>
              </div>
              <div className="rounded-sm border border-[#00f0ff]/18 bg-[#05060a] px-3 py-2">
                <p className="text-[#8EA2BD]">Último latido</p>
                <p className="mt-0.5 font-mono font-semibold tabular-nums text-[#C8D7EC]">
                  {new Date(pcWorkerStatus.lastSeen).toLocaleTimeString('es-ES', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </p>
              </div>
            </div>
          ) : (
            <p className="rounded-sm border border-[#00f0ff]/15 bg-[#05060a] px-3 py-2 text-[11px] text-[#94A8C4] leading-relaxed">
              Sin señal reciente de <span className="font-mono text-[#C8D7EC]">_worker_status.json</span>. Cuando arranques el worker en tu PC Windows aparecerá aquí en línea.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onSyncPcJobs}
              disabled={isSyncingPcJobs || !user || !settings.folderId}
              data-testid="settings-refresh-pc-status-btn"
              className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/45 bg-[#00f0ff]/12 px-3 font-mono text-xs font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/22 disabled:opacity-45 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncingPcJobs ? 'animate-spin' : ''}`} />
              {isSyncingPcJobs ? 'Comprobando...' : 'Comprobar ahora'}
            </button>
            <a
              href={PC_WORKER_DOC_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="pc-worker-guide-link"
              className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3 font-mono text-xs font-medium text-[#C8D7EC] hover:border-[#00f0ff]/60 hover:text-[#00f0ff] transition-colors"
            >
              Guía PC (worker/README)
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          </div>
        </section>

        {/* Cloud Render (GitHub Actions) Status Card */}
        <section
          data-testid="cloud-render-settings-card"
          className="cyber-panel rounded-md p-5 sm:p-6 space-y-4 border border-[#00f0ff]/35"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <Cloud className="h-5 w-5 text-[#00f0ff] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                  Respaldo en la nube (GitHub Actions)
                </h2>
                <p className="text-xs text-[#94A8C4] leading-relaxed">
                  Transcripción con Whisper, guion multimodal con Gemini y renderizado con FFmpeg nativo en GitHub Actions cuando el PC está apagado (coste 0 €, sin tarjeta).
                </p>
              </div>
            </div>
            <span
              data-testid="cloud-render-status-badge"
              className={`font-mono text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-sm border shrink-0 ${
                cloudRenderConfigured
                  ? 'border-[#00f0ff]/55 bg-[#00f0ff]/12 text-[#00f0ff]'
                  : 'border-[#fcee0a]/50 bg-[#fcee0a]/10 text-[#fcee0a]'
              }`}
            >
              {cloudRenderConfigured ? 'Configurado' : 'No configurado'}
            </span>
          </div>

          <p className="rounded-sm border border-[#00f0ff]/15 bg-[#05060a] px-3 py-2 text-[11px] text-[#94A8C4] leading-relaxed">
            {cloudRenderConfigured
              ? 'El servidor tiene los secretos de GitHub Actions listos. En modo Automático se usará como respaldo si tu PC está apagado.'
              : 'Faltan las variables de servidor GITHUB_DISPATCH_TOKEN y GITHUB_REPO en Secrets (y GEMINI_API_KEY en GitHub Secrets para el análisis). Sigue la guía paso a paso.'}
          </p>

          <a
            href={CLOUD_SETUP_DOC_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="cloud-setup-guide-link"
            className="inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/45 bg-[#00f0ff]/12 px-3.5 font-mono text-xs font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/22 transition-colors"
          >
            Ver guía de configuración (CLOUD_SETUP.md)
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        </section>

        {/* Diagnostic & Support Card */}
        <section
          data-testid="diagnostic-support-card"
          className="cyber-panel rounded-md p-5 sm:p-6 space-y-4 border border-[#00f0ff]/35"
        >
          <div className="flex items-start gap-3">
            <Bug className="h-5 w-5 text-[#fcee0a] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Diagnóstico y soporte
              </h2>
              <p className="text-xs text-[#94A8C4] leading-relaxed">
                Copia en un toque la cronología de acciones, configuración y errores (sin tokens ni claves) para pegarla en un chat y depurar desde el móvil.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3.5 py-2.5">
              <p className="text-[11px] text-[#8EA2BD]">Eventos registrados</p>
              <p
                data-testid="diagnostic-events-count"
                className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#00f0ff]"
              >
                {logStats.total} / {logStats.maxEntries}
              </p>
            </div>
            <div className="rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3.5 py-2.5">
              <p className="text-[11px] text-[#8EA2BD]">Errores capturados</p>
              <p
                data-testid="diagnostic-errors-count"
                className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                  logStats.errors > 0 ? 'text-[#ff6ca9]' : 'text-[#EEF5FF]'
                }`}
              >
                {logStats.errors}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={handleCopyReportClick}
              data-testid="copy-diagnostic-report-btn"
              className="cyber-btn-primary inline-flex min-h-[44px] w-full items-center justify-center gap-2 px-3.5 text-xs whitespace-nowrap"
            >
              {copiedReport ? (
                <>
                  <Check className="h-4 w-4" />
                  ¡Copiado!
                </>
              ) : (
                <>
                  <ClipboardCopy className="h-4 w-4" />
                  Copiar informe completo
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleClearLogsClick}
              disabled={logStats.total === 0}
              data-testid="clear-diagnostic-log-btn"
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-3.5 text-xs font-medium text-[#C8D7EC] hover:border-[#ff2a85]/60 hover:text-[#ff85b8] disabled:opacity-45 transition-colors whitespace-nowrap"
            >
              <Trash2 className="h-4 w-4" />
              Limpiar registro
            </button>
          </div>
        </section>

        {/* IndexedDB Local Video Cache */}
        <section
          data-testid="video-cache-card"
          className="cyber-panel rounded-md p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-3">
            <HardDrive className="h-5 w-5 text-[#00f0ff] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#EEF5FF]">
                Caché local de vídeos (IndexedDB)
              </h2>
              <p className="text-xs text-[#94A8C4] leading-relaxed">
                Los últimos {cacheStats.maxItems} MP4 renderizados se guardan en tu dispositivo para reproducirlos y descargarlos incluso tras recargar la app. Los más antiguos se limpian automáticamente sin borrar los metadatos ni tus enlaces de Drive.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-[#00f0ff]/25 bg-[#05060a] px-4 py-3 text-xs">
            <span className="text-[#8EA2BD]">Espacio usado</span>
            <span
              data-testid="video-cache-stats"
              className="font-mono font-semibold tabular-nums text-[#fcee0a]"
            >
              {cacheStats.count} / {cacheStats.maxItems} vídeos · {formatBytes(cacheStats.totalBytes)}
            </span>
          </div>

          <button
            type="button"
            onClick={onClearVideoCache}
            disabled={cacheStats.count === 0 || isClearingCache}
            data-testid="clear-video-cache-btn"
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[#ff2a85]/35 bg-[#05060a] px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#ff2a85]/70 hover:bg-[#ff2a85]/12 disabled:opacity-45 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5 text-[#ff2a85]" />
            {isClearingCache ? 'Vaciando caché...' : 'Vaciar caché de vídeos'}
          </button>
        </section>

        <section className="cyber-panel rounded-md p-5 sm:p-6 space-y-3">
          <h2 className="font-display text-sm font-semibold text-[#EEF5FF]">
            Cómo obtener el ID de tu carpeta
          </h2>
          <ol className="space-y-2.5 text-xs text-[#94A8C4] leading-relaxed list-decimal list-inside">
            <li>Abre tu carpeta de vídeos brutos en Google Drive.</li>
            <li>
              Copia la URL de la barra del navegador, por ejemplo{' '}
              <span className="font-mono text-[#00f0ff] break-all">
                drive.google.com/drive/folders/1A2B3C...
              </span>
              .
            </li>
            <li>Pégala arriba y la aplicación extraerá el ID automáticamente.</li>
          </ol>
          <p className="pt-2 border-t border-[#00f0ff]/20 text-[11px] text-[#8EA2BD] leading-relaxed">
            Consejo para iPhone/Android: activa el modo rápido móvil (720p) para renderizar clips largos sin agotar la memoria del navegador.
          </p>
        </section>
      </div>

      {/* Full-width Subtitle Style Profiles Editor & 9:16 Live Preview */}
      <SubtitleStyleEditor
        profiles={subtitleProfiles}
        defaultStyleId={settings.defaultSubtitleStyleId}
        driveFonts={driveFonts}
        isDriveConnected={Boolean(user)}
        hasFolderId={Boolean(settings.folderId)}
        isSyncingStyles={isSyncingSubtitleStyles}
        isSavingStyle={isSavingSubtitleStyle}
        lastSyncSource={subtitleStylesSyncSource}
        onChangeDefaultStyleId={onChangeDefaultSubtitleStyleId}
        onSyncStyles={onSyncSubtitleStyles}
        onCreateProfile={onCreateSubtitleProfile}
        onDuplicateProfile={onDuplicateSubtitleProfile}
        onSaveProfile={onSaveSubtitleProfile}
        onDeleteProfile={onDeleteSubtitleProfile}
      />
    </div>
  );
}

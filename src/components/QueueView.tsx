import { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  ExternalLink,
  Film,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import type {
  AnalyticsRecord,
  DriveFileMeta,
  EditStylePreset,
  ExportQuality,
  PcJobSyncEntry,
  QueueItem,
  QueueStage,
  TikTokEditOptions,
} from '../types';
import {
  exceedsMobileRamThreshold,
  formatAnalyzeStageLabel,
  formatBytes,
  formatPcJobStatusLabel,
  formatSeconds,
} from '../utils/videoPipeline';
import { QueueAnalyticsPanel } from './QueueAnalyticsPanel';
import { EditStyleControls } from './EditStyleControls';
import { PcJobsPanel } from './PcJobsPanel';

type StatusFilter = 'all' | 'pending' | 'active' | 'completed';

interface QueueViewProps {
  items: QueueItem[];
  analyticsRecords: AnalyticsRecord[];
  selectedIds: string[];
  onToggleSelectItem: (itemId: string) => void;
  onClearSelection: () => void;
  onOpenMultiClipComposer: () => void;
  onRemoveItem: (itemId: string) => void;
  onClearPending: () => void;
  stylePreset: EditStylePreset;
  onChangeStylePreset: (preset: EditStylePreset) => void;
  customInstruction: string;
  onChangeCustomInstruction: (value: string) => void;
  tiktokOptions: TikTokEditOptions;
  onChangeTikTokOptions: (patch: Partial<TikTokEditOptions>) => void;
  exportQuality: ExportQuality;
  onChangeExportQuality: (quality: ExportQuality) => void;
  alreadyEditedCount: number;
  lastScanTime: number | null;
  isScanning: boolean;
  isProcessingAny: boolean;
  isDriveConnected: boolean;
  folderId: string;
  onScanFolder: () => void;
  onProcessItem: (itemId: string) => void;
  onCloudAnalyzeItem: (itemId: string) => void;
  onProcessAllPending: () => void;
  onOpenStudio: (itemId: string) => void;
  onAddLocalFiles: (files: FileList) => void;
  onLoadDemo: () => void;
  onGoToSettings: () => void;
  pcJobs: PcJobSyncEntry[];
  pcOutputs: DriveFileMeta[];
  cloudRenderConfigured: boolean;
  sendingAnalyzeId: string | null;
  cloudUploadProgress: {
    clipIndex: number;
    totalClips: number;
    percent: number;
    message: string;
  } | null;
  isSyncingPcJobs: boolean;
  lastPcSyncTime: number | null;
  downloadingOutputId: string | null;
  pcOutputPreviewUrls: Record<string, string>;
  failedDispatchJobFileIds: Record<string, string>;
  retryingDispatchJobFileId: string | null;
  onSyncPcJobs: () => void;
  onDownloadPcOutput: (outputFile: DriveFileMeta, triggerSave?: boolean) => void;
  onRetryCloudDispatch: (jobFileId: string) => void;
}

const STAGE_ORDER: QueueStage[] = [
  'pending',
  'downloading',
  'analyzing',
  'review',
  'rendering',
  'uploading',
  'completed',
];

const STAGE_LABELS: Record<QueueStage, string> = {
  pending: 'Pendiente',
  downloading: 'Descargando',
  analyzing: 'Analizando',
  review: 'Revisar EDL',
  rendering: 'Renderizando',
  uploading: 'Subiendo',
  completed: 'Completado',
  error: 'Error',
};

function isActiveStage(stage: QueueStage): boolean {
  return (
    stage === 'downloading' ||
    stage === 'analyzing' ||
    stage === 'review' ||
    stage === 'rendering' ||
    stage === 'uploading'
  );
}

function isSafeHttpsUrl(url?: string | null): url is string {
  return typeof url === 'string' && /^https:\/\//i.test(url.trim());
}

export function QueueView({
  items,
  analyticsRecords,
  selectedIds,
  onToggleSelectItem,
  onClearSelection,
  onOpenMultiClipComposer,
  onRemoveItem,
  onClearPending,
  stylePreset,
  onChangeStylePreset,
  customInstruction,
  onChangeCustomInstruction,
  tiktokOptions,
  onChangeTikTokOptions,
  exportQuality,
  onChangeExportQuality,
  alreadyEditedCount,
  lastScanTime,
  isScanning,
  isProcessingAny,
  isDriveConnected,
  folderId,
  onScanFolder,
  onProcessItem,
  onCloudAnalyzeItem,
  onProcessAllPending,
  onOpenStudio,
  onAddLocalFiles,
  onLoadDemo,
  onGoToSettings,
  pcJobs,
  pcOutputs,
  cloudRenderConfigured,
  sendingAnalyzeId,
  cloudUploadProgress,
  isSyncingPcJobs,
  lastPcSyncTime,
  downloadingOutputId,
  pcOutputPreviewUrls,
  failedDispatchJobFileIds,
  retryingDispatchJobFileId,
  onSyncPcJobs,
  onDownloadPcOutput,
  onRetryCloudDispatch,
}: QueueViewProps) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [recentUploadRamBytes, setRecentUploadRamBytes] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const counts = useMemo(() => {
    let pending = 0;
    let active = 0;
    let completed = 0;
    for (const item of items) {
      if (item.stage === 'pending' || item.stage === 'error') pending += 1;
      else if (isActiveStage(item.stage)) active += 1;
      else if (item.stage === 'completed') completed += 1;
    }
    return { pending, active, completed };
  }, [items]);

  const selectedTotalBytes = useMemo(
    () =>
      items
        .filter((i) => selectedSet.has(i.id))
        .reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    [items, selectedSet]
  );

  const showMobileRamNotice =
    exceedsMobileRamThreshold(selectedTotalBytes) ||
    exceedsMobileRamThreshold(recentUploadRamBytes);

  const ramWarningBytes = Math.max(selectedTotalBytes, recentUploadRamBytes);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'pending' && item.stage !== 'pending' && item.stage !== 'error') {
        return false;
      }
      if (filter === 'active' && !isActiveStage(item.stage)) {
        return false;
      }
      if (filter === 'completed' && item.stage !== 'completed') {
        return false;
      }
      if (q) {
        const hay = `${item.originalName} ${item.outputFileName ?? ''} ${item.analysis?.etiqueta ?? ''} ${item.analysis?.titulo_interno ?? ''}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [items, filter, query]);

  const lastScanFormatted = lastScanTime
    ? new Date(lastScanTime).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'Sin escanear';

  const handleLocalFilePick = (fileList: FileList) => {
    let sumBytes = 0;
    for (let i = 0; i < fileList.length; i += 1) {
      sumBytes += fileList[i].size;
    }
    if (exceedsMobileRamThreshold(sumBytes)) {
      setRecentUploadRamBytes(sumBytes);
    } else {
      setRecentUploadRamBytes(0);
    }
    onAddLocalFiles(fileList);
  };

  return (
    <div className={`space-y-5 sm:space-y-6 ${selectedIds.length >= 2 ? 'pb-24' : ''}`}>
      {/* Mobile Thumb-Safe Primary Action Strip (moved out of top status bar area) */}
      <section
        aria-label="Acciones rápidas móviles"
        data-testid="mobile-action-strip"
        className="md:hidden grid grid-cols-2 gap-2.5"
      >
        <button
          type="button"
          onClick={onScanFolder}
          disabled={isScanning}
          className="cyber-btn-primary inline-flex min-h-[46px] items-center justify-center gap-2 px-3.5 text-xs disabled:opacity-50 whitespace-nowrap"
        >
          <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
          {isScanning ? 'Escaneando...' : 'Escanear carpeta'}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-md border border-[#00f0ff]/35 bg-[#0c0f1a]/90 px-3.5 text-xs font-medium text-[#EEF5FF] hover:border-[#00f0ff]/65 hover:bg-[#13192c] transition-colors whitespace-nowrap"
        >
          <Upload className="h-4 w-4 text-[#00f0ff]" />
          Subir vídeos
        </button>
      </section>

      {/* HUD Summary Metrics Strip */}
      <section
        aria-label="Resumen de la cola"
        className="grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden border border-[#00f0ff]/25 rounded-md bg-[#00f0ff]/20"
      >
        <div className="bg-[#0c0f1a]/95 px-4 sm:px-5 py-4">
          <p className="text-xs text-[#8EA2BD]">Pendientes</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#EEF5FF]">
            {counts.pending}
          </p>
        </div>
        <div className="bg-[#0c0f1a]/95 px-4 sm:px-5 py-4">
          <p className="text-xs text-[#8EA2BD]">En proceso</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#fcee0a]">
            {counts.active}
          </p>
        </div>
        <div className="bg-[#0c0f1a]/95 px-4 sm:px-5 py-4">
          <p className="text-xs text-[#8EA2BD]">Completados</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#00f0ff]">
            {counts.completed}
          </p>
        </div>
        <div className="bg-[#0c0f1a]/95 px-4 sm:px-5 py-4">
          <p className="text-xs text-[#8EA2BD]">Último escaneo</p>
          <p className="mt-1 font-mono text-base sm:text-lg font-medium tabular-nums text-[#C8D7EC] truncate">
            {lastScanFormatted}
          </p>
          {alreadyEditedCount > 0 && (
            <p className="mt-0.5 font-mono text-[11px] text-[#8EA2BD]">
              {alreadyEditedCount} omitidos
            </p>
          )}
        </div>
      </section>

      {/* Style Presets, TikTok Options, Quick Gemini Instruction & Quick Quality Toggle */}
      <EditStyleControls
        stylePreset={stylePreset}
        onChangeStylePreset={onChangeStylePreset}
        customInstruction={customInstruction}
        onChangeCustomInstruction={onChangeCustomInstruction}
        tiktokOptions={tiktokOptions}
        onChangeTikTokOptions={onChangeTikTokOptions}
        exportQuality={exportQuality}
        onChangeExportQuality={onChangeExportQuality}
        collapsible
        defaultExpanded
      />

      {/* Analytics Dashboard (Recharts daily videos, total saved footage, Gemini tags breakdown) */}
      <QueueAnalyticsPanel records={analyticsRecords} />

      {/* Remote Render Jobs Panel (Cloud GitHub Actions & PC Worker) */}
      <PcJobsPanel
        mode="queue"
        pcJobs={pcJobs}
        pcOutputs={pcOutputs}
        isDriveConnected={isDriveConnected}
        folderId={folderId}
        cloudRenderConfigured={cloudRenderConfigured}
        isSyncing={isSyncingPcJobs}
        lastSyncTime={lastPcSyncTime}
        downloadingOutputId={downloadingOutputId}
        previewUrls={pcOutputPreviewUrls}
        failedDispatchJobFileIds={failedDispatchJobFileIds}
        retryingDispatchJobFileId={retryingDispatchJobFileId}
        onSync={onSyncPcJobs}
        onDownloadOutput={onDownloadPcOutput}
        onRetryCloudDispatch={onRetryCloudDispatch}
        onGoToSettings={onGoToSettings}
      />

      {/* Discreet non-blocking > 200 MB RAM warning for mobile FFmpeg.wasm */}
      {showMobileRamNotice && (
        <div
          role="note"
          data-testid="queue-mobile-ram-notice"
          className="flex items-start justify-between gap-3 rounded-md border border-[#fcee0a]/45 bg-[#fcee0a]/[0.08] px-4 py-3 text-xs text-[#fcee0a]"
        >
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#fcee0a] mt-0.5" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[#FAF3B8] leading-relaxed">
                Los archivos seleccionados suman{' '}
                <strong className="font-mono tabular-nums text-[#fcee0a]">
                  {formatBytes(ramWarningBytes)}
                </strong>{' '}
                (más de 200 MB). En navegadores móviles FFmpeg.wasm puede consumir mucha RAM; te recomendamos usar el modo <strong className="font-mono text-[#00f0ff]">720p móvil</strong>.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {exportQuality !== 'mobile_fast' ? (
                  <button
                    type="button"
                    data-testid="queue-switch-mobile-720p-btn"
                    onClick={() => onChangeExportQuality('mobile_fast')}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/60 bg-[#00f0ff]/15 px-3 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/25 transition-colors"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    Cambiar a 720p móvil
                  </button>
                ) : (
                  <span
                    data-testid="queue-mobile-720p-active"
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-[#00f0ff]"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Modo 720p móvil activado
                  </span>
                )}
              </div>
            </div>
          </div>
          {recentUploadRamBytes > 0 && !exceedsMobileRamThreshold(selectedTotalBytes) && (
            <button
              type="button"
              onClick={() => setRecentUploadRamBytes(0)}
              aria-label="Ocultar aviso de memoria"
              className="rounded p-1 text-[#fcee0a] hover:bg-white/[0.08] shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Toolbar: Segmented Filter + Search + Local Gallery Multi-Video Upload + Pending Actions */}
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Filtrar cola por estado"
          className="grid grid-cols-2 sm:inline-flex items-center gap-1 rounded-md bg-[#0c0f1a]/90 p-1 border border-[#00f0ff]/25 w-full sm:w-auto shrink-0"
        >
          {(
            [
              { id: 'all', label: `Todos (${items.length})` },
              { id: 'pending', label: `Pendientes (${counts.pending})` },
              { id: 'active', label: `En proceso (${counts.active})` },
              { id: 'completed', label: `Completados (${counts.completed})` },
            ] as Array<{ id: StatusFilter; label: string }>
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setFilter(tab.id)}
                className={`min-h-[36px] rounded-sm px-2.5 py-1.5 font-mono text-xs font-medium text-center transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                  active
                    ? 'bg-[#00f0ff]/18 text-[#00f0ff]'
                    : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap xl:flex-nowrap items-center gap-2">
          <div className="relative flex-1 sm:flex-initial">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6A7E99]"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar vídeo..."
              aria-label="Buscar vídeo en la cola"
              className="h-10 sm:h-9 w-full sm:w-44 rounded-md border border-[#00f0ff]/25 bg-[#0c0f1a]/90 pl-8 pr-3 text-xs text-[#EEF5FF] placeholder:text-[#6A7E99] focus:border-[#00f0ff] focus:outline-none"
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            data-testid="mobile-gallery-file-input"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleLocalFilePick(e.target.files);
                e.target.value = '';
              }
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="hidden md:inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/30 bg-[#0c0f1a]/90 px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#00f0ff]/60 hover:bg-[#13192c] transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5 text-[#00f0ff]" />
            Subir vídeos
          </button>

          {counts.pending > 0 && (
            <>
              <button
                type="button"
                onClick={onClearPending}
                disabled={isProcessingAny}
                className="inline-flex h-10 sm:h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/20 bg-[#0c0f1a]/90 px-2.5 text-xs font-medium text-[#8EA2BD] hover:border-[#ff2a85]/50 hover:text-[#ff85b8] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Quitar pendientes
              </button>

              <button
                type="button"
                onClick={onProcessAllPending}
                disabled={isProcessingAny}
                className="cyber-btn-primary inline-flex h-10 sm:h-9 items-center gap-1.5 px-3.5 text-xs disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Procesar pendientes
              </button>
            </>
          )}
        </div>
      </div>

      {/* Queue List or Empty State */}
      {items.length === 0 ? (
        <div className="cyber-panel rounded-md px-6 py-12 sm:py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-[#00f0ff]/30 bg-[#05060a] text-[#00f0ff]">
            <FolderOpen className="h-5 w-5" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold text-[#EEF5FF]">
            Tu cola de edición está vacía
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-[#94A8C4] leading-relaxed">
            {isDriveConnected && folderId
              ? 'Pulsa "Escanear carpeta" para detectar archivos .mp4, .mov o .webm sin versión _EDITADO, o sube varios vídeos desde tu galería para combinarlos en Modo Multi-Clip.'
              : 'Conecta tu cuenta de Google Drive y configura el ID de carpeta en Ajustes, sube vídeos desde tu móvil o PC, o carga una sesión de ejemplo.'}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {isDriveConnected && folderId ? (
              <button
                type="button"
                onClick={onScanFolder}
                disabled={isScanning}
                className="cyber-btn-primary inline-flex h-11 items-center gap-2 px-5 text-sm disabled:opacity-50 whitespace-nowrap"
              >
                <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
                {isScanning ? 'Escaneando carpeta...' : 'Escanear carpeta ahora'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onGoToSettings}
                className="cyber-btn-primary inline-flex h-11 items-center gap-2 px-5 text-sm whitespace-nowrap"
              >
                Configurar carpeta de Drive
              </button>
            )}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-[#00f0ff]/30 bg-[#05060a]/90 px-4 text-sm font-medium text-[#EEF5FF] hover:border-[#00f0ff]/60 hover:bg-[#13192c] transition-colors whitespace-nowrap"
            >
              <Upload className="h-4 w-4 text-[#00f0ff]" />
              Subir vídeos locales
            </button>

            <button
              type="button"
              onClick={onLoadDemo}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-[#ff2a85]/40 bg-[#ff2a85]/10 px-4 text-sm font-medium text-[#EEF5FF] hover:bg-[#ff2a85]/20 transition-colors whitespace-nowrap"
            >
              <Sparkles className="h-4 w-4 text-[#ff2a85]" />
              Cargar sesión de ejemplo
            </button>
          </div>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="cyber-panel rounded-md px-6 py-10 text-center text-sm text-[#8EA2BD]">
          No hay vídeos que coincidan con el filtro actual.
        </div>
      ) : (
        <div className="cyber-panel overflow-hidden rounded-md divide-y divide-[#00f0ff]/15">
          {filteredItems.map((item) => {
            const stageIdx = STAGE_ORDER.indexOf(item.stage);
            const active = isActiveStage(item.stage);
            const isRemovable = item.stage === 'pending' || item.stage === 'error';
            const canSelectForCombine = !item.isMultiClip && !active;
            const isSelected = selectedSet.has(item.id);

            const sourceLabel = item.isMultiClip
              ? `Multi-Clip (${item.sourceClips?.length ?? 2} brutos)`
              : item.source === 'drive'
              ? 'Google Drive'
              : item.source === 'local'
              ? 'Galería / Local'
              : 'Ejemplo';

            return (
              <div
                key={item.id}
                className={`p-4 sm:p-5 transition-colors ${
                  isSelected ? 'bg-[#ff2a85]/[0.08]' : 'hover:bg-[#00f0ff]/[0.03]'
                }`}
                data-testid={`queue-item-${item.id}`}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  {/* Left: Multi-Clip Checkbox + Filename + unboxed metadata */}
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    {canSelectForCombine ? (
                      <label className="mt-0.5 flex h-6 w-6 items-center justify-center shrink-0">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleSelectItem(item.id)}
                          aria-label={`Seleccionar ${item.originalName} para combinar`}
                          className="h-4 w-4 rounded-sm border-[#00f0ff]/40 bg-[#05060a] accent-[#ff2a85]"
                        />
                      </label>
                    ) : (
                      <div className="mt-1 flex h-5 w-5 items-center justify-center shrink-0 text-[#ff2a85]">
                        {item.isMultiClip && <Layers className="h-4 w-4" aria-hidden="true" />}
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="truncate font-display text-[15px] font-semibold text-[#EEF5FF]">
                          {item.originalName}
                        </span>
                        {item.analysis?.etiqueta && (
                          <>
                            <span className="text-[#4F627D]" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-mono text-xs font-semibold text-[#fcee0a] shrink-0">
                              {item.analysis.etiqueta}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#8EA2BD]">
                        <span>{sourceLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-[#C8D7EC]">
                          {formatBytes(item.sizeBytes)}
                        </span>
                        {item.durationSec ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums text-[#C8D7EC]">
                              Bruto {formatSeconds(item.durationSec)}
                            </span>
                          </>
                        ) : null}
                      </div>

                      {item.analyzeJobStatus && item.analyzeJobStatus !== 'analyzed' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <p
                            data-testid={`queue-analyze-status-${item.id}`}
                            className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold ${
                              item.analyzeJobStatus === 'error'
                                ? 'border-[#ff2a85]/45 bg-[#ff2a85]/12 text-[#ff85b8]'
                                : 'border-[#fcee0a]/45 bg-[#fcee0a]/10 text-[#fcee0a]'
                            }`}
                          >
                            <Cloud className="h-3 w-3 shrink-0" />
                            {formatAnalyzeStageLabel(
                              item.analyzeJobStage,
                              item.analyzeJobStatus,
                              item.analyzeJobProgress
                            )}
                          </p>
                          {item.analyzeJobFileId &&
                            item.analyzeJobStatus === 'pending' &&
                            failedDispatchJobFileIds[item.analyzeJobFileId] && (
                              <button
                                type="button"
                                disabled={retryingDispatchJobFileId === item.analyzeJobFileId}
                                onClick={() => onRetryCloudDispatch(item.analyzeJobFileId!)}
                                className="inline-flex h-6 items-center gap-1 rounded-sm border border-[#ff2a85]/55 bg-[#ff2a85]/15 px-2 font-mono text-[10px] font-semibold text-[#ffd1e3] hover:bg-[#ff2a85]/25 disabled:opacity-45"
                              >
                                <RotateCw
                                  className={`h-3 w-3 ${
                                    retryingDispatchJobFileId === item.analyzeJobFileId
                                      ? 'animate-spin'
                                      : ''
                                  }`}
                                />
                                Reintentar envío
                              </button>
                            )}
                          {item.analyzeJobStatus === 'error' &&
                            isSafeHttpsUrl(item.cloudWorkflowRunUrl) && (
                              <a
                                href={item.cloudWorkflowRunUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid={`queue-view-run-${item.id}`}
                                className="inline-flex h-6 items-center gap-1 rounded-sm border border-[#00f0ff]/45 bg-[#00f0ff]/10 px-2 font-mono text-[10px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/20"
                              >
                                Ver ejecución
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            )}
                          {item.analyzeJobFileId && item.analyzeJobStatus === 'error' && (
                            <button
                              type="button"
                              data-testid={`queue-retry-cloud-${item.id}`}
                              disabled={retryingDispatchJobFileId === item.analyzeJobFileId}
                              onClick={() => onRetryCloudDispatch(item.analyzeJobFileId!)}
                              className="inline-flex h-6 items-center gap-1 rounded-sm border border-[#ff2a85]/55 bg-[#ff2a85]/15 px-2 font-mono text-[10px] font-semibold text-[#ffd1e3] hover:bg-[#ff2a85]/25 disabled:opacity-45"
                            >
                              <RotateCw
                                className={`h-3 w-3 ${
                                  retryingDispatchJobFileId === item.analyzeJobFileId
                                    ? 'animate-spin'
                                    : ''
                                }`}
                              />
                              Reintentar
                            </button>
                          )}
                        </div>
                      )}

                      {item.pcJobStatus && (
                        <div className="flex flex-wrap items-center gap-2">
                          <p
                            className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold ${
                              item.pcJobStatus === 'error'
                                ? 'border-[#ff2a85]/45 bg-[#ff2a85]/12 text-[#ff85b8]'
                                : 'border-[#00f0ff]/30 bg-[#00f0ff]/10 text-[#00f0ff]'
                            }`}
                          >
                            {item.pcJobTarget === 'cloud' ? 'Nube' : 'PC'}:{' '}
                            {formatPcJobStatusLabel(
                              item.pcJobStatus,
                              item.pcJobProgress,
                              item.pcJobTarget
                            )}
                          </p>
                          {item.pcJobStatus === 'error' &&
                            item.pcJobTarget === 'cloud' &&
                            isSafeHttpsUrl(item.cloudWorkflowRunUrl) && (
                              <a
                                href={item.cloudWorkflowRunUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid={`queue-render-view-run-${item.id}`}
                                className="inline-flex h-6 items-center gap-1 rounded-sm border border-[#00f0ff]/45 bg-[#00f0ff]/10 px-2 font-mono text-[10px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/20"
                              >
                                Ver ejecución
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            )}
                          {item.pcJobStatus === 'error' &&
                            item.pcJobTarget === 'cloud' &&
                            item.pcJobFileId && (
                              <button
                                type="button"
                                data-testid={`queue-render-retry-cloud-${item.id}`}
                                disabled={retryingDispatchJobFileId === item.pcJobFileId}
                                onClick={() => onRetryCloudDispatch(item.pcJobFileId!)}
                                className="inline-flex h-6 items-center gap-1 rounded-sm border border-[#ff2a85]/55 bg-[#ff2a85]/15 px-2 font-mono text-[10px] font-semibold text-[#ffd1e3] hover:bg-[#ff2a85]/25 disabled:opacity-45"
                              >
                                <RotateCw
                                  className={`h-3 w-3 ${
                                    retryingDispatchJobFileId === item.pcJobFileId
                                      ? 'animate-spin'
                                      : ''
                                  }`}
                                />
                                Reintentar
                              </button>
                            )}
                        </div>
                      )}

                      {item.outputFileName && (
                        <p className="font-mono text-xs text-[#00f0ff]/90 truncate">
                          Salida: {item.outputFileName}
                        </p>
                      )}

                      {item.analysis?.titulo_interno && (
                        <p className="text-xs text-[#B5C6DC]">{item.analysis.titulo_interno}</p>
                      )}
                    </div>
                  </div>

                  {/* Right: Monospace HUD Status + Primary Action + Remove Pending */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0 pl-8 lg:pl-0">
                    <div className="flex items-center gap-2 font-mono text-xs font-medium mr-1">
                      {item.stage === 'completed' ? (
                        <CheckCircle2 className="h-4 w-4 text-[#00f0ff]" />
                      ) : item.stage === 'error' ? (
                        <AlertCircle className="h-4 w-4 text-[#ff2a85]" />
                      ) : item.stage === 'review' ? (
                        <Sparkles className="h-4 w-4 text-[#fcee0a]" />
                      ) : active ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[#fcee0a]" />
                      ) : (
                        <Clock className="h-4 w-4 text-[#8EA2BD]" />
                      )}
                      <span
                        className={
                          item.stage === 'completed'
                            ? 'text-[#00f0ff]'
                            : item.stage === 'error'
                            ? 'text-[#ff5c9f]'
                            : active
                            ? 'text-[#fcee0a]'
                            : 'text-[#C8D7EC]'
                        }
                      >
                        {STAGE_LABELS[item.stage]}
                      </span>
                    </div>

                    {item.analysis && (
                      <button
                        type="button"
                        onClick={() => onOpenStudio(item.id)}
                        className={
                          item.stage === 'review'
                            ? 'cyber-btn-primary inline-flex h-10 sm:h-9 items-center gap-1.5 px-3.5 text-xs whitespace-nowrap'
                            : 'inline-flex h-10 sm:h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/35 bg-[#05060a]/90 px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#00f0ff]/70 hover:text-[#00f0ff] transition-colors whitespace-nowrap'
                        }
                      >
                        <Film
                          className={`h-3.5 w-3.5 ${
                            item.stage === 'review' ? '' : 'text-[#00f0ff]'
                          }`}
                        />
                        {item.stage === 'review' ? 'Revisar y renderizar' : 'Abrir estudio'}
                      </button>
                    )}

                    {isRemovable && (
                      <>
                        <button
                          type="button"
                          data-testid={`queue-cloud-analyze-${item.id}`}
                          onClick={() => onCloudAnalyzeItem(item.id)}
                          disabled={
                            !cloudRenderConfigured ||
                            !isDriveConnected ||
                            !folderId ||
                            isProcessingAny ||
                            Boolean(sendingAnalyzeId)
                          }
                          title={
                            !cloudRenderConfigured
                              ? 'Configura GitHub Actions y GEMINI_API_KEY (ver Ajustes)'
                              : !isDriveConnected || !folderId
                              ? 'Conecta Google Drive y configura tu carpeta en Ajustes'
                              : 'Transcripción real con Whisper + Gemini viendo vídeo y audio en GitHub Actions'
                          }
                          className="cyber-btn-primary inline-flex h-10 sm:h-9 items-center gap-1.5 px-3 text-xs disabled:opacity-45 whitespace-nowrap"
                        >
                          {sendingAnalyzeId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Cloud className="h-3.5 w-3.5" />
                          )}
                          Analizar en la nube (recomendado)
                        </button>

                        <button
                          type="button"
                          data-testid={`queue-fast-analyze-${item.id}`}
                          onClick={() => onProcessItem(item.id)}
                          disabled={isProcessingAny || Boolean(sendingAnalyzeId)}
                          title="Análisis local rápido por fotogramas sin transcripción de audio"
                          className="inline-flex h-10 sm:h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/30 bg-[#05060a]/90 px-3 text-xs font-medium text-[#C8D7EC] hover:border-[#00f0ff]/65 hover:text-[#00f0ff] disabled:opacity-45 transition-colors whitespace-nowrap"
                        >
                          <Zap className="h-3.5 w-3.5 text-[#fcee0a]" />
                          Análisis rápido (sin audio)
                        </button>

                        <button
                          type="button"
                          onClick={() => onRemoveItem(item.id)}
                          disabled={isProcessingAny || Boolean(sendingAnalyzeId)}
                          aria-label={`Quitar ${item.originalName} de la cola`}
                          title="Quitar de la cola"
                          className="inline-flex h-10 w-10 sm:h-9 sm:w-9 items-center justify-center rounded-md border border-[#00f0ff]/20 bg-[#05060a] text-[#8EA2BD] hover:border-[#ff2a85]/55 hover:bg-[#ff2a85]/15 hover:text-[#ff85b8] disabled:opacity-40 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}

                    {item.uploadedWebViewLink && (
                      <a
                        href={item.uploadedWebViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-10 sm:h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/25 px-3 text-xs font-medium text-[#C8D7EC] hover:border-[#00f0ff]/60 hover:text-[#00f0ff] transition-colors whitespace-nowrap"
                      >
                        Ver en Drive
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>

                {/* 7-Stage Energy Pipeline Bar + Real Progress */}
                <div className="mt-4 space-y-2 pl-8">
                  <div className="grid grid-cols-7 gap-1.5" aria-label="Etapas del flujo">
                    {STAGE_ORDER.map((step, idx) => {
                      const reached = item.stage !== 'error' && stageIdx >= idx;
                      const isCurrent = item.stage === step;
                      return (
                        <div key={step} className="space-y-1">
                          <div
                            className={`h-1.5 rounded-sm transition-colors ${
                              item.stage === 'error'
                                ? 'bg-[#ff2a85]/45'
                                : isCurrent && active
                                ? 'bg-[#fcee0a] shadow-[0_0_8px_rgba(252,238,10,0.55)]'
                                : reached
                                ? item.stage === 'completed'
                                  ? 'bg-[#00f0ff] shadow-[0_0_8px_rgba(0,240,255,0.4)]'
                                  : 'bg-[#ff2a85]'
                                : 'bg-white/[0.08]'
                            }`}
                          />
                          <span
                            className={`hidden sm:block truncate font-mono text-[10px] ${
                              isCurrent
                                ? 'font-semibold text-[#EEF5FF]'
                                : reached
                                ? 'text-[#8EA2BD]'
                                : 'text-[#52647D]'
                            }`}
                          >
                            {STAGE_LABELS[step]}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {active && item.stage !== 'review' && (
                    <>
                      <div className="flex items-center justify-between gap-3 pt-1">
                        <p className="text-xs text-[#C8D7EC] truncate">
                          {sendingAnalyzeId === item.id && cloudUploadProgress
                            ? cloudUploadProgress.message
                            : item.stageDetail || STAGE_LABELS[item.stage]}
                        </p>
                        <span className="font-mono text-xs font-semibold tabular-nums text-[#fcee0a] shrink-0">
                          {sendingAnalyzeId === item.id && cloudUploadProgress
                            ? cloudUploadProgress.percent
                            : item.progress}
                          %
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-sm border border-[#00f0ff]/25 bg-[#05060a]">
                        <div
                          className="h-full cyber-energy-bar transition-transform duration-150 origin-left"
                          style={{
                            transform: `scaleX(${Math.max(
                              0.03,
                              (sendingAnalyzeId === item.id && cloudUploadProgress
                                ? cloudUploadProgress.percent
                                : item.progress) / 100
                            )})`,
                          }}
                        />
                      </div>
                    </>
                  )}

                  {item.stage === 'review' && item.stageDetail && (
                    <p className="font-mono text-xs text-[#fcee0a] pt-1">{item.stageDetail}</p>
                  )}

                  {item.stage === 'error' && item.errorMessage && (
                    <p
                      data-testid="queue-item-error"
                      className="font-mono text-xs text-[#ff6ca9] pt-1 leading-relaxed break-words"
                    >
                      {(() => {
                        const match = item.errorMessage.match(
                          /^(\[(?:Drive|Extracción frames|Análisis IA|FFmpeg|GitHub)\])\s*(.*)$/i
                        );
                        if (!match) return item.errorMessage;
                        return (
                          <>
                            <span className="mr-1.5 inline-block rounded-sm border border-[#ff2a85]/55 bg-[#ff2a85]/18 px-1.5 py-0.5 text-[10px] font-semibold text-[#ffd4e5]">
                              {match[1]}
                            </span>
                            <span>{match[2]}</span>
                          </>
                        );
                      })()}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Floating Multi-Clip Action Bar when >= 2 clips are selected (thumb-zone above MobileBottomNav) */}
      {selectedIds.length >= 2 && (
        <div
          data-testid="multiclip-floating-bar"
          className="fixed bottom-[calc(4.9rem+env(safe-area-inset-bottom,0px))] md:bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-md border border-[#ff2a85]/55 bg-[#0c0f1a]/95 px-4 py-2.5 shadow-[0_0_24px_rgba(255,42,133,0.3)] backdrop-blur-xl max-w-[calc(100vw-2rem)]"
        >
          <span className="hidden sm:inline font-mono text-xs tabular-nums text-[#fcee0a] whitespace-nowrap">
            {formatBytes(selectedTotalBytes)}
          </span>
          <button
            type="button"
            onClick={onOpenMultiClipComposer}
            disabled={isProcessingAny}
            className="cyber-btn-magenta inline-flex h-10 sm:h-9 items-center gap-2 px-4 text-xs disabled:opacity-50 whitespace-nowrap"
          >
            <Layers className="h-3.5 w-3.5" />
            Combinar en 1 vídeo ({selectedIds.length} seleccionados)
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            aria-label="Limpiar selección Multi-Clip"
            className="flex h-9 w-9 items-center justify-center rounded-md text-[#8EA2BD] hover:bg-white/[0.08] hover:text-white transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

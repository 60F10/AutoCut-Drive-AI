import { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Film,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AnalyticsRecord, QueueItem, QueueStage } from '../types';
import {
  exceedsMobileRamThreshold,
  formatBytes,
  formatSeconds,
} from '../utils/videoPipeline';
import { QueueAnalyticsPanel } from './QueueAnalyticsPanel';

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
  alreadyEditedCount: number;
  lastScanTime: number | null;
  isScanning: boolean;
  isProcessingAny: boolean;
  isDriveConnected: boolean;
  folderId: string;
  onScanFolder: () => void;
  onProcessItem: (itemId: string) => void;
  onProcessAllPending: () => void;
  onOpenStudio: (itemId: string) => void;
  onAddLocalFiles: (files: FileList) => void;
  onLoadDemo: () => void;
  onGoToSettings: () => void;
}

const STAGE_ORDER: QueueStage[] = [
  'pending',
  'downloading',
  'analyzing',
  'rendering',
  'uploading',
  'completed',
];

const STAGE_LABELS: Record<QueueStage, string> = {
  pending: 'Pendiente',
  downloading: 'Descargando',
  analyzing: 'Analizando con Gemini',
  rendering: 'Renderizando cortes',
  uploading: 'Subiendo a Drive',
  completed: 'Completado',
  error: 'Error',
};

function isActiveStage(stage: QueueStage): boolean {
  return (
    stage === 'downloading' ||
    stage === 'analyzing' ||
    stage === 'rendering' ||
    stage === 'uploading'
  );
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
  alreadyEditedCount,
  lastScanTime,
  isScanning,
  isProcessingAny,
  isDriveConnected,
  folderId,
  onScanFolder,
  onProcessItem,
  onProcessAllPending,
  onOpenStudio,
  onAddLocalFiles,
  onLoadDemo,
  onGoToSettings,
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
    <div className={`space-y-6 ${selectedIds.length >= 2 ? 'pb-20' : ''}`}>
      {/* Unboxed summary metrics row with symmetrical hairlines across 2x2 mobile and 4-col desktop */}
      <section
        aria-label="Resumen de la cola"
        className="grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden border border-white/[0.08] rounded-xl bg-white/[0.08]"
      >
        <div className="bg-[#111419] px-5 py-4">
          <p className="text-xs text-[#8B96A8]">Pendientes</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#EDF1F7]">
            {counts.pending}
          </p>
        </div>
        <div className="bg-[#111419] px-5 py-4">
          <p className="text-xs text-[#8B96A8]">En proceso</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#F59E0B]">
            {counts.active}
          </p>
        </div>
        <div className="bg-[#111419] px-5 py-4">
          <p className="text-xs text-[#8B96A8]">Completados</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[#10B981]">
            {counts.completed}
          </p>
        </div>
        <div className="bg-[#111419] px-5 py-4">
          <p className="text-xs text-[#8B96A8]">Último escaneo</p>
          <p className="mt-1 font-mono text-base sm:text-lg font-medium tabular-nums text-[#C8D0DC] truncate">
            {lastScanFormatted}
          </p>
          {alreadyEditedCount > 0 && (
            <p className="mt-0.5 text-[11px] text-[#687487]">
              {alreadyEditedCount} omitidos (ya editados)
            </p>
          )}
        </div>
      </section>

      {/* Analytics Dashboard (Recharts daily videos, total saved footage, Gemini tags breakdown) */}
      <QueueAnalyticsPanel records={analyticsRecords} />

      {/* Discreet non-blocking > 200 MB RAM warning for mobile FFmpeg.wasm */}
      {showMobileRamNotice && (
        <div
          role="note"
          data-testid="queue-mobile-ram-notice"
          className="flex items-start justify-between gap-3 rounded-lg border border-[#F59E0B]/30 bg-[#F59E0B]/[0.07] px-4 py-3 text-xs text-[#FCD34D]"
        >
          <span className="flex items-start gap-2.5 leading-relaxed">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#F59E0B] mt-0.5" />
            <span>
              Los archivos seleccionados suman{' '}
              <strong className="font-mono tabular-nums">{formatBytes(ramWarningBytes)}</strong>{' '}
              (más de 200 MB). En navegadores móviles FFmpeg.wasm puede consumir mucha RAM; puedes continuar, pero en clips largos se recomienda grabar en 1080p.
            </span>
          </span>
          {recentUploadRamBytes > 0 && !exceedsMobileRamThreshold(selectedTotalBytes) && (
            <button
              type="button"
              onClick={() => setRecentUploadRamBytes(0)}
              aria-label="Ocultar aviso de memoria"
              className="rounded p-0.5 text-[#FCD34D] hover:bg-white/[0.08] shrink-0"
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
          className="grid grid-cols-2 sm:inline-flex items-center gap-1 rounded-lg bg-[#111419] p-1 border border-white/[0.08] w-full sm:w-auto shrink-0"
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
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium text-center transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                  active
                    ? 'bg-[#1D232E] text-white'
                    : 'text-[#8B96A8] hover:text-[#EDF1F7]'
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
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#687487]"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar vídeo..."
              aria-label="Buscar vídeo en la cola"
              className="h-9 w-full sm:w-44 rounded-lg border border-white/[0.09] bg-[#111419] pl-8 pr-3 text-xs text-[#EDF1F7] placeholder:text-[#687487] focus:border-[#E11D48] focus:outline-none"
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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#111419] px-3 text-xs font-medium text-[#EDF1F7] hover:bg-[#191E27] transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5 text-[#8B96A8]" />
            Subir vídeos
          </button>

          {counts.pending > 0 && (
            <>
              <button
                type="button"
                onClick={onClearPending}
                disabled={isProcessingAny}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.09] bg-[#111419] px-2.5 text-xs font-medium text-[#8B96A8] hover:bg-white/[0.04] hover:text-[#EDF1F7] disabled:opacity-45 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Quitar pendientes
              </button>

              <button
                type="button"
                onClick={onProcessAllPending}
                disabled={isProcessingAny}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E11D48] px-3 text-xs font-medium text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
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
        <div className="rounded-xl border border-white/[0.08] bg-[#111419] px-6 py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-[#171B22] text-[#8B96A8]">
            <FolderOpen className="h-5 w-5" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold text-[#EDF1F7]">
            Tu cola de edición está vacía
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-[#8B96A8] leading-relaxed">
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
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-sm font-medium text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
                {isScanning ? 'Escaneando carpeta...' : 'Escanear carpeta ahora'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onGoToSettings}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-sm font-medium text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap"
              >
                Configurar carpeta de Drive
              </button>
            )}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/[0.12] bg-[#171B22] px-4 text-sm font-medium text-[#EDF1F7] hover:bg-[#1F2530] transition-colors whitespace-nowrap"
            >
              <Upload className="h-4 w-4" />
              Subir vídeos locales
            </button>

            <button
              type="button"
              onClick={onLoadDemo}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/[0.08] px-4 text-sm font-medium text-[#B8C2D1] hover:bg-white/[0.05] hover:text-white transition-colors whitespace-nowrap"
            >
              <Sparkles className="h-4 w-4 text-[#F43F5E]" />
              Cargar sesión de ejemplo
            </button>
          </div>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-[#111419] px-6 py-10 text-center text-sm text-[#8B96A8]">
          No hay vídeos que coincidan con el filtro actual.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#111419] divide-y divide-white/[0.06]">
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
                className={`p-5 transition-colors ${
                  isSelected ? 'bg-[#E11D48]/[0.05]' : 'hover:bg-white/[0.02]'
                }`}
                data-testid={`queue-item-${item.id}`}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  {/* Left: Multi-Clip Checkbox + Filename + unboxed metadata */}
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    {canSelectForCombine ? (
                      <label className="mt-1 flex items-center shrink-0">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleSelectItem(item.id)}
                          aria-label={`Seleccionar ${item.originalName} para combinar`}
                          className="h-4 w-4 rounded border-white/25 bg-[#171B22] accent-[#E11D48]"
                        />
                      </label>
                    ) : (
                      <div className="mt-1 flex h-4 w-4 items-center justify-center shrink-0 text-[#F43F5E]">
                        {item.isMultiClip && <Layers className="h-3.5 w-3.5" aria-hidden="true" />}
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="truncate font-display text-[15px] font-semibold text-[#EDF1F7]">
                          {item.originalName}
                        </span>
                        {item.analysis?.etiqueta && (
                          <>
                            <span className="text-[#4B5565]" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-mono text-xs font-medium text-[#F43F5E] shrink-0">
                              {item.analysis.etiqueta}
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#8B96A8]">
                        <span>{sourceLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {formatBytes(item.sizeBytes)}
                        </span>
                        {item.durationSec ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              Bruto {formatSeconds(item.durationSec)}
                            </span>
                          </>
                        ) : null}
                      </div>

                      {item.outputFileName && (
                        <p className="font-mono text-xs text-[#C8D0DC] truncate">
                          Salida: {item.outputFileName}
                        </p>
                      )}

                      {item.analysis?.titulo_interno && (
                        <p className="text-xs text-[#A3AEBF]">{item.analysis.titulo_interno}</p>
                      )}
                    </div>
                  </div>

                  {/* Right: Status label + Primary Action + Remove Pending */}
                  <div className="flex flex-wrap items-center gap-2.5 shrink-0 pl-7 lg:pl-0">
                    <div className="flex items-center gap-2 text-xs font-medium mr-1">
                      {item.stage === 'completed' ? (
                        <CheckCircle2 className="h-4 w-4 text-[#10B981]" />
                      ) : item.stage === 'error' ? (
                        <AlertCircle className="h-4 w-4 text-[#EF4444]" />
                      ) : active ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[#F59E0B]" />
                      ) : (
                        <Clock className="h-4 w-4 text-[#8B96A8]" />
                      )}
                      <span
                        className={
                          item.stage === 'completed'
                            ? 'text-[#10B981]'
                            : item.stage === 'error'
                            ? 'text-[#EF4444]'
                            : active
                            ? 'text-[#F59E0B]'
                            : 'text-[#C8D0DC]'
                        }
                      >
                        {STAGE_LABELS[item.stage]}
                      </span>
                    </div>

                    {item.analysis && (
                      <button
                        type="button"
                        onClick={() => onOpenStudio(item.id)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#171B22] px-3 text-xs font-medium text-[#EDF1F7] hover:bg-[#1F2530] transition-colors whitespace-nowrap"
                      >
                        <Film className="h-3.5 w-3.5 text-[#F43F5E]" />
                        Abrir estudio
                      </button>
                    )}

                    {isRemovable && (
                      <>
                        <button
                          type="button"
                          onClick={() => onProcessItem(item.id)}
                          disabled={isProcessingAny}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#E11D48] px-3.5 text-xs font-medium text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                          {item.stage === 'error' ? 'Reintentar' : 'Procesar'}
                        </button>

                        <button
                          type="button"
                          onClick={() => onRemoveItem(item.id)}
                          disabled={isProcessingAny}
                          aria-label={`Quitar ${item.originalName} de la cola`}
                          title="Quitar de la cola"
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.09] bg-[#151921] text-[#8B96A8] hover:border-[#EF4444]/40 hover:bg-[#EF4444]/10 hover:text-[#FCA5A5] disabled:opacity-40 transition-colors"
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
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 text-xs font-medium text-[#B8C2D1] hover:bg-white/[0.05] hover:text-white transition-colors whitespace-nowrap"
                      >
                        Ver en Drive
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>

                {/* 6-Stage Pipeline Bar + Real Progress */}
                <div className="mt-4 space-y-2 pl-7">
                  <div className="grid grid-cols-6 gap-1.5" aria-label="Etapas del flujo">
                    {STAGE_ORDER.map((step, idx) => {
                      const reached = item.stage !== 'error' && stageIdx >= idx;
                      const isCurrent = item.stage === step;
                      return (
                        <div key={step} className="space-y-1">
                          <div
                            className={`h-1 rounded-full transition-colors ${
                              item.stage === 'error'
                                ? 'bg-[#EF4444]/40'
                                : isCurrent && active
                                ? 'bg-[#F59E0B]'
                                : reached
                                ? item.stage === 'completed'
                                  ? 'bg-[#10B981]'
                                  : 'bg-[#E11D48]'
                                : 'bg-white/[0.08]'
                            }`}
                          />
                          <span
                            className={`hidden sm:block truncate text-[11px] ${
                              isCurrent
                                ? 'font-medium text-[#EDF1F7]'
                                : reached
                                ? 'text-[#8B96A8]'
                                : 'text-[#525D6E]'
                            }`}
                          >
                            {STAGE_LABELS[step]}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {active && (
                    <>
                      <div className="flex items-center justify-between gap-3 pt-1">
                        <p className="text-xs text-[#C8D0DC] truncate">
                          {item.stageDetail || STAGE_LABELS[item.stage]}
                        </p>
                        <span className="font-mono text-xs tabular-nums text-[#F59E0B] shrink-0">
                          {item.progress}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
                        <div
                          className="h-full rounded-full bg-[#F59E0B] transition-transform duration-150 origin-left"
                          style={{ transform: `scaleX(${Math.max(0.03, item.progress / 100)})` }}
                        />
                      </div>
                    </>
                  )}

                  {item.stage === 'error' && item.errorMessage && (
                    <p className="text-xs text-[#F87171] pt-1">{item.errorMessage}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Floating Multi-Clip Action Bar when >= 2 clips are selected */}
      {selectedIds.length >= 2 && (
        <div
          data-testid="multiclip-floating-bar"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-xl border border-white/[0.14] bg-[#151921]/95 px-4 py-2.5 shadow-2xl backdrop-blur-md max-w-[calc(100vw-2rem)]"
        >
          <span className="hidden sm:inline font-mono text-xs tabular-nums text-[#8B96A8] whitespace-nowrap">
            {formatBytes(selectedTotalBytes)}
          </span>
          <button
            type="button"
            onClick={onOpenMultiClipComposer}
            disabled={isProcessingAny}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-xs font-medium text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <Layers className="h-3.5 w-3.5" />
            Combinar en 1 vídeo ({selectedIds.length} seleccionados)
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            aria-label="Limpiar selección Multi-Clip"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#8B96A8] hover:bg-white/[0.08] hover:text-white transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import {
  Cloud,
  CloudDownload,
  CloudUpload,
  Download,
  ExternalLink,
  Film,
  HardDrive,
  Layers,
  Loader2,
  Scissors,
  Search,
  Sparkles,
} from 'lucide-react';
import type { DriveFileMeta, PcJobSyncEntry, QueueItem } from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  calculateSelectedDuration,
  formatBytes,
  formatDurationHuman,
  formatSeconds,
} from '../utils/videoPipeline';
import { PcJobsPanel } from './PcJobsPanel';

interface GalleryViewProps {
  items: QueueItem[];
  isDriveConnected: boolean;
  folderId: string;
  restoringDriveId: string | null;
  onOpenStudio: (itemId: string) => void;
  onRequestDriveUpload: (itemId: string) => void;
  onDownloadFromDrive: (itemId: string) => void;
  onLoadDemo: () => void;
  onGoToQueue: () => void;
  onGoToSettings: () => void;
  pcJobs: PcJobSyncEntry[];
  pcOutputs: DriveFileMeta[];
  cloudRenderConfigured: boolean;
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

export function GalleryView({
  items,
  isDriveConnected,
  folderId,
  restoringDriveId,
  onOpenStudio,
  onRequestDriveUpload,
  onDownloadFromDrive,
  onLoadDemo,
  onGoToQueue,
  onGoToSettings,
  pcJobs,
  pcOutputs,
  cloudRenderConfigured,
  isSyncingPcJobs,
  lastPcSyncTime,
  downloadingOutputId,
  pcOutputPreviewUrls,
  failedDispatchJobFileIds,
  retryingDispatchJobFileId,
  onSyncPcJobs,
  onDownloadPcOutput,
  onRetryCloudDispatch,
}: GalleryViewProps) {
  const [selectedTag, setSelectedTag] = useState<string>('ALL');
  const [query, setQuery] = useState('');

  const completedItems = useMemo(
    () => items.filter((item) => item.stage === 'completed' && Boolean(item.analysis)),
    [items]
  );

  const availableTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of completedItems) {
      const tag = item.analysis?.etiqueta || 'VIDEO';
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [completedItems]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return completedItems.filter((item) => {
      const tag = item.analysis?.etiqueta || 'VIDEO';
      if (selectedTag !== 'ALL' && tag !== selectedTag) return false;
      if (q) {
        const hay = `${item.originalName} ${item.outputFileName ?? ''} ${item.analysis?.titulo_interno ?? ''} ${tag}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [completedItems, selectedTag, query]);

  const handleDownload = (item: QueueItem) => {
    if (!item.editedUrl || !item.analysis) return;
    const outputName =
      item.outputFileName ||
      (item.isMultiClip
        ? buildCombinedEditedFilename(item.projectName || item.originalName, item.analysis.etiqueta)
        : buildEditedFilename(item.originalName, item.analysis.etiqueta));
    const anchor = document.createElement('a');
    anchor.href = item.editedUrl;
    anchor.download = outputName;
    anchor.click();
  };

  if (completedItems.length === 0) {
    return (
      <div className="space-y-6">
        <PcJobsPanel
          mode="gallery"
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

        <div className="cyber-panel rounded-md px-6 py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-[#00f0ff]/30 bg-[#05060a] text-[#00f0ff]">
            <Film className="h-5 w-5" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold text-[#EEF5FF]">
            Aún no tienes resultados locales en la galería
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[#94A8C4] leading-relaxed">
            Cuando Gemini y FFmpeg.wasm terminen de editar tus clips individuales o combinados, se guardarán en la caché local (IndexedDB) y aparecerán aquí listos para reproducir, descargar o subir a Drive.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onGoToQueue}
              className="cyber-btn-primary inline-flex h-11 items-center gap-2 px-5 text-sm whitespace-nowrap"
            >
              Ir a la cola de vídeos
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
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PcJobsPanel
        mode="gallery"
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
      {/* Toolbar: Tag Filters + Search */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div
          role="tablist"
          aria-label="Filtrar galería por etiqueta"
          className="flex flex-wrap items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#0c0f1a]/90 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={selectedTag === 'ALL'}
            onClick={() => setSelectedTag('ALL')}
            className={`min-h-[34px] rounded-sm px-3 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
              selectedTag === 'ALL'
                ? 'bg-[#00f0ff]/18 text-[#00f0ff]'
                : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
            }`}
          >
            Todos ({completedItems.length})
          </button>
          {availableTags.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              role="tab"
              aria-selected={selectedTag === tag}
              onClick={() => setSelectedTag(tag)}
              className={`min-h-[34px] rounded-sm px-3 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
                selectedTag === tag
                  ? 'bg-[#fcee0a]/15 text-[#fcee0a]'
                  : 'text-[#8EA2BD] hover:text-[#EEF5FF]'
              }`}
            >
              {tag} ({count})
            </button>
          ))}
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6A7E99]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar resultado..."
            aria-label="Buscar vídeo en la galería"
            className="h-10 sm:h-9 w-full sm:w-60 rounded-md border border-[#00f0ff]/25 bg-[#0c0f1a]/90 pl-8 pr-3 text-xs text-[#EEF5FF] placeholder:text-[#6A7E99] focus:border-[#00f0ff] focus:outline-none"
          />
        </div>
      </div>

      {/* Results Grid */}
      {filteredItems.length === 0 ? (
        <div className="cyber-panel rounded-md px-6 py-10 text-center text-sm text-[#8EA2BD]">
          No hay resultados que coincidan con tu búsqueda.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredItems.map((item) => {
            const plan = item.analysis!;
            const finalSec = calculateSelectedDuration(plan.cortes);
            const rawSec = item.durationSec || finalSec;
            const savedSec = Math.max(0, rawSec - finalSec);
            const outputName =
              item.outputFileName ||
              (item.isMultiClip
                ? buildCombinedEditedFilename(item.projectName || item.originalName, plan.etiqueta)
                : buildEditedFilename(item.originalName, plan.etiqueta));
            const isDriveOnly =
              !item.editedUrl && Boolean(item.uploadedDriveId || item.uploadedWebViewLink);
            const isRestoring = restoringDriveId === item.id;
            const displaySize = item.editedBlob?.size || item.editedSizeBytes || item.sizeBytes;
            const qualityLabel =
              item.exportQuality === 'mobile_fast'
                ? '720×1280 · 30fps'
                : item.isMultiClip
                ? '1080×1920 · 30fps'
                : '9:16 MP4 · H.264';

            return (
              <article
                key={item.id}
                data-testid={`gallery-card-${item.id}`}
                className="cyber-panel flex flex-col overflow-hidden rounded-md"
              >
                {/* 9:16 Preview Area */}
                <div className="relative aspect-[9/11] w-full bg-[#05060a] border-b border-[#00f0ff]/20 overflow-hidden">
                  {item.editedUrl ? (
                    <video
                      src={item.editedUrl}
                      controls
                      playsInline
                      className="h-full w-full object-contain bg-black"
                    />
                  ) : isDriveOnly ? (
                    <div className="flex h-full w-full flex-col justify-between bg-gradient-to-b from-[#0d1322] via-[#080b14] to-[#05060a] p-5">
                      <div className="flex items-center justify-between text-[11px] font-mono text-[#8EA2BD]">
                        <span className="inline-flex items-center gap-1.5 text-[#00f0ff]">
                          <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                          Solo en Google Drive
                        </span>
                        <span className="tabular-nums text-[#fcee0a]">
                          {formatSeconds(finalSec)}
                        </span>
                      </div>

                      <div className="my-auto space-y-3 text-center px-2">
                        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md border border-[#00f0ff]/40 bg-[#00f0ff]/10 text-[#00f0ff]">
                          <CloudDownload className="h-5 w-5" />
                        </div>
                        <p className="font-display text-sm font-semibold text-white leading-snug">
                          {plan.titulo_interno}
                        </p>
                        <p className="text-xs text-[#94A8C4] leading-relaxed">
                          El MP4 se liberó de la caché local del navegador pero sigue disponible en Google Drive.
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                          {item.uploadedDriveId && (
                            <button
                              type="button"
                              onClick={() => onDownloadFromDrive(item.id)}
                              disabled={isRestoring || !isDriveConnected}
                              title={
                                !isDriveConnected
                                  ? 'Inicia sesión con Google Drive para descargar de nuevo el vídeo'
                                  : undefined
                              }
                              className="cyber-btn-primary inline-flex h-9 items-center gap-1.5 px-3 text-xs disabled:opacity-45 whitespace-nowrap"
                            >
                              {isRestoring ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CloudDownload className="h-3.5 w-3.5" />
                              )}
                              {isRestoring ? 'Descargando...' : 'Descargar desde Drive'}
                            </button>
                          )}
                          {item.uploadedWebViewLink && (
                            <a
                              href={item.uploadedWebViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/30 bg-[#0c0f1a] px-3 text-xs font-medium text-[#EEF5FF] hover:border-[#00f0ff]/65 hover:text-[#00f0ff] transition-colors whitespace-nowrap"
                            >
                              <ExternalLink className="h-3.5 w-3.5 text-[#00f0ff]" />
                              Abrir en Drive
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-[#8EA2BD] pt-3 border-t border-[#00f0ff]/15">
                        <span>{plan.cortes.filter((c) => c.enabled).length} cortes activos</span>
                        <span className="text-[#00f0ff] tabular-nums">
                          -{formatDurationHuman(savedSec)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full w-full flex-col justify-between bg-gradient-to-b from-[#0e1424] via-[#080a12] to-[#05060a] p-5">
                      <div className="flex items-center justify-between text-[11px] font-mono text-[#8EA2BD]">
                        <span>{qualityLabel}</span>
                        <span className="tabular-nums text-[#00f0ff]">
                          {formatSeconds(finalSec)}
                        </span>
                      </div>

                      <div className="my-auto space-y-3 text-center px-2">
                        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md border border-[#ff2a85]/40 bg-[#ff2a85]/10">
                          {item.isMultiClip ? (
                            <Layers className="h-5 w-5 text-[#ff2a85]" />
                          ) : (
                            <Scissors className="h-5 w-5 text-[#ff2a85]" />
                          )}
                        </div>
                        <p className="font-display text-sm font-semibold text-white leading-snug">
                          {plan.titulo_interno}
                        </p>
                        <p className="text-xs text-[#94A8C4] line-clamp-2">
                          {plan.cortes[0]?.motivo}
                        </p>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-[#8EA2BD] pt-3 border-t border-[#00f0ff]/15">
                        <span>{plan.cortes.filter((c) => c.enabled).length} cortes activos</span>
                        <span className="text-[#00f0ff] tabular-nums">
                          -{formatDurationHuman(savedSec)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Metadata & Actions */}
                <div className="flex flex-1 flex-col p-5 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#8EA2BD]">
                    <span className="font-mono font-semibold text-[#fcee0a]">
                      {plan.etiqueta}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-[#C8D7EC]">
                      {formatSeconds(rawSec)} → {formatSeconds(finalSec)}
                    </span>
                    {item.isMultiClip && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-[#ff5c9f]">
                          Multi-Clip ({item.sourceClips?.length ?? 2})
                        </span>
                      </>
                    )}
                  </div>

                  <h3 className="font-display text-[15px] font-semibold text-[#EEF5FF] leading-snug">
                    {plan.titulo_interno}
                  </h3>

                  <p className="font-mono text-[11px] text-[#8EA2BD] truncate" title={outputName}>
                    {outputName}
                  </p>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#8EA2BD] font-mono tabular-nums">
                    <span>
                      Ahorro: {formatDurationHuman(savedSec)} · {formatBytes(displaySize)}
                    </span>
                    {item.cachedInIndexedDb && (
                      <span className="inline-flex items-center gap-1 text-[#00f0ff]">
                        <HardDrive className="h-3 w-3" aria-hidden="true" />
                        Caché local
                      </span>
                    )}
                  </div>

                  <div className="mt-auto pt-3 border-t border-[#00f0ff]/20 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenStudio(item.id)}
                      className="cyber-btn-primary flex-1 inline-flex h-10 items-center justify-center gap-1.5 px-3 text-xs whitespace-nowrap"
                    >
                      <Film className="h-3.5 w-3.5" />
                      Abrir estudio
                    </button>

                    {item.editedUrl ? (
                      <button
                        type="button"
                        onClick={() => handleDownload(item)}
                        aria-label={`Descargar ${outputName}`}
                        title="Descargar MP4"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/30 bg-[#05060a] text-xs font-medium text-[#00f0ff] hover:border-[#00f0ff]/70 transition-colors"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    ) : item.uploadedDriveId ? (
                      <button
                        type="button"
                        onClick={() => onDownloadFromDrive(item.id)}
                        disabled={isRestoring || !isDriveConnected}
                        aria-label={`Recuperar ${outputName} desde Google Drive`}
                        title={
                          isDriveConnected
                            ? 'Descargar desde Google Drive a caché local'
                            : 'Conecta Google Drive para recuperar este vídeo'
                        }
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/30 bg-[#05060a] text-xs font-medium text-[#00f0ff] hover:border-[#00f0ff]/70 disabled:opacity-40 transition-colors"
                      >
                        {isRestoring ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CloudDownload className="h-4 w-4" />
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled
                        aria-label={`Descargar ${outputName}`}
                        title="Solo disponible para vídeos renderizados"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/20 bg-[#05060a] text-xs font-medium text-[#8EA2BD] opacity-40"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    )}

                    {item.uploadedWebViewLink ? (
                      <a
                        href={item.uploadedWebViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Ver ${outputName} en Google Drive`}
                        title="Abrir en Google Drive"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#00f0ff]/30 bg-[#05060a] text-xs font-medium text-[#00f0ff] hover:border-[#00f0ff]/70 transition-colors"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onRequestDriveUpload(item.id)}
                        aria-label={`Subir ${outputName} a Google Drive`}
                        title="Subir a Google Drive"
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#ff2a85]/35 bg-[#05060a] text-xs font-medium text-[#ff2a85] hover:border-[#ff2a85]/70 transition-colors"
                      >
                        <CloudUpload className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

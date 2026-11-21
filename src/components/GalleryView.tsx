import { useMemo, useState } from 'react';
import {
  CloudUpload,
  Download,
  ExternalLink,
  Film,
  Layers,
  Scissors,
  Search,
  Sparkles,
} from 'lucide-react';
import type { QueueItem } from '../types';
import {
  buildCombinedEditedFilename,
  buildEditedFilename,
  calculateSelectedDuration,
  formatBytes,
  formatDurationHuman,
  formatSeconds,
} from '../utils/videoPipeline';

interface GalleryViewProps {
  items: QueueItem[];
  onOpenStudio: (itemId: string) => void;
  onRequestDriveUpload: (itemId: string) => void;
  onLoadDemo: () => void;
  onGoToQueue: () => void;
}

export function GalleryView({
  items,
  onOpenStudio,
  onRequestDriveUpload,
  onLoadDemo,
  onGoToQueue,
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
      <div className="rounded-xl border border-white/[0.08] bg-[#111419] px-6 py-16 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-[#171B22] text-[#8B96A8]">
          <Film className="h-5 w-5" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold text-[#EDF1F7]">
          Aún no tienes resultados en la galería
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[#8B96A8] leading-relaxed">
          Cuando Gemini y FFmpeg.wasm terminen de editar tus clips individuales o combinados, aparecerán aquí listos para reproducir, descargar o subir a Drive.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onGoToQueue}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#E11D48] px-4 text-sm font-medium text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap"
          >
            Ir a la cola de vídeos
          </button>
          <button
            type="button"
            onClick={onLoadDemo}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/[0.1] bg-[#171B22] px-4 text-sm font-medium text-[#EDF1F7] hover:bg-[#1F2530] transition-colors whitespace-nowrap"
          >
            <Sparkles className="h-4 w-4 text-[#F43F5E]" />
            Cargar sesión de ejemplo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toolbar: Tag Filters + Search */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div
          role="tablist"
          aria-label="Filtrar galería por etiqueta"
          className="flex flex-wrap items-center gap-1 rounded-lg border border-white/[0.08] bg-[#111419] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={selectedTag === 'ALL'}
            onClick={() => setSelectedTag('ALL')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
              selectedTag === 'ALL'
                ? 'bg-[#1D232E] text-white'
                : 'text-[#8B96A8] hover:text-[#EDF1F7]'
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
              className={`rounded-md px-3 py-1.5 font-mono text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
                selectedTag === tag
                  ? 'bg-[#1D232E] text-white'
                  : 'text-[#8B96A8] hover:text-[#EDF1F7]'
              }`}
            >
              {tag} ({count})
            </button>
          ))}
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#687487]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar resultado..."
            aria-label="Buscar vídeo en la galería"
            className="h-9 w-full sm:w-60 rounded-lg border border-white/[0.09] bg-[#111419] pl-8 pr-3 text-xs text-[#EDF1F7] placeholder:text-[#687487] focus:border-[#E11D48] focus:outline-none"
          />
        </div>
      </div>

      {/* Results Grid */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-[#111419] px-6 py-10 text-center text-sm text-[#8B96A8]">
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

            return (
              <article
                key={item.id}
                data-testid={`gallery-card-${item.id}`}
                className="flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#111419]"
              >
                {/* 9:16 Preview Area (Compact vertical showcase) */}
                <div className="relative aspect-[9/11] w-full bg-[#07090C] border-b border-white/[0.08] overflow-hidden">
                  {item.editedUrl ? (
                    <video
                      src={item.editedUrl}
                      controls
                      playsInline
                      className="h-full w-full object-contain bg-black"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col justify-between bg-gradient-to-b from-[#171C26] via-[#0E1117] to-[#080A0E] p-5">
                      <div className="flex items-center justify-between text-[11px] font-mono text-[#8B96A8]">
                        <span>{item.isMultiClip ? '1080×1920 · 30fps' : '9:16 MP4 · H.264'}</span>
                        <span className="tabular-nums text-[#F43F5E]">
                          {formatSeconds(finalSec)}
                        </span>
                      </div>

                      <div className="my-auto space-y-3 text-center px-2">
                        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04]">
                          {item.isMultiClip ? (
                            <Layers className="h-5 w-5 text-[#F43F5E]" />
                          ) : (
                            <Scissors className="h-5 w-5 text-[#F43F5E]" />
                          )}
                        </div>
                        <p className="font-display text-sm font-semibold text-white leading-snug">
                          {plan.titulo_interno}
                        </p>
                        <p className="text-xs text-[#8B96A8] line-clamp-2">
                          {plan.cortes[0]?.motivo}
                        </p>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-[#8B96A8] pt-3 border-t border-white/[0.06]">
                        <span>{plan.cortes.filter((c) => c.enabled).length} cortes activos</span>
                        <span className="text-[#10B981] tabular-nums">
                          -{formatDurationHuman(savedSec)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Metadata & Actions */}
                <div className="flex flex-1 flex-col p-5 space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B96A8]">
                    <span className="font-mono font-semibold text-[#F43F5E]">
                      {plan.etiqueta}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {formatSeconds(rawSec)} → {formatSeconds(finalSec)}
                    </span>
                    {item.isMultiClip && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#C8D0DC]">
                          Multi-Clip ({item.sourceClips?.length ?? 2})
                        </span>
                      </>
                    )}
                  </div>

                  <h3 className="font-display text-[15px] font-semibold text-[#EDF1F7] leading-snug">
                    {plan.titulo_interno}
                  </h3>

                  <p className="font-mono text-[11px] text-[#8B96A8] truncate" title={outputName}>
                    {outputName}
                  </p>

                  <div className="text-[11px] text-[#687487] font-mono tabular-nums">
                    Ahorro: {formatDurationHuman(savedSec)} · {formatBytes(item.editedBlob?.size || item.sizeBytes)}
                  </div>

                  <div className="mt-auto pt-3 border-t border-white/[0.08] flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenStudio(item.id)}
                      className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[#E11D48] px-3 text-xs font-medium text-white hover:bg-[#BE123C] transition-colors whitespace-nowrap"
                    >
                      <Film className="h-3.5 w-3.5" />
                      Abrir estudio
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDownload(item)}
                      disabled={!item.editedUrl}
                      aria-label={`Descargar ${outputName}`}
                      title={item.editedUrl ? 'Descargar MP4' : 'Solo disponible para vídeos renderizados'}
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-white/[0.1] bg-[#171B22] px-2.5 text-xs font-medium text-[#EDF1F7] hover:bg-[#1F2530] disabled:opacity-40 transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>

                    {item.uploadedWebViewLink ? (
                      <a
                        href={item.uploadedWebViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Ver ${outputName} en Google Drive`}
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-white/[0.1] bg-[#171B22] px-2.5 text-xs font-medium text-[#10B981] hover:bg-[#1F2530] transition-colors"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onRequestDriveUpload(item.id)}
                        aria-label={`Subir ${outputName} a Google Drive`}
                        title="Subir a Google Drive"
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-white/[0.1] bg-[#171B22] px-2.5 text-xs font-medium text-[#38BDF8] hover:bg-[#1F2530] transition-colors"
                      >
                        <CloudUpload className="h-3.5 w-3.5" />
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

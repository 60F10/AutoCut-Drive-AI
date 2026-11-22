import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
} from 'lucide-react';
import type { DriveFileMeta, PcJobSyncEntry } from '../types';
import { formatBytes, formatPcJobStatusLabel } from '../utils/videoPipeline';

interface PcJobsPanelProps {
  mode?: 'queue' | 'gallery';
  pcJobs: PcJobSyncEntry[];
  pcOutputs: DriveFileMeta[];
  isDriveConnected: boolean;
  folderId: string;
  isSyncing: boolean;
  lastSyncTime: number | null;
  downloadingOutputId: string | null;
  previewUrls: Record<string, string>;
  onSync: () => void;
  onDownloadOutput: (outputFile: DriveFileMeta, triggerSave?: boolean) => void;
  onGoToSettings?: () => void;
}

export function PcJobsPanel({
  mode = 'queue',
  pcJobs,
  pcOutputs,
  isDriveConnected,
  folderId,
  isSyncing,
  lastSyncTime,
  downloadingOutputId,
  previewUrls,
  onSync,
  onDownloadOutput,
  onGoToSettings,
}: PcJobsPanelProps) {
  const canSync = Boolean(isDriveConnected && folderId.trim());

  // Identify standalone MP4s inside _AutoCut_Output that don't have a matching JSON job entry
  const matchedOutputIds = new Set(
    pcJobs.map((entry) => entry.outputFile?.id).filter((id): id is string => Boolean(id))
  );
  const unmatchedOutputs = pcOutputs.filter((file) => !matchedOutputIds.has(file.id));

  const visibleJobs =
    mode === 'gallery'
      ? [...pcJobs].sort((a, b) => {
          const rank = (status: string) =>
            status === 'completed' ? 0 : status === 'processing' ? 1 : status === 'pending' ? 2 : 3;
          return rank(a.manifest.status) - rank(b.manifest.status);
        })
      : pcJobs;

  const activeCount = pcJobs.filter(
    (j) => j.manifest.status === 'pending' || j.manifest.status === 'processing'
  ).length;
  const completedCount =
    pcJobs.filter((j) => j.manifest.status === 'completed').length + unmatchedOutputs.length;

  const lastSyncFormatted = lastSyncTime
    ? new Date(lastSyncTime).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null;

  return (
    <section
      aria-label="Trabajos de renderizado en PC"
      data-testid="pc-jobs-panel"
      className="cyber-panel rounded-md p-4 sm:p-5 space-y-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-md border border-[#00f0ff]/35 bg-[#05060a] text-[#00f0ff] shrink-0">
            <Monitor className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-sm sm:text-base font-semibold text-[#EEF5FF]">
                {mode === 'gallery'
                  ? 'Resultados renderizados en PC (_AutoCut_Output)'
                  : 'Cola de render híbrido en PC (Google Drive)'}
              </h2>
              {activeCount > 0 && (
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border border-[#fcee0a]/45 bg-[#fcee0a]/10 text-[#fcee0a]">
                  {activeCount} activo{activeCount > 1 ? 's' : ''}
                </span>
              )}
              {completedCount > 0 && (
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-sm border border-[#00f0ff]/40 bg-[#00f0ff]/10 text-[#00f0ff]">
                  {completedCount} MP4 listo{completedCount > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[#8EA2BD] leading-relaxed">
              Sincroniza <span className="font-mono text-[#C8D7EC]">_AutoCut_Jobs</span> y{' '}
              <span className="font-mono text-[#C8D7EC]">_AutoCut_Output</span> con tu worker FFmpeg de Windows (coste 0 €).
              {lastSyncFormatted && (
                <span className="ml-1.5 font-mono text-[11px] text-[#6A7E99]">
                  · Actualizado {lastSyncFormatted}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {canSync ? (
            <button
              type="button"
              data-testid="sync-pc-jobs-btn"
              onClick={onSync}
              disabled={isSyncing}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/45 bg-[#00f0ff]/12 px-3.5 font-mono text-xs font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/20 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              {isSyncing ? 'Sincronizando...' : 'Actualizar estado PC'}
            </button>
          ) : (
            onGoToSettings && (
              <button
                type="button"
                data-testid="sync-pc-jobs-btn"
                onClick={onGoToSettings}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#00f0ff]/30 bg-[#05060a] px-3 font-mono text-xs font-medium text-[#C8D7EC] hover:border-[#00f0ff]/65 hover:text-[#00f0ff] transition-colors whitespace-nowrap"
              >
                Conectar Drive en Ajustes
              </button>
            )
          )}
        </div>
      </div>

      {!canSync ? (
        <p className="rounded-sm border border-[#00f0ff]/15 bg-[#05060a]/80 px-3.5 py-2.5 text-xs text-[#8EA2BD]">
          Conecta tu cuenta de Google Drive y configura tu carpeta de trabajo para enviar renders pesados o Multi-Clip a tu PC y descargar el MP4 final aquí.
        </p>
      ) : visibleJobs.length === 0 && unmatchedOutputs.length === 0 ? (
        <p className="rounded-sm border border-[#00f0ff]/15 bg-[#05060a]/80 px-3.5 py-2.5 text-xs text-[#8EA2BD]">
          No hay trabajos en <span className="font-mono text-[#C8D7EC]">_AutoCut_Jobs</span> todavía. Abre cualquier vídeo analizado en{' '}
          <strong className="text-[#EEF5FF]">Estudio de cortes</strong> y pulsa{' '}
          <strong className="text-[#00f0ff]">Enviar render a PC</strong>.
        </p>
      ) : (
        <div className="space-y-3">
          {visibleJobs.map((entry) => {
            const { manifest, outputFile } = entry;
            const statusText = formatPcJobStatusLabel(manifest.status, manifest.progress);
            const previewUrl = outputFile ? previewUrls[outputFile.id] : undefined;
            const isDownloading = Boolean(outputFile && downloadingOutputId === outputFile.id);

            return (
              <div
                key={manifest.jobId}
                data-testid={`pc-job-card-${manifest.jobId}`}
                className="rounded-md border border-[#00f0ff]/22 bg-[#05060a]/90 p-3.5 space-y-3"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-sm font-semibold text-[#EEF5FF] truncate">
                        {manifest.title || manifest.outputFileName}
                      </span>
                      {manifest.etiqueta && (
                        <span className="font-mono text-[11px] font-semibold text-[#fcee0a]">
                          {manifest.etiqueta}
                        </span>
                      )}
                      {manifest.encoderUsed && (
                        <span className="inline-flex items-center gap-1 rounded-sm border border-[#00f0ff]/25 bg-[#00f0ff]/8 px-1.5 py-0.5 font-mono text-[10px] text-[#00f0ff]">
                          <Cpu className="h-2.5 w-2.5" />
                          {manifest.encoderUsed}
                        </span>
                      )}
                    </div>

                    <p className="font-mono text-[11px] text-[#8EA2BD] truncate">
                      {manifest.outputFileName}
                    </p>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-[#7A8EA8]">
                      <span>{manifest.options.quality}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {manifest.options.framing === 'blur_bg' ? 'Fondo blur' : 'Recorte 9:16'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {manifest.sourceFiles.length} clip{manifest.sourceFiles.length > 1 ? 's' : ''} ·{' '}
                        {manifest.cuts.length} cortes
                      </span>
                      {manifest.options.subtitlesEnabled && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#ff85b8]">Subtítulos</span>
                        </>
                      )}
                      {outputFile?.size && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#C8D7EC]">{formatBytes(outputFile.size)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Status + Actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 font-mono text-[11px] font-semibold ${
                        manifest.status === 'completed'
                          ? 'border-[#00f0ff]/45 bg-[#00f0ff]/12 text-[#00f0ff]'
                          : manifest.status === 'processing'
                          ? 'border-[#fcee0a]/50 bg-[#fcee0a]/12 text-[#fcee0a]'
                          : manifest.status === 'error'
                          ? 'border-[#ff2a85]/55 bg-[#ff2a85]/14 text-[#ff6ca9]'
                          : 'border-[#00f0ff]/25 bg-[#0c0f1a] text-[#C8D7EC]'
                      }`}
                    >
                      {manifest.status === 'completed' ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : manifest.status === 'processing' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : manifest.status === 'error' ? (
                        <AlertCircle className="h-3.5 w-3.5" />
                      ) : (
                        <Clock className="h-3.5 w-3.5" />
                      )}
                      {statusText}
                    </span>

                    {manifest.status === 'completed' && outputFile && (
                      <>
                        <button
                          type="button"
                          onClick={() => onDownloadOutput(outputFile, false)}
                          disabled={isDownloading}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/40 bg-[#00f0ff]/12 px-2.5 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/22 disabled:opacity-45 transition-colors whitespace-nowrap"
                        >
                          {isDownloading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                          {previewUrl ? 'Cargado' : 'Ver MP4'}
                        </button>

                        <button
                          type="button"
                          onClick={() => onDownloadOutput(outputFile, true)}
                          disabled={isDownloading}
                          className="cyber-btn-primary inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] disabled:opacity-45 whitespace-nowrap"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Descargar
                        </button>

                        {outputFile.webViewLink && (
                          <a
                            href={outputFile.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#0c0f1a] px-2.5 font-mono text-[11px] text-[#C8D7EC] hover:border-[#00f0ff]/60 hover:text-[#00f0ff] transition-colors whitespace-nowrap"
                          >
                            Drive
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {manifest.status === 'processing' && (
                  <div className="h-1.5 w-full overflow-hidden rounded-sm border border-[#fcee0a]/30 bg-[#0c0f1a]">
                    <div
                      className="h-full cyber-energy-bar transition-transform duration-200 origin-left"
                      style={{
                        transform: `scaleX(${Math.max(0.04, (manifest.progress || 5) / 100)})`,
                      }}
                    />
                  </div>
                )}

                {manifest.status === 'error' && manifest.errorMessage && (
                  <p className="rounded-sm border border-[#ff2a85]/35 bg-[#ff2a85]/10 px-3 py-2 font-mono text-[11px] text-[#ffb3d1] break-words">
                    {manifest.errorMessage}
                  </p>
                )}

                {previewUrl && (
                  <div className="pt-1 flex justify-center">
                    <div className="w-full max-w-[240px] aspect-[9/16] overflow-hidden rounded-md border border-[#00f0ff]/35 bg-black">
                      <video
                        src={previewUrl}
                        controls
                        playsInline
                        className="h-full w-full object-contain bg-black"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {unmatchedOutputs.map((file) => {
            const previewUrl = previewUrls[file.id];
            const isDownloading = downloadingOutputId === file.id;

            return (
              <div
                key={file.id}
                className="rounded-md border border-[#00f0ff]/22 bg-[#05060a]/90 p-3.5 space-y-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-semibold text-[#EEF5FF] truncate">
                      {file.name}
                    </p>
                    <p className="font-mono text-[11px] text-[#8EA2BD]">
                      _AutoCut_Output {file.size ? `· ${formatBytes(file.size)}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onDownloadOutput(file, false)}
                      disabled={isDownloading}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/40 bg-[#00f0ff]/12 px-2.5 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/22 disabled:opacity-45"
                    >
                      {isDownloading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      Ver MP4
                    </button>
                    <button
                      type="button"
                      onClick={() => onDownloadOutput(file, true)}
                      disabled={isDownloading}
                      className="cyber-btn-primary inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] disabled:opacity-45"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Descargar
                    </button>
                    {file.webViewLink && (
                      <a
                        href={file.webViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center gap-1 rounded-md border border-[#00f0ff]/25 bg-[#0c0f1a] px-2.5 font-mono text-[11px] text-[#C8D7EC] hover:border-[#00f0ff]/60 hover:text-[#00f0ff]"
                      >
                        Drive
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
                {previewUrl && (
                  <div className="pt-1 flex justify-center">
                    <div className="w-full max-w-[240px] aspect-[9/16] overflow-hidden rounded-md border border-[#00f0ff]/35 bg-black">
                      <video
                        src={previewUrl}
                        controls
                        playsInline
                        className="h-full w-full object-contain bg-black"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

import { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ClipboardCopy,
  RefreshCw,
  Settings,
  X,
  Zap,
} from 'lucide-react';
import type { ActiveView, AppErrorBanner } from './types';
import { parseHumanReadableApiError } from './utils/videoPipeline';
import {
  buildDiagnosticReport,
  copyTextWithFallback,
  logInfo,
  type DiagnosticContextSnapshot,
} from './services/debugLogger';
import { useAppSettings } from './hooks/useAppSettings';
import { useGoogleDriveAuth } from './hooks/useGoogleDriveAuth';
import { useVideoQueue } from './hooks/useVideoQueue';
import { useStudioEditor } from './hooks/useStudioEditor';
import { Sidebar } from './components/Sidebar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { QueueView } from './components/QueueView';
import { GalleryView } from './components/GalleryView';
import { StudioView } from './components/StudioView';
import { SettingsView } from './components/SettingsView';
import { DriveConfirmModal } from './components/DriveConfirmModal';
import { MultiClipComposerModal } from './components/MultiClipComposerModal';
import { DiagnosticCopyModal } from './components/DiagnosticCopyModal';
import { OfflineIndicator } from './components/PWAInstallButton';

const VIEW_TITLES: Record<ActiveView, string> = {
  queue: 'Cola de vídeos',
  gallery: 'Galería de resultados',
  studio: 'Estudio de cortes',
  settings: 'Ajustes',
};

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('queue');
  const [bannerError, setBannerError] = useState<AppErrorBanner | null>(null);
  const [bannerCopied, setBannerCopied] = useState(false);
  const [manualCopyReport, setManualCopyReport] = useState<string | null>(null);

  const reportError = useCallback((error: string | AppErrorBanner | null) => {
    if (!error) {
      setBannerError(null);
      return;
    }

    const extractPhasePrefix = (text: string): { prefix: string; body: string } => {
      const m = text.trim().match(/^(\[(?:Drive|Extracción frames|Análisis IA|FFmpeg)\])\s*(.*)$/i);
      return m ? { prefix: m[1], body: m[2] } : { prefix: '', body: text };
    };

    if (typeof error === 'string') {
      const { prefix, body } = extractPhasePrefix(error);
      const parsed = parseHumanReadableApiError(body);
      if (parsed.technicalDetail) {
        console.error('[AutoCut Drive AI] Error técnico:', parsed.technicalDetail);
      }
      setBannerError({
        message: prefix ? `${prefix} ${parsed.userMessage}` : parsed.userMessage,
        technicalDetail: parsed.technicalDetail,
        actionHint: parsed.actionHint,
      });
      return;
    }

    const { prefix, body } = extractPhasePrefix(error.message);
    const parsed = parseHumanReadableApiError(body);
    const technicalDetail = error.technicalDetail || parsed.technicalDetail;
    const actionHint = error.actionHint || parsed.actionHint;
    if (technicalDetail) {
      console.error('[AutoCut Drive AI] Error técnico:', technicalDetail);
    }
    setBannerError({
      message: prefix ? `${prefix} ${parsed.userMessage}` : parsed.userMessage,
      technicalDetail,
      actionHint,
    });
  }, []);

  // Ref bridge lets useVideoQueue focus a newly completed item in Studio without circular hook deps
  const selectStudioRef = useRef<(itemId: string) => void>(() => {});
  const handleSelectStudioFromQueue = useCallback((itemId: string) => {
    selectStudioRef.current(itemId);
  }, []);

  const {
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
  } = useAppSettings();

  const {
    user,
    accessToken,
    isLoggingIn,
    geminiConfigured,
    isDriveConnected,
    handleGoogleLogin,
    handleGoogleLogout,
    clearAuthSession,
  } = useGoogleDriveAuth({ onError: reportError });

  const queue = useVideoQueue({
    settings,
    persistSettings,
    stylePreset,
    customInstruction,
    tiktokOptions,
    accessToken,
    clearAuthSession,
    refreshCacheStats,
    onError: reportError,
    onNavigateView: setActiveView,
    onSelectStudioItem: handleSelectStudioFromQueue,
  });

  const studio = useStudioEditor({
    itemsRef: queue.itemsRef,
    setItems: queue.setItems,
    updateQueueItem: queue.updateQueueItem,
    exportQuality: settings.exportQuality,
    tiktokOptions,
    cacheEditedVideo: queue.cacheEditedVideo,
    appendAnalyticsRecord: queue.appendAnalyticsRecord,
    maybePromptDriveUpload: queue.maybePromptDriveUpload,
    onError: reportError,
  });

  selectStudioRef.current = studio.setSelectedStudioId;

  const openItemInStudio = useCallback(
    (itemId: string) => {
      studio.setSelectedStudioId(itemId);
      setActiveView('studio');
    },
    [studio]
  );

  const handleCopyDiagnosticReport = useCallback(async (): Promise<boolean> => {
    const items = queue.itemsRef.current;
    let pending = 0;
    let active = 0;
    let completed = 0;
    let error = 0;
    for (const item of items) {
      if (item.stage === 'pending') pending += 1;
      else if (item.stage === 'error') error += 1;
      else if (item.stage === 'completed') completed += 1;
      else active += 1;
    }

    const context: DiagnosticContextSnapshot = {
      settings: {
        model: settings.model,
        exportQuality: settings.exportQuality,
        autoWatchEnabled: settings.autoWatchEnabled,
        watchIntervalSec: settings.watchIntervalSec,
        autoUploadEnabled: settings.autoUploadEnabled,
        hasFolderId: Boolean(settings.folderId),
      },
      tiktokOptions,
      stylePreset,
      queueSummary: {
        total: items.length,
        pending,
        active,
        completed,
        error,
      },
      activeError: bannerError?.message ?? null,
    };

    const report = buildDiagnosticReport(context);
    const result = await copyTextWithFallback(report);
    logInfo('UI', 'Informe de diagnóstico generado', { metodo: result.method });

    if (result.ok) {
      return true;
    }

    setManualCopyReport(report);
    return false;
  }, [queue.itemsRef, settings, tiktokOptions, stylePreset, bannerError?.message]);

  const handleBannerCopyDiagnostic = useCallback(async () => {
    const ok = await handleCopyDiagnosticReport();
    if (ok) {
      setBannerCopied(true);
      window.setTimeout(() => setBannerCopied(false), 2000);
    }
  }, [handleCopyDiagnosticReport]);

  return (
    <div className="min-h-dvh-app cyber-canvas-bg text-[#EEF5FF] flex">
      <Sidebar
        activeView={activeView}
        onSelectView={setActiveView}
        settings={settings}
        onToggleAutoWatch={queue.handleToggleAutoWatch}
        nextScanCountdownSec={queue.nextScanCountdownSec}
        queueCounts={queue.queueCounts}
        user={user}
        isLoggingIn={isLoggingIn}
        onGoogleLogin={handleGoogleLogin}
        onGoogleLogout={handleGoogleLogout}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean non-interactive mobile header with generous iOS standalone safe-area clearance; desktop CTA stays right-aligned */}
        <header className="sticky top-0 z-30 border-b border-[#00f0ff]/25 bg-[#05060a]/92 backdrop-blur-xl pt-safe-header px-safe">
          <div className="flex min-h-[3.5rem] sm:min-h-[4rem] items-center justify-between gap-3 px-4 sm:px-8 py-2">
            <div className="flex items-center gap-2.5 text-sm min-w-0">
              <span className="font-mono text-[11px] font-semibold tracking-wider text-[#00f0ff] uppercase whitespace-nowrap">
                AutoCut AI
              </span>
              <span className="text-[#00f0ff]/40 font-mono" aria-hidden="true">
                /
              </span>
              <h1 className="font-display text-base font-semibold text-[#EEF5FF] truncate">
                {VIEW_TITLES[activeView]}
              </h1>
            </div>

            <div className="hidden md:flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={queue.handleScanFolder}
                disabled={queue.isScanning}
                className="inline-flex h-9 items-center gap-2 cyber-btn-primary px-4 text-xs disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${queue.isScanning ? 'animate-spin' : ''}`} />
                {queue.isScanning ? 'Escaneando...' : 'Escanear carpeta'}
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 px-4 py-5 sm:px-8 sm:py-7 pb-mobile-nav md:pb-8 max-w-[1280px] w-full mx-auto space-y-5">
          {bannerError && (
            <div
              role="alert"
              data-testid="app-error-banner"
              className="flex items-start justify-between gap-3 rounded-md border border-[#ff2a85]/50 bg-[#ff2a85]/12 px-4 py-3 text-xs text-[#ffb3d1] shadow-[0_0_20px_rgba(255,42,133,0.14)]"
            >
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <AlertCircle className="h-4 w-4 shrink-0 text-[#ff2a85] mt-0.5" />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="leading-relaxed font-medium text-[#ffd4e5]">
                    {bannerError.message}
                  </p>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      data-testid="banner-copy-diagnostic-btn"
                      onClick={handleBannerCopyDiagnostic}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/45 bg-[#05060a]/85 px-3 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/15 transition-colors"
                    >
                      {bannerCopied ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          ¡Copiado!
                        </>
                      ) : (
                        <>
                          <ClipboardCopy className="h-3.5 w-3.5" />
                          Copiar error / diagnóstico
                        </>
                      )}
                    </button>

                    {bannerError.actionHint === 'settings' && activeView !== 'settings' && (
                      <button
                        type="button"
                        data-testid="error-open-settings-btn"
                        onClick={() => setActiveView('settings')}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#ff2a85]/55 bg-[#ff2a85]/20 px-3 font-mono text-[11px] font-semibold text-white hover:bg-[#ff2a85]/30 transition-colors"
                      >
                        <Settings className="h-3.5 w-3.5" />
                        Abrir Ajustes
                      </button>
                    )}

                    {bannerError.technicalDetail && (
                      <details
                        data-testid="error-technical-details"
                        className="w-full text-[11px] text-[#ffb3d1]/85"
                      >
                        <summary className="cursor-pointer select-none font-mono text-[11px] text-[#ff85b8] hover:text-white">
                          Ver detalle técnico
                        </summary>
                        <pre className="mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-[#ff2a85]/30 bg-[#05060a]/90 p-2.5 font-mono text-[10px] text-[#e2b4c8]">
                          {bannerError.technicalDetail}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                aria-label="Cerrar aviso"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#ffb3d1] hover:bg-[#ff2a85]/20 hover:text-white shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {queue.heavyVideoWarning && (
            <div
              role="note"
              data-testid="heavy-video-warning-banner"
              className="flex items-start justify-between gap-3 rounded-md border border-[#fcee0a]/45 bg-[#fcee0a]/[0.08] px-4 py-3 text-xs text-[#fef08a]"
            >
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[#fcee0a] mt-0.5" />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="leading-relaxed">{queue.heavyVideoWarning}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {settings.exportQuality !== 'mobile_fast' ? (
                      <button
                        type="button"
                        data-testid="heavy-switch-mobile-720p-btn"
                        onClick={() => handleChangeExportQuality('mobile_fast')}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#00f0ff]/60 bg-[#00f0ff]/15 px-3 font-mono text-[11px] font-semibold text-[#00f0ff] hover:bg-[#00f0ff]/25 transition-colors"
                      >
                        <Zap className="h-3.5 w-3.5" />
                        Cambiar a 720p móvil
                      </button>
                    ) : (
                      <span
                        data-testid="heavy-mobile-720p-active"
                        className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-[#00f0ff]"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Modo 720p móvil activado
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => queue.setHeavyVideoWarning(null)}
                aria-label="Cerrar advertencia de memoria"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#fef08a] hover:bg-[#fcee0a]/20 hover:text-white shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {activeView === 'queue' && (
            <QueueView
              items={queue.items}
              analyticsRecords={queue.analyticsRecords}
              selectedIds={queue.selectedForCombine}
              onToggleSelectItem={queue.handleToggleSelectForCombine}
              onClearSelection={() => queue.setSelectedForCombine([])}
              onOpenMultiClipComposer={() => queue.setMultiClipModalOpen(true)}
              onRemoveItem={queue.handleRemoveQueueItem}
              onClearPending={queue.handleClearPending}
              stylePreset={stylePreset}
              onChangeStylePreset={handleChangeStylePreset}
              customInstruction={customInstruction}
              onChangeCustomInstruction={setCustomInstruction}
              tiktokOptions={tiktokOptions}
              onChangeTikTokOptions={handleChangeTikTokOptions}
              exportQuality={settings.exportQuality}
              onChangeExportQuality={handleChangeExportQuality}
              alreadyEditedCount={queue.alreadyEditedCount}
              lastScanTime={queue.lastScanTime}
              isScanning={queue.isScanning}
              isProcessingAny={queue.isProcessingAny}
              isDriveConnected={isDriveConnected}
              folderId={settings.folderId}
              onScanFolder={queue.handleScanFolder}
              onProcessItem={queue.processSingleItem}
              onProcessAllPending={queue.handleProcessAllPending}
              onOpenStudio={openItemInStudio}
              onAddLocalFiles={queue.handleAddLocalFiles}
              onLoadDemo={queue.handleLoadDemo}
              onGoToSettings={() => setActiveView('settings')}
            />
          )}

          {activeView === 'gallery' && (
            <GalleryView
              items={queue.items}
              isDriveConnected={isDriveConnected}
              restoringDriveId={queue.restoringDriveId}
              onOpenStudio={openItemInStudio}
              onRequestDriveUpload={queue.handleRequestDriveUpload}
              onDownloadFromDrive={queue.handleDownloadFromDrive}
              onLoadDemo={queue.handleLoadDemo}
              onGoToQueue={() => setActiveView('queue')}
            />
          )}

          {activeView === 'studio' && (
            <StudioView
              items={queue.items}
              selectedItemId={studio.selectedStudioId}
              onSelectItem={studio.setSelectedStudioId}
              onToggleCut={studio.handleToggleCut}
              onSelectAllCuts={studio.handleSelectAllCuts}
              onReorderCut={studio.handleReorderCut}
              onUpdateCutTiming={studio.handleUpdateCutTiming}
              onRerenderItem={studio.handleRerenderItem}
              onRequestDriveUpload={queue.handleRequestDriveUpload}
              exportQuality={settings.exportQuality}
              onChangeExportQuality={handleChangeExportQuality}
              tiktokOptions={tiktokOptions}
              onChangeTikTokOptions={handleChangeTikTokOptions}
              isRendering={studio.isStudioRendering}
              renderProgress={studio.studioRenderProgress}
              canUploadToDrive={Boolean(isDriveConnected && settings.folderId)}
              onBackToQueue={() => setActiveView('queue')}
            />
          )}

          {activeView === 'settings' && (
            <SettingsView
              settings={settings}
              onSaveSettings={persistSettings}
              onResetSettings={resetSettings}
              user={user}
              isLoggingIn={isLoggingIn}
              onGoogleLogin={handleGoogleLogin}
              onGoogleLogout={handleGoogleLogout}
              geminiConfigured={geminiConfigured}
              cacheStats={cacheStats}
              isClearingCache={queue.isClearingCache}
              onClearVideoCache={queue.handleClearVideoCache}
              onCopyDiagnosticReport={handleCopyDiagnosticReport}
            />
          )}
        </main>
      </div>

      {/* Fixed iOS/Mobile Bottom Tab Bar (< md) */}
      <MobileBottomNav
        activeView={activeView}
        onSelectView={setActiveView}
        queueCounts={queue.queueCounts}
      />

      <MultiClipComposerModal
        open={queue.multiClipModalOpen}
        selectedItems={queue.selectedCombineItems}
        stylePreset={stylePreset}
        onChangeStylePreset={handleChangeStylePreset}
        customInstruction={customInstruction}
        onChangeCustomInstruction={setCustomInstruction}
        tiktokOptions={tiktokOptions}
        onChangeTikTokOptions={handleChangeTikTokOptions}
        exportQuality={settings.exportQuality}
        onChangeExportQuality={handleChangeExportQuality}
        onClose={() => queue.setMultiClipModalOpen(false)}
        onStartCombine={queue.handleStartMultiClipCombine}
        isProcessing={queue.isProcessingAny}
      />

      <DriveConfirmModal
        pendingUpload={queue.pendingDriveUpload}
        onConfirm={queue.handleConfirmDriveUpload}
        onCancel={() => queue.setPendingDriveUpload(null)}
        isUploading={queue.isUploadingToDrive}
      />

      <DiagnosticCopyModal
        open={Boolean(manualCopyReport)}
        reportText={manualCopyReport ?? ''}
        onClose={() => setManualCopyReport(null)}
      />

      <OfflineIndicator />
    </div>
  );
}

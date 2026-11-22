import { useCallback, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, RefreshCw, X } from 'lucide-react';
import type { ActiveView } from './types';
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
import { OfflineIndicator } from './components/PWAInstallButton';

const VIEW_TITLES: Record<ActiveView, string> = {
  queue: 'Cola de vídeos',
  gallery: 'Galería de resultados',
  studio: 'Estudio de cortes',
  settings: 'Ajustes',
};

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('queue');
  const [bannerError, setBannerError] = useState<string | null>(null);

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
  } = useGoogleDriveAuth({ onError: setBannerError });

  const queue = useVideoQueue({
    settings,
    persistSettings,
    stylePreset,
    customInstruction,
    tiktokOptions,
    accessToken,
    clearAuthSession,
    refreshCacheStats,
    onError: setBannerError,
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
    onError: setBannerError,
  });

  selectStudioRef.current = studio.setSelectedStudioId;

  const openItemInStudio = useCallback(
    (itemId: string) => {
      studio.setSelectedStudioId(itemId);
      setActiveView('studio');
    },
    [studio]
  );

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
              className="flex items-start justify-between gap-3 rounded-md border border-[#ff2a85]/50 bg-[#ff2a85]/12 px-4 py-3 text-xs text-[#ffb3d1] shadow-[0_0_20px_rgba(255,42,133,0.14)]"
            >
              <span className="flex items-start gap-2.5 leading-relaxed">
                <AlertCircle className="h-4 w-4 shrink-0 text-[#ff2a85] mt-0.5" />
                <span>{bannerError}</span>
              </span>
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
              <span className="flex items-start gap-2.5 leading-relaxed">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[#fcee0a] mt-0.5" />
                <span>{queue.heavyVideoWarning}</span>
              </span>
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

      <OfflineIndicator />
    </div>
  );
}

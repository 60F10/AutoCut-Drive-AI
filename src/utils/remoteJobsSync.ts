import type {
  AnalyzeJobSyncEntry,
  CloudWorkflowRunStatus,
  PcJobSyncEntry,
  PcWorkerStatus,
  ProcessEngineMode,
  RenderJobTarget,
} from '../types';

export const BASE_REMOTE_POLL_INTERVAL_MS = 15_000;
export const MAX_REMOTE_POLL_BACKOFF_MS = 120_000;
export const STUCK_CLOUD_JOB_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
export const STUCK_CLOUD_JOB_MAX_PROGRESS = 5;
export const PC_HEARTBEAT_ONLINE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
export const PC_JOB_FALLBACK_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
export const CLOUD_WORKFLOW_FAILED_MESSAGE = '[GitHub] El workflow falló. Revisa Actions.';

/**
 * Considers the PC worker online if `_worker_status.json` has a `lastSeen` timestamp < 3 minutes old.
 */
export function isPcWorkerOnline(
  workerStatus: PcWorkerStatus | null | undefined,
  nowMs = Date.now(),
  thresholdMs = PC_HEARTBEAT_ONLINE_THRESHOLD_MS
): boolean {
  if (!workerStatus || typeof workerStatus.lastSeen !== 'string') return false;
  const lastSeenMs = Date.parse(workerStatus.lastSeen);
  if (!Number.isFinite(lastSeenMs)) return false;
  const ageMs = nowMs - lastSeenMs;
  return ageMs < thresholdMs && ageMs >= -60_000;
}

/**
 * Resolves the target engine ('pc' | 'cloud') for a new analysis or render job
 * based on user preference (`processEngine`) and PC heartbeat status (`pcOnline`).
 */
export function resolveProcessTarget(params: {
  processEngine: ProcessEngineMode;
  pcOnline: boolean;
}): RenderJobTarget {
  if (params.processEngine === 'pc') return 'pc';
  if (params.processEngine === 'cloud') return 'cloud';
  return params.pcOnline ? 'pc' : 'cloud';
}

/**
 * Returns true if a pending PC job has waited > 3 minutes while the PC heartbeat is expired/offline,
 * enabling the manual "Enviar a la nube" fallback button.
 */
export function canFallbackPcJobToCloud(params: {
  target?: RenderJobTarget;
  status?: string;
  createdAt?: string;
  pcOnline: boolean;
  cloudRenderConfigured: boolean;
  nowMs?: number;
  thresholdMs?: number;
}): boolean {
  if (!params.cloudRenderConfigured) return false;
  if (params.pcOnline) return false;
  if (params.target === 'cloud') return false;
  if (params.status !== 'pending') return false;
  const createdMs = Date.parse(params.createdAt || '');
  if (!Number.isFinite(createdMs)) return false;
  const nowMs = params.nowMs ?? Date.now();
  const thresholdMs = params.thresholdMs ?? PC_JOB_FALLBACK_THRESHOLD_MS;
  return nowMs - createdMs > thresholdMs;
}

export const JOB_FILE_ID_REGEX = /^[A-Za-z0-9_-]{10,128}$/;

export interface GitHubWorkflowRunLike {
  status?: unknown;
  conclusion?: unknown;
  display_title?: unknown;
  html_url?: unknown;
}

export interface CloudWorkflowFailureRecord {
  jobFileId: string;
  message: string;
  htmlUrl: string | null;
  conclusion: 'failure' | 'cancelled';
  detectedAt: number;
}

/**
 * Validates that a Drive jobFileId matches the expected safe identifier pattern.
 */
export function isValidJobFileId(jobFileId: string): boolean {
  return JOB_FILE_ID_REGEX.test(jobFileId.trim());
}

/**
 * Validates that an external GitHub Actions URL uses HTTPS on github.com.
 */
export function isSafeGitHubRunUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

/**
 * Finds the latest GitHub Actions run whose `display_title` contains the given `jobFileId`.
 */
export function findMatchingWorkflowRun(
  runs: GitHubWorkflowRunLike[],
  jobFileId: string
): CloudWorkflowRunStatus {
  const safeId = jobFileId.trim();
  if (!safeId || !Array.isArray(runs)) {
    return { status: null, conclusion: null, htmlUrl: null };
  }

  const matched = runs.find(
    (run) => typeof run?.display_title === 'string' && run.display_title.includes(safeId)
  );

  if (!matched) {
    return { status: null, conclusion: null, htmlUrl: null };
  }

  return {
    status: typeof matched.status === 'string' ? matched.status : null,
    conclusion: typeof matched.conclusion === 'string' ? matched.conclusion : null,
    htmlUrl: isSafeGitHubRunUrl(matched.html_url) ? matched.html_url.trim() : null,
  };
}

/**
 * Returns true if an HTTP status from Google Drive should trigger exponential polling backoff (429 or 5xx).
 */
export function isBackoffTriggerHttpStatus(status?: number | null): boolean {
  if (typeof status !== 'number' || !Number.isFinite(status)) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Computes the next exponential backoff interval: 15 s -> 30 s -> 60 s -> 120 s (capped at 120 s).
 */
export function computeNextPollBackoffMs(currentIntervalMs: number): number {
  const safeCurrent =
    Number.isFinite(currentIntervalMs) && currentIntervalMs >= BASE_REMOTE_POLL_INTERVAL_MS
      ? currentIntervalMs
      : BASE_REMOTE_POLL_INTERVAL_MS;
  return Math.min(MAX_REMOTE_POLL_BACKOFF_MS, safeCurrent * 2);
}

/**
 * Determines whether a cloud job is stuck in pending/processing (progress <= 5) for > 3 minutes
 * after dispatch and therefore should have its GitHub Actions workflow run inspected.
 */
export function isCloudJobStuckForWorkflowCheck(params: {
  isCloud: boolean;
  status: string;
  progress?: number;
  dispatchedAtMs: number | null;
  nowMs: number;
  thresholdMs?: number;
}): boolean {
  const {
    isCloud,
    status,
    progress = 0,
    dispatchedAtMs,
    nowMs,
    thresholdMs = STUCK_CLOUD_JOB_THRESHOLD_MS,
  } = params;

  if (!isCloud) return false;
  if (status !== 'pending' && status !== 'processing') return false;
  if ((Number.isFinite(progress) ? progress : 0) > STUCK_CLOUD_JOB_MAX_PROGRESS) return false;
  if (dispatchedAtMs === null || !Number.isFinite(dispatchedAtMs)) return false;

  return nowMs - dispatchedAtMs > thresholdMs;
}

/**
 * Resolves the dispatch timestamp for a cloud job, preferring the local dispatch clock
 * and falling back to manifest timestamps when the page was reloaded.
 */
export function resolveJobDispatchedAtMs(
  localDispatchedAtMs: number | undefined,
  manifestCreatedAt?: string,
  manifestUpdatedAt?: string
): number | null {
  if (typeof localDispatchedAtMs === 'number' && Number.isFinite(localDispatchedAtMs)) {
    return localDispatchedAtMs;
  }
  const createdMs = Date.parse(manifestCreatedAt || '');
  if (Number.isFinite(createdMs)) return createdMs;
  const updatedMs = Date.parse(manifestUpdatedAt || '');
  if (Number.isFinite(updatedMs)) return updatedMs;
  return null;
}

/**
 * Checks whether a GitHub Actions workflow run conclusion represents a terminal workflow failure.
 */
export function isFailedWorkflowConclusion(
  conclusion?: string | null
): conclusion is 'failure' | 'cancelled' {
  return conclusion === 'failure' || conclusion === 'cancelled';
}

/**
 * Applies locally detected GitHub workflow failure overrides onto Drive render job entries
 * when Drive still holds a stale `pending`/`processing` manifest with `progress <= 5`.
 */
export function applyWorkflowFailuresToRenderJobs(
  entries: PcJobSyncEntry[],
  failures: Record<string, CloudWorkflowFailureRecord>
): PcJobSyncEntry[] {
  return entries.map((entry) => {
    const failure = failures[entry.jobFileId];
    if (!failure) return entry;
    const isStalePendingOrLowProgress =
      (entry.manifest.status === 'pending' || entry.manifest.status === 'processing') &&
      (entry.manifest.progress ?? 0) <= STUCK_CLOUD_JOB_MAX_PROGRESS;
    if (!isStalePendingOrLowProgress) return entry;

    return {
      ...entry,
      workflowRunUrl: failure.htmlUrl,
      manifest: {
        ...entry.manifest,
        status: 'error',
        errorMessage: failure.message,
      },
    };
  });
}

/**
 * Applies locally detected GitHub workflow failure overrides onto Drive analyze job entries
 * when Drive still holds a stale `pending`/`processing` manifest with `progress <= 5`.
 */
export function applyWorkflowFailuresToAnalyzeJobs(
  entries: AnalyzeJobSyncEntry[],
  failures: Record<string, CloudWorkflowFailureRecord>
): AnalyzeJobSyncEntry[] {
  return entries.map((entry) => {
    const failure = failures[entry.jobFileId];
    if (!failure) return entry;
    const isStalePendingOrLowProgress =
      (entry.manifest.status === 'pending' || entry.manifest.status === 'processing') &&
      (entry.manifest.progress ?? 0) <= STUCK_CLOUD_JOB_MAX_PROGRESS;
    if (!isStalePendingOrLowProgress) return entry;

    return {
      ...entry,
      workflowRunUrl: failure.htmlUrl,
      manifest: {
        ...entry.manifest,
        status: 'error',
        errorMessage: failure.message,
      },
    };
  });
}

/**
 * Returns true if any remote render or analyze job is still actively pending/processing.
 */
export function hasActiveRemoteJobs(
  pcJobs: PcJobSyncEntry[],
  analyzeJobs: AnalyzeJobSyncEntry[]
): boolean {
  return (
    pcJobs.some(
      (entry) => entry.manifest.status === 'pending' || entry.manifest.status === 'processing'
    ) ||
    analyzeJobs.some(
      (entry) => entry.manifest.status === 'pending' || entry.manifest.status === 'processing'
    )
  );
}

export interface PollerTimerHost {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
  isDocumentVisible?: () => boolean;
}

/**
 * Guarantees at most ONE active polling interval regardless of React re-renders
 * or job list mutations. Recreates the timer ONLY when `shouldPoll` toggles or
 * `intervalMs` changes (e.g. during 429/5xx exponential backoff).
 */
export class RemoteJobsPoller {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private activeIntervalMs: number | null = null;
  private onTick: (() => void) | null = null;
  private readonly host: PollerTimerHost;

  constructor(host?: Partial<PollerTimerHost>) {
    this.host = {
      setInterval: host?.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms)),
      clearInterval: host?.clearInterval ?? ((id) => globalThis.clearInterval(id)),
      isDocumentVisible:
        host?.isDocumentVisible ??
        (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible')),
    };
  }

  get isActive(): boolean {
    return this.timerId !== null;
  }

  get currentIntervalMs(): number | null {
    return this.activeIntervalMs;
  }

  update(config: { shouldPoll: boolean; intervalMs: number; onTick: () => void }): void {
    this.onTick = config.onTick;

    if (!config.shouldPoll) {
      this.stop();
      return;
    }

    const safeIntervalMs = Math.max(BASE_REMOTE_POLL_INTERVAL_MS, Math.round(config.intervalMs));
    if (this.timerId !== null && this.activeIntervalMs === safeIntervalMs) {
      // Keep the existing single interval intact without tearing it down
      return;
    }

    this.stop();
    this.activeIntervalMs = safeIntervalMs;
    this.timerId = this.host.setInterval(() => {
      if (this.host.isDocumentVisible && !this.host.isDocumentVisible()) {
        return;
      }
      this.onTick?.();
    }, safeIntervalMs);
  }

  stop(): void {
    if (this.timerId !== null) {
      this.host.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.activeIntervalMs = null;
  }

  dispose(): void {
    this.stop();
    this.onTick = null;
  }
}

export interface InspectStuckCloudJobsLogger {
  info: (message: string, details?: Record<string, string | number | boolean | undefined>) => void;
  warn: (message: string, details?: Record<string, string | number | boolean | undefined>) => void;
  error: (message: string, details?: Record<string, string | number | boolean | undefined>) => void;
}

export interface InspectStuckCloudJobsResult {
  failures: Record<string, CloudWorkflowFailureRecord>;
  checkedJobFileIds: string[];
  missingRunJobFileIds: string[];
  jobs: PcJobSyncEntry[];
  analyzeJobs: AnalyzeJobSyncEntry[];
}

/**
 * Inspects cloud jobs (render & analyze) that remain in `pending`/`processing` with `progress <= 5`
 * for more than 3 minutes after dispatch by querying `/api/cloud-render/status`.
 * Marks jobs whose workflow conclusion is `'failure'` or `'cancelled'` as `error` with
 * `CLOUD_WORKFLOW_FAILED_MESSAGE` and attaches `workflowRunUrl`.
 */
export async function inspectStuckCloudJobs(params: {
  jobs: PcJobSyncEntry[];
  analyzeJobs: AnalyzeJobSyncEntry[];
  cloudRenderConfigured: boolean;
  dispatchedAtByJobFileId: Record<string, number>;
  existingFailures: Record<string, CloudWorkflowFailureRecord>;
  nowMs: number;
  fetchWorkflowStatus: (jobFileId: string) => Promise<CloudWorkflowRunStatus>;
  logger?: InspectStuckCloudJobsLogger;
}): Promise<InspectStuckCloudJobsResult> {
  const {
    jobs,
    analyzeJobs,
    cloudRenderConfigured,
    dispatchedAtByJobFileId,
    existingFailures,
    nowMs,
    fetchWorkflowStatus,
    logger,
  } = params;

  const nextFailures: Record<string, CloudWorkflowFailureRecord> = { ...existingFailures };
  const checkedJobFileIds: string[] = [];
  const missingRunJobFileIds: string[] = [];

  // Prune stale local failure overrides if Drive now shows real progress (>5%) or terminal state
  for (const entry of jobs) {
    const hasProgressed =
      entry.manifest.status === 'completed' ||
      entry.manifest.status === 'error' ||
      (entry.manifest.status === 'processing' &&
        (entry.manifest.progress ?? 0) > STUCK_CLOUD_JOB_MAX_PROGRESS);
    if (hasProgressed && nextFailures[entry.jobFileId]) {
      delete nextFailures[entry.jobFileId];
    }
  }
  for (const entry of analyzeJobs) {
    const hasProgressed =
      entry.manifest.status === 'analyzed' ||
      entry.manifest.status === 'error' ||
      (entry.manifest.status === 'processing' &&
        (entry.manifest.progress ?? 0) > STUCK_CLOUD_JOB_MAX_PROGRESS);
    if (hasProgressed && nextFailures[entry.jobFileId]) {
      delete nextFailures[entry.jobFileId];
    }
  }

  if (cloudRenderConfigured) {
    const candidates: Array<{
      kind: 'render' | 'analyze';
      jobId: string;
      jobFileId: string;
      status: string;
      progress: number;
      dispatchedAtMs: number | null;
    }> = [];

    for (const entry of jobs) {
      if (entry.manifest.target !== 'cloud') continue;
      if (nextFailures[entry.jobFileId]) continue;
      const dispatchedAtMs = resolveJobDispatchedAtMs(
        dispatchedAtByJobFileId[entry.jobFileId],
        entry.manifest.createdAt,
        entry.manifest.updatedAt
      );
      if (
        isCloudJobStuckForWorkflowCheck({
          isCloud: true,
          status: entry.manifest.status,
          progress: entry.manifest.progress,
          dispatchedAtMs,
          nowMs,
        })
      ) {
        candidates.push({
          kind: 'render',
          jobId: entry.manifest.jobId,
          jobFileId: entry.jobFileId,
          status: entry.manifest.status,
          progress: entry.manifest.progress ?? 0,
          dispatchedAtMs,
        });
      }
    }

    for (const entry of analyzeJobs) {
      if (entry.manifest.target === 'pc') continue;
      if (nextFailures[entry.jobFileId]) continue;
      const dispatchedAtMs = resolveJobDispatchedAtMs(
        dispatchedAtByJobFileId[entry.jobFileId],
        entry.manifest.createdAt,
        entry.manifest.updatedAt
      );
      if (
        isCloudJobStuckForWorkflowCheck({
          isCloud: true,
          status: entry.manifest.status,
          progress: entry.manifest.progress,
          dispatchedAtMs,
          nowMs,
        })
      ) {
        candidates.push({
          kind: 'analyze',
          jobId: entry.manifest.jobId,
          jobFileId: entry.jobFileId,
          status: entry.manifest.status,
          progress: entry.manifest.progress ?? 0,
          dispatchedAtMs,
        });
      }
    }

    for (const candidate of candidates) {
      checkedJobFileIds.push(candidate.jobFileId);
      const waitMin = candidate.dispatchedAtMs
        ? Math.round((nowMs - candidate.dispatchedAtMs) / 60_000)
        : 0;
      logger?.info('Comprobando workflow en GitHub Actions para job atascado (>3 min)', {
        jobId: candidate.jobId,
        tipo: candidate.kind,
        estadoDrive: candidate.status,
        progreso: candidate.progress,
        esperaMin: waitMin,
      });

      try {
        const runStatus = await fetchWorkflowStatus(candidate.jobFileId);
        if (isFailedWorkflowConclusion(runStatus.conclusion)) {
          nextFailures[candidate.jobFileId] = {
            jobFileId: candidate.jobFileId,
            message: CLOUD_WORKFLOW_FAILED_MESSAGE,
            htmlUrl: isSafeGitHubRunUrl(runStatus.htmlUrl) ? runStatus.htmlUrl : null,
            conclusion: runStatus.conclusion,
            detectedAt: nowMs,
          };
          logger?.error('Workflow de GitHub Actions falló; marcando job como error', {
            jobId: candidate.jobId,
            tipo: candidate.kind,
            status: runStatus.status ?? 'completed',
            conclusion: runStatus.conclusion,
          });
        } else if (!runStatus.status && !runStatus.conclusion) {
          missingRunJobFileIds.push(candidate.jobFileId);
          logger?.warn('No se encontró ejecución en GitHub Actions tras >3 min', {
            jobId: candidate.jobId,
            tipo: candidate.kind,
          });
        } else {
          logger?.info('Workflow en GitHub Actions sigue activo o finalizado sin error', {
            jobId: candidate.jobId,
            tipo: candidate.kind,
            status: runStatus.status ?? 'desconocido',
            conclusion: runStatus.conclusion ?? 'en_curso',
          });
        }
      } catch (err) {
        logger?.warn('No se pudo consultar el estado del workflow en GitHub Actions', {
          jobId: candidate.jobId,
          tipo: candidate.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    failures: nextFailures,
    checkedJobFileIds,
    missingRunJobFileIds,
    jobs: applyWorkflowFailuresToRenderJobs(jobs, nextFailures),
    analyzeJobs: applyWorkflowFailuresToAnalyzeJobs(analyzeJobs, nextFailures),
  };
}


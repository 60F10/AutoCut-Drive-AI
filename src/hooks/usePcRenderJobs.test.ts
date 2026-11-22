import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalyzeJobSyncEntry, PcJobSyncEntry } from '../types';
import {
  BASE_REMOTE_POLL_INTERVAL_MS,
  CLOUD_WORKFLOW_FAILED_MESSAGE,
  MAX_REMOTE_POLL_BACKOFF_MS,
  RemoteJobsPoller,
  STUCK_CLOUD_JOB_THRESHOLD_MS,
  computeNextPollBackoffMs,
  findMatchingWorkflowRun,
  hasActiveRemoteJobs,
  inspectStuckCloudJobs,
  isBackoffTriggerHttpStatus,
  isSafeGitHubRunUrl,
  isValidJobFileId,
  type CloudWorkflowFailureRecord,
} from '../utils/remoteJobsSync';

function makeRenderJob(overrides: {
  jobId?: string;
  jobFileId?: string;
  target?: 'cloud' | 'pc';
  status?: 'pending' | 'processing' | 'completed' | 'error';
  progress?: number;
  createdAt?: string;
}): PcJobSyncEntry {
  const jobId = overrides.jobId ?? 'job_1';
  return {
    jobFileId: overrides.jobFileId ?? '1AbCdEfGhIjKlMnOpQr',
    jobFileName: `job_${jobId}.json`,
    manifest: {
      jobId,
      kind: 'render',
      target: overrides.target ?? 'cloud',
      createdAt: overrides.createdAt ?? '2026-11-22T10:00:00.000Z',
      status: overrides.status ?? 'pending',
      progress: overrides.progress ?? 0,
      outputFileName: 'clip_EDITADO.mp4',
      sourceFiles: [{ name: 'clip.mp4', driveFileId: 'src_1234567890' }],
      cuts: [{ clipIndex: 0, start: 0, end: 5 }],
      options: {
        quality: '1080p',
        framing: 'center_crop',
        removeSilences: false,
        normalizeAudio: true,
        subtitlesEnabled: false,
      },
    },
  };
}

function makeAnalyzeJob(overrides: {
  jobId?: string;
  jobFileId?: string;
  status?: 'pending' | 'processing' | 'analyzed' | 'error';
  progress?: number;
  createdAt?: string;
}): AnalyzeJobSyncEntry {
  const jobId = overrides.jobId ?? 'an_1';
  return {
    jobFileId: overrides.jobFileId ?? '2ZyXwVuTsRqPoNmLkJi',
    jobFileName: `analyze_${jobId}.json`,
    manifest: {
      jobId,
      kind: 'analyze',
      target: 'cloud',
      createdAt: overrides.createdAt ?? '2026-11-22T10:00:00.000Z',
      status: overrides.status ?? 'pending',
      progress: overrides.progress ?? 0,
      stage: 'descarga',
      sourceFiles: [{ name: 'clip.mp4', driveFileId: 'src_1234567890' }],
      options: {
        model: 'gemini-3.8-flash',
        whisperModel: 'small',
        stylePreset: 'funny_jumpcut',
        targetDurationSec: 45,
        silenceTrimEnabled: true,
        subtitlesEnabled: true,
      },
    },
  };
}

test('RemoteJobsPoller creates a single 15 s interval even when jobs change state across renders', () => {
  let nextTimerId = 1;
  const createdIntervals: Array<{ id: number; ms: number; fn: () => void }> = [];
  const clearedIds: number[] = [];
  let visible = true;
  let tickCount = 0;

  const poller = new RemoteJobsPoller({
    setInterval: (fn, ms) => {
      const id = nextTimerId++;
      createdIntervals.push({ id, ms, fn });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (id) => {
      clearedIds.push(id as unknown as number);
    },
    isDocumentVisible: () => visible,
  });

  // Render 1: initial pending cloud job -> creates 1 interval at 15,000 ms
  const jobsState1 = [makeRenderJob({ status: 'pending', progress: 0 })];
  poller.update({
    shouldPoll: hasActiveRemoteJobs(jobsState1, []) && visible,
    intervalMs: BASE_REMOTE_POLL_INTERVAL_MS,
    onTick: () => {
      tickCount += 1;
    },
  });

  assert.equal(createdIntervals.length, 1);
  assert.equal(createdIntervals[0].ms, 15_000);
  assert.equal(clearedIds.length, 0);
  assert.equal(poller.isActive, true);

  // Render 2: job transitions to processing 25% with brand-new array and new callback
  const jobsState2 = [makeRenderJob({ status: 'processing', progress: 25 })];
  poller.update({
    shouldPoll: hasActiveRemoteJobs(jobsState2, []) && visible,
    intervalMs: BASE_REMOTE_POLL_INTERVAL_MS,
    onTick: () => {
      tickCount += 10;
    },
  });

  // Render 3: second analyze job added, render job at 75%
  const jobsState3 = [makeRenderJob({ status: 'processing', progress: 75 })];
  const analyzeState3 = [makeAnalyzeJob({ status: 'pending', progress: 0 })];
  poller.update({
    shouldPoll: hasActiveRemoteJobs(jobsState3, analyzeState3) && visible,
    intervalMs: BASE_REMOTE_POLL_INTERVAL_MS,
    onTick: () => {
      tickCount += 100;
    },
  });

  // Still ONLY ONE interval was ever created, and none were cleared
  assert.equal(createdIntervals.length, 1);
  assert.equal(clearedIds.length, 0);

  // Tick invokes the latest onTick callback without recreating the timer
  createdIntervals[0].fn();
  assert.equal(tickCount, 100);

  // When tab becomes hidden, tick is skipped and update(shouldPoll=false) clears the interval
  visible = false;
  createdIntervals[0].fn();
  assert.equal(tickCount, 100);

  poller.update({
    shouldPoll: hasActiveRemoteJobs(jobsState3, analyzeState3) && visible,
    intervalMs: BASE_REMOTE_POLL_INTERVAL_MS,
    onTick: () => {
      tickCount += 1000;
    },
  });
  assert.deepEqual(clearedIds, [1]);
  assert.equal(poller.isActive, false);

  // When all jobs complete and tab is visible again, NO new interval is created
  visible = true;
  const completedJobs = [makeRenderJob({ status: 'completed', progress: 100 })];
  const analyzedJobs = [makeAnalyzeJob({ status: 'analyzed', progress: 100 })];
  poller.update({
    shouldPoll: hasActiveRemoteJobs(completedJobs, analyzedJobs) && visible,
    intervalMs: BASE_REMOTE_POLL_INTERVAL_MS,
    onTick: () => {
      tickCount += 1;
    },
  });
  assert.equal(createdIntervals.length, 1);
  assert.equal(poller.isActive, false);

  poller.dispose();
});

test('exponential backoff scales 15 s -> 30 s -> 60 s -> 120 s (max) on Drive 429/5xx', () => {
  assert.equal(isBackoffTriggerHttpStatus(429), true);
  assert.equal(isBackoffTriggerHttpStatus(500), true);
  assert.equal(isBackoffTriggerHttpStatus(503), true);
  assert.equal(isBackoffTriggerHttpStatus(400), false);
  assert.equal(isBackoffTriggerHttpStatus(404), false);

  const step1 = computeNextPollBackoffMs(BASE_REMOTE_POLL_INTERVAL_MS);
  const step2 = computeNextPollBackoffMs(step1);
  const step3 = computeNextPollBackoffMs(step2);
  const step4 = computeNextPollBackoffMs(step3);

  assert.equal(step1, 30_000);
  assert.equal(step2, 60_000);
  assert.equal(step3, 120_000);
  assert.equal(step4, MAX_REMOTE_POLL_BACKOFF_MS);
});

test('stuck cloud render job with failed GitHub Actions run transitions to error and stops polling', async () => {
  const dispatchedAt = Date.parse('2026-11-22T10:00:00.000Z');
  const nowMs = dispatchedAt + STUCK_CLOUD_JOB_THRESHOLD_MS + 10_000; // 3 min 10 s later
  const jobFileId = '1AbCdEfGhIjKlMnOpQr';
  const failedRunUrl = 'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/987654321';

  const loggedEvents: Array<{ level: string; message: string }> = [];
  let statusCalls = 0;

  const jobEntry = makeRenderJob({
    jobId: 'render_stuck_1',
    jobFileId,
    target: 'cloud',
    status: 'pending',
    progress: 0,
    createdAt: '2026-11-22T10:00:00.000Z',
  });

  const result = await inspectStuckCloudJobs({
    jobs: [jobEntry],
    analyzeJobs: [],
    cloudRenderConfigured: true,
    dispatchedAtByJobFileId: { [jobFileId]: dispatchedAt },
    existingFailures: {},
    nowMs,
    fetchWorkflowStatus: async (id) => {
      statusCalls += 1;
      assert.equal(id, jobFileId);
      return {
        status: 'completed',
        conclusion: 'failure',
        htmlUrl: failedRunUrl,
      };
    },
    logger: {
      info: (message) => loggedEvents.push({ level: 'INFO', message }),
      warn: (message) => loggedEvents.push({ level: 'WARN', message }),
      error: (message) => loggedEvents.push({ level: 'ERROR', message }),
    },
  });

  assert.equal(statusCalls, 1);
  assert.equal(result.jobs[0].manifest.status, 'error');
  assert.equal(result.jobs[0].manifest.errorMessage, CLOUD_WORKFLOW_FAILED_MESSAGE);
  assert.equal(result.jobs[0].workflowRunUrl, failedRunUrl);
  assert.equal(hasActiveRemoteJobs(result.jobs, result.analyzeJobs), false);
  assert.ok(loggedEvents.some((e) => e.level === 'INFO'));
  assert.ok(loggedEvents.some((e) => e.level === 'ERROR'));

  // Subsequent Drive sync still returns stale `pending` manifest: failure override persists without re-calling GitHub
  const secondSync = await inspectStuckCloudJobs({
    jobs: [jobEntry],
    analyzeJobs: [],
    cloudRenderConfigured: true,
    dispatchedAtByJobFileId: { [jobFileId]: dispatchedAt },
    existingFailures: result.failures,
    nowMs: nowMs + 15_000,
    fetchWorkflowStatus: async () => {
      statusCalls += 1;
      return { status: null, conclusion: null, htmlUrl: null };
    },
  });

  assert.equal(statusCalls, 1);
  assert.equal(secondSync.jobs[0].manifest.status, 'error');
  assert.equal(secondSync.jobs[0].manifest.errorMessage, CLOUD_WORKFLOW_FAILED_MESSAGE);
  assert.equal(secondSync.jobs[0].workflowRunUrl, failedRunUrl);
});

test('stuck cloud analyze job with cancelled workflow transitions to error, while non-stuck jobs are ignored', async () => {
  const dispatchedAt = Date.parse('2026-11-22T10:00:00.000Z');
  const nowMs = dispatchedAt + STUCK_CLOUD_JOB_THRESHOLD_MS + 30_000;
  const stuckAnalyzeId = '2ZyXwVuTsRqPoNmLkJi';
  const freshRenderId = '3FreshJobId12345678';
  const progressingRenderId = '4ProgressJobId12345';
  const pcRenderId = '5PcOnlyJobId1234567';

  const checkedIds: string[] = [];

  const result = await inspectStuckCloudJobs({
    jobs: [
      makeRenderJob({
        jobId: 'fresh',
        jobFileId: freshRenderId,
        status: 'pending',
        progress: 0,
        createdAt: new Date(nowMs - 60_000).toISOString(), // only 1 min old
      }),
      makeRenderJob({
        jobId: 'progressing',
        jobFileId: progressingRenderId,
        status: 'processing',
        progress: 35, // progress > 5
        createdAt: '2026-11-22T10:00:00.000Z',
      }),
      makeRenderJob({
        jobId: 'pc_job',
        jobFileId: pcRenderId,
        target: 'pc',
        status: 'pending',
        progress: 0,
        createdAt: '2026-11-22T10:00:00.000Z',
      }),
    ],
    analyzeJobs: [
      makeAnalyzeJob({
        jobId: 'analyze_cancelled',
        jobFileId: stuckAnalyzeId,
        status: 'processing',
        progress: 5, // <= 5
        createdAt: '2026-11-22T10:00:00.000Z',
      }),
    ],
    cloudRenderConfigured: true,
    dispatchedAtByJobFileId: {
      [stuckAnalyzeId]: dispatchedAt,
      [freshRenderId]: nowMs - 60_000,
      [progressingRenderId]: dispatchedAt,
      [pcRenderId]: dispatchedAt,
    },
    existingFailures: {} as Record<string, CloudWorkflowFailureRecord>,
    nowMs,
    fetchWorkflowStatus: async (id) => {
      checkedIds.push(id);
      return {
        status: 'completed',
        conclusion: 'cancelled',
        htmlUrl: 'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/555666777',
      };
    },
  });

  assert.deepEqual(checkedIds, [stuckAnalyzeId]);
  assert.equal(result.analyzeJobs[0].manifest.status, 'error');
  assert.equal(result.analyzeJobs[0].manifest.errorMessage, CLOUD_WORKFLOW_FAILED_MESSAGE);
  assert.equal(
    result.analyzeJobs[0].workflowRunUrl,
    'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/555666777'
  );
  // Non-stuck jobs remained untouched
  assert.equal(result.jobs[0].manifest.status, 'pending');
  assert.equal(result.jobs[1].manifest.status, 'processing');
  assert.equal(result.jobs[2].manifest.status, 'pending');
});

test('findMatchingWorkflowRun matches display_title by jobFileId and enforces safe ID/URL validation', () => {
  assert.equal(isValidJobFileId('1AbCdEfGhIjKlMn'), true);
  assert.equal(isValidJobFileId('short_123'), false);
  assert.equal(isValidJobFileId('bad/id?inject=1'), false);

  assert.equal(isSafeGitHubRunUrl('https://github.com/org/repo/actions/runs/42'), true);
  assert.equal(isSafeGitHubRunUrl('javascript:alert(1)'), false);
  assert.equal(isSafeGitHubRunUrl('https://evil.example.com/runs/42'), false);

  const matched = findMatchingWorkflowRun(
    [
      {
        display_title: 'cloud-render 9OtherJobFileId1234',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/100',
      },
      {
        display_title: 'cloud-render 1TargetJobFileId999',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/200',
      },
    ],
    '1TargetJobFileId999'
  );

  assert.deepEqual(matched, {
    status: 'completed',
    conclusion: 'failure',
    htmlUrl: 'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/200',
  });

  const missing = findMatchingWorkflowRun(
    [
      {
        display_title: 'cloud-render 9OtherJobFileId1234',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/60F10/AutoCut-Drive-AI/actions/runs/100',
      },
    ],
    '1NotPresentJobFileId'
  );
  assert.deepEqual(missing, { status: null, conclusion: null, htmlUrl: null });
});

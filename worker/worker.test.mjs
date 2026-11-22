import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUALITY_PROFILES,
  buildSegmentFfmpegArgs,
  getCloudCpuPreset,
  sanitizeOutputFilename,
} from './render-core.mjs';
import { shouldPcWorkerClaimJob } from './pc-worker.mjs';
import {
  RESUMABLE_CHUNK_BYTES,
  formatSafeCloudLog,
  parseCloudCliArgs,
  shouldCloudWorkerClaimJob,
} from './cloud-worker.mjs';

test('Cloud render FFmpeg args use libx264 with veryfast CRF 21 in 1080p and ultrafast CRF 24 in 720p', () => {
  assert.equal(getCloudCpuPreset('1080p'), 'veryfast');
  assert.equal(getCloudCpuPreset('720p'), 'ultrafast');
  assert.equal(QUALITY_PROFILES['1080p'].crf, '21');
  assert.equal(QUALITY_PROFILES['720p'].crf, '24');

  const args1080 = buildSegmentFfmpegArgs({
    inputPath: '/tmp/clip_0.mp4',
    outputPath: '/tmp/seg_000.mp4',
    cut: { clipIndex: 0, start: 2.5, end: 9.0 },
    profile: QUALITY_PROFILES['1080p'],
    framing: 'center_crop',
    removeSilences: true,
    normalizeAudio: true,
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: getCloudCpuPreset('1080p'),
  });

  assert.equal(args1080[args1080.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args1080[args1080.indexOf('-preset') + 1], 'veryfast');
  assert.equal(args1080[args1080.indexOf('-crf') + 1], '21');
  assert.ok(args1080.includes('-movflags'));
  assert.ok(args1080.includes('+faststart'));

  const args720 = buildSegmentFfmpegArgs({
    inputPath: '/tmp/clip_0.mp4',
    outputPath: '/tmp/seg_000.mp4',
    cut: { clipIndex: 0, start: 0, end: 5.0 },
    profile: QUALITY_PROFILES['720p'],
    framing: 'blur_bg',
    removeSilences: false,
    normalizeAudio: false,
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: getCloudCpuPreset('720p'),
  });

  assert.equal(args720[args720.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args720[args720.indexOf('-preset') + 1], 'ultrafast');
  assert.equal(args720[args720.indexOf('-crf') + 1], '24');
  const fc720 = args720[args720.indexOf('-filter_complex') + 1];
  assert.ok(fc720.includes('boxblur=24:4'));
  assert.ok(fc720.includes('720:1280'));
});

test('pc-worker ignores target: "cloud" jobs while cloud-worker claims only target: "cloud" pending jobs', () => {
  const cloudPending = { jobId: 'j1', status: 'pending', target: 'cloud' };
  const pcPending = { jobId: 'j2', status: 'pending', target: 'pc' };
  const legacyPending = { jobId: 'j3', status: 'pending' };
  const cloudProcessing = { jobId: 'j4', status: 'processing', target: 'cloud' };
  const pcCompleted = { jobId: 'j5', status: 'completed', target: 'pc' };

  // PC worker MUST ignore target === 'cloud'
  assert.equal(shouldPcWorkerClaimJob(cloudPending), false);
  assert.equal(shouldPcWorkerClaimJob(pcPending), true);
  assert.equal(shouldPcWorkerClaimJob(legacyPending), true);
  assert.equal(shouldPcWorkerClaimJob(cloudProcessing), false);
  assert.equal(shouldPcWorkerClaimJob(pcCompleted), false);

  // Cloud worker claims strictly pending jobs with target === 'cloud'
  assert.equal(shouldCloudWorkerClaimJob(cloudPending), true);
  assert.equal(shouldCloudWorkerClaimJob(pcPending), false);
  assert.equal(shouldCloudWorkerClaimJob(legacyPending), false);
  assert.equal(shouldCloudWorkerClaimJob(cloudProcessing), false);
});

test('cloud-worker formatSafeCloudLog never leaks filenames, OAuth tokens, headers, or folder IDs', () => {
  assert.equal(RESUMABLE_CHUNK_BYTES, 8 * 1024 * 1024);
  assert.deepEqual(parseCloudCliArgs(['--job-file-id', '1AbCdEfGhIjKlMnOp']), {
    jobFileId: '1AbCdEfGhIjKlMnOp',
  });
  assert.deepEqual(parseCloudCliArgs(['--job-file-id=1AbCdEfGhIjKlMnOp']), {
    jobFileId: '1AbCdEfGhIjKlMnOp',
  });

  const sensitiveFilename = 'vacaciones_familia_secreto.MOV';
  const sensitiveToken = 'ya29.a0AfH6SMFakeAccessToken1234567890';
  const sensitivePat = 'github_pat_11FAKE_SECRET_TOKEN_0000';
  const sensitiveFolderId = '1FolderIdPrivateXYZ1234567890';

  const line = formatSafeCloudLog('INFO', 'render_progress', {
    jobId: 'job_abc123',
    clips: 3,
    cuts: 7,
    mb: 142.5,
    sec: 38,
    http: 200,
    progress: 75,
    encoder: 'libx264',
    quality: '1080p',
    // Attempted leaks that MUST be dropped strictly by whitelist/sanitizer:
    fileName: sensitiveFilename,
    outputFileName: 'mi_video_privado.mp4',
    token: sensitiveToken,
    authorization: `Bearer ${sensitiveToken}`,
    githubToken: sensitivePat,
    folderId: sensitiveFolderId,
    headers: { Authorization: `Bearer ${sensitiveToken}` },
  });

  // Safe telemetry IS preserved
  assert.ok(line.includes('job_abc123'));
  assert.ok(line.includes('"clips":3'));
  assert.ok(line.includes('"mb":142.5'));
  assert.ok(line.includes('"sec":38'));
  assert.ok(line.includes('"progress":75'));
  assert.ok(line.includes('"encoder":"libx264"'));

  // Zero filenames, tokens, headers, or folder IDs in output
  assert.ok(!line.includes(sensitiveFilename));
  assert.ok(!line.includes('mi_video_privado.mp4'));
  assert.ok(!line.includes('ya29'));
  assert.ok(!line.includes('Bearer'));
  assert.ok(!line.includes('github_pat_'));
  assert.ok(!line.includes(sensitiveFolderId));

  // Even if someone passes a filename or token into an allowed string key (like jobId), it is rejected
  const blockedLeak = formatSafeCloudLog('WARN', 'check', {
    jobId: 'secret_video.mp4',
    encoder: 'ya29.tokenleak',
    quality: 'folder/sub/path',
  });
  assert.ok(!blockedLeak.includes('secret_video.mp4'));
  assert.ok(!blockedLeak.includes('ya29'));
  assert.ok(!blockedLeak.includes('folder/sub/path'));

  assert.equal(sanitizeOutputFilename('../evil/name.mp4', 'j9'), 'name.mp4');
});

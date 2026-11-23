import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  QUALITY_PROFILES,
  SDR_COLOR_ARGS,
  buildAssFileContent,
  buildFinalAssemblyFfmpegArgs,
  buildHdrToSdrFilterChain,
  buildSegmentFfmpegArgs,
  buildSubtitlesFromCutWords,
  getCloudCpuPreset,
  parseLoudnormMeasurements,
  resolveFinalSubtitles,
  sanitizeOutputFilename,
  verifyRenderedDurations,
} from './render-core.mjs';
import {
  RotatingFileLogger,
  buildWhisperEnv,
  formatSafePcLog,
  parseCliArgs,
  shouldPcWorkerClaimJob,
  writeWorkerHeartbeat,
} from './pc-worker.mjs';
import {
  cleanEditedRawVideos,
  cleanupStaleTempDirs,
  collectStorageInfo,
  createTempWorkDir,
  emptyWorkDir,
  executeCleanupScopes,
  getWorkDirConfig,
  processCleanupCommandFile,
  releaseTempWorkDir,
} from './cleanup.mjs';
import {
  RESUMABLE_CHUNK_BYTES,
  buildTranscriptCacheFilename,
  formatSafeCloudLog,
  getCloudJobRoute,
  isAnalyzeManifest,
  parseCloudCliArgs,
  shouldCloudWorkerClaimJob,
} from './cloud-worker.mjs';
import {
  PHASE_B_SCHEMA,
  PHASE_B_WITH_OVERLAYS_SCHEMA,
  buildPhaseBSystemInstruction,
  claimJobAtomically,
  convertPlanSegmentsToCuts,
  enforceTargetDuration,
  formatSentencesForPrompt,
  mapPhaseBOverlaysToCuts,
  parseWhisperDeviceLine,
  runPhaseBWithValidationRetry,
  stripBenignWhisperStderr,
  sortClipsChronologically,
  splitTranscriptIntoSentences,
  splitWordsBySilencePauses,
  validateAndFilterOverlays,
} from './analyze-core.mjs';

test('Segment FFmpeg args enforce exact A/V sync (0:v:0, 0:a:0, apad=whole_dur, matching -t) and forbid silenceremove/loudnorm/subtitles', () => {
  assert.equal(getCloudCpuPreset('1080p'), 'veryfast');
  assert.equal(getCloudCpuPreset('720p'), 'ultrafast');
  assert.equal(QUALITY_PROFILES['1080p'].crf, '21');
  assert.equal(QUALITY_PROFILES['720p'].crf, '24');

  const args1080 = buildSegmentFfmpegArgs({
    inputPath: '/tmp/clip_0.mov',
    outputPath: '/tmp/seg_000.mp4',
    cut: { clipIndex: 0, start: 2.5, end: 9.0 },
    profile: QUALITY_PROFILES['1080p'],
    framing: 'center_crop',
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: getCloudCpuPreset('1080p'),
  });

  // Exact duration D = 9.0 - 2.5 = 6.500 in BOTH input (-ss/-t before -i) and output (-t before outputPath)
  const inputIdx = args1080.indexOf('-i');
  assert.equal(args1080[args1080.indexOf('-ss') + 1], '2.500');
  assert.equal(args1080[args1080.indexOf('-t') + 1], '6.500');
  assert.ok(args1080.indexOf('-t') < inputIdx, 'Input -t must precede -i');

  const lastTIdx = args1080.lastIndexOf('-t');
  assert.ok(lastTIdx > inputIdx, 'Output -t must appear after -i');
  assert.equal(args1080[lastTIdx + 1], '6.500');

  // Filtergraph checks
  const fc1080 = args1080[args1080.indexOf('-filter_complex') + 1];
  assert.ok(fc1080.includes('[0:v:0]'), 'Must explicitly select stream 0:v:0');
  assert.ok(fc1080.includes('[0:a:0]'), 'Must explicitly select stream 0:a:0 (ignore iPhone apac)');
  assert.ok(fc1080.includes('asetpts=PTS-STARTPTS,aresample=48000'));
  assert.ok(fc1080.includes('afade=t=in:d=0.02,afade=t=out:st=6.470:d=0.03'));
  assert.ok(fc1080.includes('apad=whole_dur=6.500[a0]'));

  // Forbidden per-segment filters/flags that cause drift or double processing
  assert.ok(!fc1080.includes('silenceremove'), 'silenceremove must NEVER be in segment pass');
  assert.ok(!fc1080.includes('loudnorm'), 'loudnorm must NEVER be in segment pass');
  assert.ok(!fc1080.includes('ass='), 'subtitles must NEVER be burned in segment pass');
  assert.ok(!args1080.includes('-shortest'), 'Must not rely on -shortest; duration is exact via -t + apad');

  // Explicit stream mapping & SDR BT.709 color tags
  assert.equal(args1080[args1080.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args1080[args1080.indexOf('-preset') + 1], 'veryfast');
  assert.equal(args1080[args1080.indexOf('-crf') + 1], '21');
  assert.equal(args1080[args1080.indexOf('-colorspace') + 1], 'bt709');
  assert.equal(args1080[args1080.indexOf('-color_primaries') + 1], 'bt709');
  assert.equal(args1080[args1080.indexOf('-color_trc') + 1], 'bt709');
  assert.deepEqual(SDR_COLOR_ARGS, [
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
  ]);
  assert.ok(args1080.includes('-movflags'));
  assert.ok(args1080.includes('+faststart'));

  // 720p blur_bg profile checks
  const args720 = buildSegmentFfmpegArgs({
    inputPath: '/tmp/clip_0.mp4',
    outputPath: '/tmp/seg_000.mp4',
    cut: { clipIndex: 0, start: 0, end: 5.0 },
    profile: QUALITY_PROFILES['720p'],
    framing: 'blur_bg',
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

test('HDR -> SDR BT.709 zscale/tonemap chain is added ONLY for HLG (arib-std-b67) and PQ (smpte2084)', () => {
  const hlgChain = buildHdrToSdrFilterChain('arib-std-b67', true);
  assert.ok(hlgChain.includes('zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=203'));
  assert.ok(hlgChain.includes('tonemap=tonemap=hable:desat=0:peak=4'));
  assert.ok(hlgChain.endsWith('zscale=t=bt709:m=bt709:r=tv,format=yuv420p'));

  const pqChain = buildHdrToSdrFilterChain('smpte2084', true);
  assert.ok(pqChain.includes('zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100'));
  assert.ok(pqChain.includes('tonemap=tonemap=hable:desat=0:peak=4'));

  // SDR or unknown transfer -> empty chain
  assert.equal(buildHdrToSdrFilterChain('bt709', true), '');
  assert.equal(buildHdrToSdrFilterChain('', true), '');
  assert.equal(buildHdrToSdrFilterChain('unknown', true), '');

  // When zscale is unavailable (e.g. legacy local Windows FFmpeg build) -> empty chain
  assert.equal(buildHdrToSdrFilterChain('arib-std-b67', false), '');
  assert.equal(buildHdrToSdrFilterChain('smpte2084', false), '');

  // Verify placement BEFORE scale / split=2 inside segment filtergraph
  const argsHlgCrop = buildSegmentFfmpegArgs({
    inputPath: '/tmp/iphone_hdr.mov',
    outputPath: '/tmp/seg_000.mp4',
    cut: { clipIndex: 0, start: 1, end: 4 },
    profile: QUALITY_PROFILES['1080p'],
    framing: 'center_crop',
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: 'veryfast',
    colorTransfer: 'arib-std-b67',
    zscaleAvailable: true,
  });
  const fcHlgCrop = argsHlgCrop[argsHlgCrop.indexOf('-filter_complex') + 1];
  const zscalePos = fcHlgCrop.indexOf('zscale=tin=arib-std-b67');
  const scalePos = fcHlgCrop.indexOf('scale=1080:1920');
  assert.ok(zscalePos > -1 && scalePos > zscalePos, 'HLG tonemap must run BEFORE scale');

  const argsPqBlur = buildSegmentFfmpegArgs({
    inputPath: '/tmp/iphone_pq.mov',
    outputPath: '/tmp/seg_001.mp4',
    cut: { clipIndex: 0, start: 1, end: 4 },
    profile: QUALITY_PROFILES['1080p'],
    framing: 'blur_bg',
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: 'veryfast',
    colorTransfer: 'smpte2084',
    zscaleAvailable: true,
  });
  const fcPqBlur = argsPqBlur[argsPqBlur.indexOf('-filter_complex') + 1];
  assert.ok(
    fcPqBlur.indexOf('zscale=tin=smpte2084') < fcPqBlur.indexOf('split=2[bgsrc][fgsrc]'),
    'PQ tonemap must run BEFORE split=2 in blur_bg mode'
  );

  // SDR clip has NO zscale/tonemap in filtergraph, yet keeps SDR BT.709 color tags
  const argsSdr = buildSegmentFfmpegArgs({
    inputPath: '/tmp/sdr.mp4',
    outputPath: '/tmp/seg_002.mp4',
    cut: { clipIndex: 0, start: 0, end: 3 },
    profile: QUALITY_PROFILES['1080p'],
    framing: 'center_crop',
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: 'veryfast',
    colorTransfer: 'bt709',
    zscaleAvailable: true,
  });
  const fcSdr = argsSdr[argsSdr.indexOf('-filter_complex') + 1];
  assert.ok(!fcSdr.includes('zscale'));
  assert.ok(!fcSdr.includes('tonemap'));
  assert.equal(argsSdr[argsSdr.indexOf('-color_trc') + 1], 'bt709');
});

test('buildSubtitlesFromCutWords remaps 3 cuts across 2 clips, obeys block limits & cut boundaries, and renders styled ASS', () => {
  const cuts = [
    // Cut 0 (clip 0, 10.0 -> 14.0, duration 4.0s, cursor = 0.0)
    {
      clipIndex: 0,
      start: 10.0,
      end: 14.0,
      words: [
        // Outside cut range -> MUST be ignored
        { start: 9.2, end: 9.8, text: 'IgnorarAntes' },
        // Punctuation forces break after "mira,"
        { start: 10.1, end: 10.35, text: 'Oye' },
        { start: 10.36, end: 10.6, text: 'mira,' },
        // Next words separated by small gap (0.10s < 0.25s) -> previous block ends at 0.70
        { start: 10.7, end: 10.95, text: 'esto' },
        { start: 10.96, end: 11.2, text: 'es' },
        { start: 11.22, end: 11.55, text: 'brutal' },
        { start: 11.56, end: 11.8, text: 'de' },
        // 5th word exceeds max 4 words -> forces new block
        { start: 11.85, end: 12.2, text: 'verdad' },
        // Outside cut end -> MUST be ignored
        { start: 13.9, end: 14.3, text: 'IgnorarDespues' },
      ],
    },
    // Cut 1 (clip 1, 2.0 -> 5.0, duration 3.0s, cursor = 4.0)
    {
      clipIndex: 1,
      start: 2.0,
      end: 5.0,
      words: [
        // Must NEVER merge with Cut 0's trailing "verdad"
        { start: 2.05, end: 2.35, text: 'Cambio' },
        { start: 2.4, end: 2.9, text: 'extraordinariamente' },
        // "Cambio extraordinariamente" is 26 chars -> adding "largo" exceeds 26 chars -> forces new block
        { start: 2.95, end: 3.3, text: 'largo' },
      ],
    },
    // Cut 2 (clip 0, 20.0 -> 23.0, duration 3.0s, cursor = 7.0)
    {
      clipIndex: 0,
      start: 20.0,
      end: 23.0,
      words: [
        // Duration > 1.6s forces split between "uno" and "tarde"
        { start: 20.1, end: 20.4, text: 'Uno' },
        { start: 21.6, end: 21.95, text: 'tarde!' },
      ],
    },
  ];

  const blocks = buildSubtitlesFromCutWords(cuts);

  // Verify exact block texts (verbatim, no rewriting, no cross-cut mixing, no out-of-range words)
  assert.deepEqual(
    blocks.map((b) => b.text),
    [
      'Oye mira,',
      'esto es brutal de',
      'verdad',
      'Cambio extraordinariamente',
      'largo',
      'Uno',
      'tarde!',
    ]
  );

  // Every block satisfies <= 4 words and <= 26 chars
  for (const b of blocks) {
    assert.ok(b.text.split(/\s+/).length <= 4, `Block exceeds 4 words: ${b.text}`);
    assert.ok(b.text.length <= 26, `Block exceeds 26 chars: ${b.text}`);
  }

  // Exact timeline remapping & gap rules:
  // Block 0: "Oye mira," start=0.10, rawEnd=0.60, nextStart=0.70 (gap 0.10 < 0.25 -> end=0.70)
  assert.equal(blocks[0].start, 0.1);
  assert.equal(blocks[0].end, 0.7);
  // Block 1: "esto es brutal de" start=0.70, rawEnd=1.80, nextStart=1.85 (gap 0.05 < 0.25 -> end=1.85)
  assert.equal(blocks[1].start, 0.7);
  assert.equal(blocks[1].end, 1.85);
  // Block 2: "verdad" start=1.85, rawEnd=2.20, nextStart=4.05 (gap 1.85 >= 0.25 -> end=2.20+0.15=2.35)
  assert.equal(blocks[2].start, 1.85);
  assert.equal(blocks[2].end, 2.35);
  // Block 3 (Cut 1, cursor=4.0): "Cambio extraordinariamente" start=4.05, rawEnd=4.90, nextStart=4.95 -> end=4.95
  assert.equal(blocks[3].start, 4.05);
  assert.equal(blocks[3].end, 4.95);
  // Block 4 (Cut 1): "largo" start=4.95, rawEnd=5.30, nextStart=7.10 -> end=5.45
  assert.equal(blocks[4].start, 4.95);
  assert.equal(blocks[4].end, 5.45);
  // Block 5 (Cut 2, cursor=7.0): "Uno" start=7.10, rawEnd=7.40, nextStart=8.60 -> end=7.55
  assert.equal(blocks[5].start, 7.1);
  assert.equal(blocks[5].end, 7.55);
  // Block 6 (Cut 2, last block): "tarde!" start=8.60, rawEnd=8.95 -> end=9.10
  assert.equal(blocks[6].start, 8.6);
  assert.equal(blocks[6].end, 9.1);

  // Priority: cut.words takes precedence over legacy options.subtitlesData
  const resolvedFromWords = resolveFinalSubtitles({
    cuts,
    options: {
      subtitlesEnabled: true,
      subtitlesData: [{ start: 0, end: 2, text: 'Legacy fallback' }],
    },
  });
  assert.equal(resolvedFromWords[0].text, 'Oye mira,');

  const resolvedFallback = resolveFinalSubtitles({
    cuts: [{ clipIndex: 0, start: 0, end: 5 }],
    options: {
      subtitlesEnabled: true,
      subtitlesData: [{ start: 0.5, end: 2.0, text: 'Legacy fallback' }],
    },
  });
  assert.deepEqual(resolvedFallback, [{ start: 0.5, end: 2.0, text: 'Legacy fallback' }]);

  // ASS style @ 1080p vs 720p & yellow highlight on longest word
  const ass1080 = buildAssFileContent(blocks.slice(0, 2), 1080, 1920);
  assert.ok(ass1080.includes('Style: TikTok,DejaVu Sans,78,&H00FFFFFF,&H0000E5FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,48,48,620,1'));
  assert.ok(ass1080.includes('{\\c&H0000E5FF&}brutal{\\c&H00FFFFFF&}'));

  const ass720 = buildAssFileContent(blocks.slice(0, 1), 720, 1280);
  assert.ok(ass720.includes('Style: TikTok,DejaVu Sans,52,'));
  assert.ok(ass720.includes(',4,0,2,32,32,413,1'));
});

test('verifyRenderedDurations passes within tolerances and throws Spanish desync error on 0.5 s drift', () => {
  const okRes = verifyRenderedDurations({
    videoDurationSec: 12.04,
    audioDurationSec: 12.02,
    expectedDurationSec: 12.0,
    hasAudio: true,
  });
  assert.equal(okRes.ok, true);

  // Video drifts 0.50 s from sum(D) -> MUST fail
  assert.throws(
    () =>
      verifyRenderedDurations({
        videoDurationSec: 12.5,
        audioDurationSec: 12.5,
        expectedDurationSec: 12.0,
        hasAudio: true,
      }),
    /\[FFmpeg\] Desincronización detectada: vídeo 12\.50 s, audio 12\.50 s, esperado 12\.00 s/
  );

  // Audio drifts 0.50 s from video -> MUST fail
  assert.throws(
    () =>
      verifyRenderedDurations({
        videoDurationSec: 12.0,
        audioDurationSec: 11.5,
        expectedDurationSec: 12.0,
        hasAudio: true,
      }),
    /\[FFmpeg\] Desincronización detectada: vídeo 12\.00 s, audio 11\.50 s, esperado 12\.00 s/
  );
});

test('Final assembly pass uses -c:v copy without subtitles, burns ASS with re-encode when enabled, and applies 2-pass linear loudnorm', () => {
  const fakeStderr = `
[Parsed_loudnorm_0 @ 0x55a] 
{
  "input_i" : "-21.40",
  "input_tp" : "-3.10",
  "input_lra" : "6.80",
  "input_thresh" : "-32.10",
  "target_offset" : "0.40"
}
`;
  const measured = parseLoudnormMeasurements(fakeStderr);
  assert.deepEqual(measured, {
    input_i: '-21.40',
    input_tp: '-3.10',
    input_lra: '6.80',
    input_thresh: '-32.10',
    target_offset: '0.40',
  });

  // Without subtitles: -c:v copy + two-pass linear loudnorm + faststart
  const copyArgs = buildFinalAssemblyFfmpegArgs({
    joinedPath: '/tmp/joined.mp4',
    outputPath: '/tmp/final.mp4',
    profile: QUALITY_PROFILES['1080p'],
    encoderCodec: 'libx264',
    cpuPreset: 'veryfast',
    hasAudio: true,
    normalizeAudio: true,
    loudnormMeasurements: measured,
    subtitleAssPath: null,
  });
  assert.equal(copyArgs[copyArgs.indexOf('-c:v') + 1], 'copy');
  const afCopy = copyArgs[copyArgs.indexOf('-af') + 1];
  assert.ok(afCopy.includes('loudnorm=I=-14:TP=-1.5:LRA=11'));
  assert.ok(afCopy.includes('measured_I=-21.40:measured_TP=-3.10:measured_LRA=6.80:measured_thresh=-32.10:offset=0.40:linear=true'));
  assert.ok(copyArgs.includes('+faststart'));

  // With subtitles: burns ASS and re-encodes with SDR BT.709 color tags
  const subArgs = buildFinalAssemblyFfmpegArgs({
    joinedPath: '/tmp/joined.mp4',
    outputPath: '/tmp/final_sub.mp4',
    profile: QUALITY_PROFILES['1080p'],
    encoderCodec: 'libx264',
    cpuPreset: 'veryfast',
    hasAudio: true,
    normalizeAudio: true,
    loudnormMeasurements: measured,
    subtitleAssPath: '/tmp/final_subtitles.ass',
  });
  assert.equal(subArgs[subArgs.indexOf('-c:v') + 1], 'libx264');
  assert.ok(subArgs[subArgs.indexOf('-vf') + 1].includes("ass='/tmp/final_subtitles.ass'"));
  assert.equal(subArgs[subArgs.indexOf('-colorspace') + 1], 'bt709');
  assert.ok(subArgs.includes('+faststart'));
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

test('splitTranscriptIntoSentences divides by punctuation (., ?, !) and > 0.7 s gaps with C{clip}-F{nnn} IDs', () => {
  const transcript = {
    duration: 15.0,
    language: 'es',
    segments: [
      {
        id: 0,
        start: 0.5,
        end: 6.2,
        text: 'Hola equipo. ¿Qué tal estáis? ¡Brutal! Y ahora viene pausa larga seguimos',
        words: [
          { start: 0.5, end: 0.8, text: 'Hola' },
          { start: 0.82, end: 1.2, text: 'equipo.' },
          { start: 1.3, end: 1.55, text: '¿Qué' },
          { start: 1.56, end: 1.8, text: 'tal' },
          { start: 1.82, end: 2.25, text: 'estáis?' },
          { start: 2.4, end: 2.9, text: '¡Brutal!' },
          { start: 3.1, end: 3.3, text: 'Y' },
          { start: 3.32, end: 3.7, text: 'ahora' },
          { start: 3.72, end: 4.1, text: 'viene' },
          // Gap of 0.90 s (> 0.70 s) with NO punctuation -> forces sentence split!
          { start: 5.0, end: 5.4, text: 'pausa' },
          { start: 5.42, end: 5.8, text: 'larga' },
          { start: 5.82, end: 6.2, text: 'seguimos' },
        ],
      },
    ],
  };

  const clip1Sentences = splitTranscriptIntoSentences(transcript, 0);
  assert.deepEqual(
    clip1Sentences.map((s) => s.id),
    ['C1-F001', 'C1-F002', 'C1-F003', 'C1-F004', 'C1-F005']
  );
  assert.deepEqual(
    clip1Sentences.map((s) => s.text),
    ['Hola equipo.', '¿Qué tal estáis?', '¡Brutal!', 'Y ahora viene', 'pausa larga seguimos']
  );
  assert.equal(clip1Sentences[0].start, 0.5);
  assert.equal(clip1Sentences[0].end, 1.2);
  assert.equal(clip1Sentences[4].start, 5.0);
  assert.equal(clip1Sentences[4].end, 6.2);

  // Clip 2 numbering uses C2-F001
  const clip2Sentences = splitTranscriptIntoSentences(
    {
      duration: 4.0,
      language: 'es',
      segments: [
        {
          id: 0,
          start: 0.2,
          end: 1.5,
          text: 'Segundo clip.',
          words: [
            { start: 0.2, end: 0.8, text: 'Segundo' },
            { start: 0.85, end: 1.5, text: 'clip.' },
          ],
        },
      ],
    },
    1
  );
  assert.equal(clip2Sentences[0].id, 'C2-F001');
  assert.ok(formatSentencesForPrompt(clip2Sentences).includes('C2-F001 [0.20–1.50] "Segundo clip."'));

  // Chronological clip sorting by creationTime with originalIndex tie-breaker
  const sorted = sortClipsChronologically([
    { originalIndex: 0, creationTimeMs: Date.parse('2026-11-20T12:05:00Z') },
    { originalIndex: 1, creationTimeMs: Date.parse('2026-11-20T12:00:00Z') },
    { originalIndex: 2, creationTimeMs: null },
  ]);
  assert.deepEqual(sorted, [1, 0, 2]);
});

test('convertPlanSegmentsToCuts converts frases (-0.12/+0.25s without neighbor overlap) and recurso (1-4s clamped)', () => {
  const sentencesByClip = new Map([
    [
      0,
      [
        {
          id: 'C1-F001',
          clipIndex: 0,
          start: 1.0,
          end: 2.0,
          text: 'Primera frase.',
          words: [
            { start: 1.0, end: 1.45, text: 'Primera' },
            { start: 1.5, end: 2.0, text: 'frase.' },
          ],
        },
        {
          id: 'C1-F002',
          clipIndex: 0,
          start: 2.05,
          end: 3.5,
          text: 'Segunda frase pegada.',
          words: [
            { start: 2.05, end: 2.5, text: 'Segunda' },
            { start: 2.55, end: 3.0, text: 'frase' },
            { start: 3.02, end: 3.5, text: 'pegada.' },
          ],
        },
        {
          id: 'C1-F003',
          clipIndex: 0,
          start: 5.0,
          end: 6.5,
          text: 'Tercera frase libre.',
          words: [
            { start: 5.0, end: 5.5, text: 'Tercera' },
            { start: 5.52, end: 6.0, text: 'frase' },
            { start: 6.02, end: 6.5, text: 'libre.' },
          ],
        },
      ],
    ],
  ]);

  const result = convertPlanSegmentsToCuts({
    segmentos: [
      {
        tipo: 'frases',
        clip_index: 0,
        desde_frase: 'C1-F002',
        hasta_frase: 'C1-F002',
        funcion: 'gancho',
        motivo: 'Gancho con vecino pegado al inicio',
      },
      {
        tipo: 'recurso',
        clip_index: 0,
        desde: 10.0,
        hasta: 18.0, // 8s -> MUST clamp to max 4s (14.0)
        funcion: 'recurso',
        motivo: 'Plano recurso demasiado largo',
      },
      {
        tipo: 'recurso',
        clip_index: 0,
        desde: 19.2,
        hasta: 19.5, // 0.3s -> MUST expand to min 1s and clamp inside clip duration 20s
        funcion: 'recurso',
        motivo: 'Plano recurso muy corto cerca del final',
      },
      {
        tipo: 'frases',
        clip_index: 0,
        desde_frase: 'C1-F003',
        hasta_frase: 'C1-F003',
        funcion: 'cierre',
        motivo: 'Cierre con margen completo',
      },
    ],
    sentencesByClip,
    clipDurations: [20.0],
    silenceTrimEnabled: false,
    targetDurationSec: 10,
  });

  assert.equal(result.cortes.length, 4);

  // C1-F002 starts at 2.05; prev sentence ends at 2.0 -> clamped to 2.00 (not 1.93!)
  // Next sentence starts at 5.0 -> full +0.25s post margin (3.75)
  assert.equal(result.cortes[0].start_sec, 2.0);
  assert.equal(result.cortes[0].end_sec, 3.75);
  assert.equal(result.cortes[0].funcion, 'gancho');
  assert.equal(result.cortes[0].texto, 'Segunda frase pegada.');
  assert.equal(result.cortes[0].words.length, 3);

  // Recurso 1: clamped to 4.0 s max
  assert.equal(result.cortes[1].start_sec, 10.0);
  assert.equal(result.cortes[1].end_sec, 14.0);
  assert.equal(result.cortes[1].funcion, 'recurso');
  assert.equal(result.cortes[1].texto, '');

  // Recurso 2: expanded to at least 1.0 s while staying <= 20.0 s
  assert.equal(result.cortes[2].end_sec, 20.0);
  assert.equal(result.cortes[2].start_sec, 19.0);

  // C1-F003 has plenty of room on both sides: 5.0 - 0.12 = 4.88, 6.5 + 0.25 = 6.75
  assert.equal(result.cortes[3].start_sec, 4.88);
  assert.equal(result.cortes[3].end_sec, 6.75);
});

test('Silence sub-cuts split pauses > 0.45 s with ±0.08 s margins, discard < 0.35 s, and preserve funcion/motivo/texto/words', () => {
  const words = [
    { start: 1.0, end: 1.4, text: 'Mira' },
    { start: 1.45, end: 1.9, text: 'esto,' },
    // Pause of 0.80 s (> 0.45 s) -> splits here
    // Tiny filler word "eh" lasts only 0.10 s -> with ±0.08 s = 0.26 s (< 0.35 s) -> MUST be discarded!
    { start: 2.7, end: 2.8, text: 'eh' },
    // Another pause of 0.90 s (> 0.45 s) -> splits here
    { start: 3.7, end: 4.2, text: 'funciona' },
    { start: 4.25, end: 4.8, text: 'genial!' },
  ];

  const subPieces = splitWordsBySilencePauses({
    words,
    cutStartSec: 0.88,
    cutEndSec: 5.05,
    minBoundSec: 0,
    maxBoundSec: 10,
  });

  assert.equal(subPieces.length, 2, 'Middle 0.26 s filler sub-cut must be discarded');
  assert.equal(subPieces[0].start_sec, 0.88);
  assert.equal(subPieces[0].end_sec, 1.98); // 1.90 + 0.08
  assert.deepEqual(
    subPieces[0].words.map((w) => w.text),
    ['Mira', 'esto,']
  );
  assert.equal(subPieces[1].start_sec, 3.62); // 3.70 - 0.08
  assert.equal(subPieces[1].end_sec, 5.05);
  assert.deepEqual(
    subPieces[1].words.map((w) => w.text),
    ['funciona', 'genial!']
  );

  // Full end-to-end via convertPlanSegmentsToCuts preserves funcion, motivo, texto & words
  const sentencesByClip = new Map([
    [
      0,
      [
        {
          id: 'C1-F001',
          clipIndex: 0,
          start: 1.0,
          end: 4.8,
          text: 'Mira esto, eh funciona genial!',
          words,
        },
      ],
    ],
  ]);

  const converted = convertPlanSegmentsToCuts({
    segmentos: [
      {
        tipo: 'frases',
        clip_index: 0,
        desde_frase: 'C1-F001',
        hasta_frase: 'C1-F001',
        funcion: 'climax',
        motivo: 'Reacción principal sin pausas muertas',
      },
    ],
    sentencesByClip,
    clipDurations: [10],
    silenceTrimEnabled: true,
    targetDurationSec: 10,
  });

  assert.equal(converted.cortes.length, 2);
  assert.equal(converted.cortes[0].funcion, 'climax');
  assert.equal(converted.cortes[0].motivo, 'Reacción principal sin pausas muertas');
  assert.equal(converted.cortes[0].texto, 'Mira esto,');
  assert.equal(converted.cortes[1].funcion, 'climax');
  assert.equal(converted.cortes[1].motivo, 'Reacción principal sin pausas muertas');
  assert.equal(converted.cortes[1].texto, 'funciona genial!');
});

test('enforceTargetDuration trims lowest-scored "desarrollo" cuts first when > +15% and adds Spanish note when < -15%', () => {
  // Target 20s -> max 23s. Total below = 32s.
  const longCuts = [
    { id: 'c1', clip_index: 0, start_sec: 0, end_sec: 8, funcion: 'gancho', puntuacion_interes: 9 },
    { id: 'c2', clip_index: 0, start_sec: 8, end_sec: 16, funcion: 'desarrollo', puntuacion_interes: 5 },
    { id: 'c3', clip_index: 0, start_sec: 16, end_sec: 24, funcion: 'desarrollo', puntuacion_interes: 8 },
    { id: 'c4', clip_index: 0, start_sec: 24, end_sec: 32, funcion: 'remate', puntuacion_interes: 10 },
  ];

  const trimmed = enforceTargetDuration(longCuts, 20);
  // Must drop c2 (desarrollo score 5) first, then c3 (desarrollo score 8) to get <= 23s, keeping gancho & remate!
  assert.deepEqual(
    trimmed.cuts.map((c) => c.id),
    ['c1', 'c4']
  );
  assert.equal(trimmed.duracionTotalSec, 16);
  // 16s < 17s (20 * 0.85) -> also records informative note
  assert.ok(trimmed.notes.length >= 1);
  assert.ok(trimmed.notes[0].includes('por debajo del objetivo'));

  // Under-target case (< -15 %) keeps all cuts and adds Spanish note
  const shortCuts = [
    { id: 's1', clip_index: 0, start_sec: 0, end_sec: 5, funcion: 'gancho', puntuacion_interes: 9 },
    { id: 's2', clip_index: 0, start_sec: 5, end_sec: 10, funcion: 'cierre', puntuacion_interes: 9 },
  ];
  const under = enforceTargetDuration(shortCuts, 30);
  assert.equal(under.cuts.length, 2);
  assert.equal(under.duracionTotalSec, 10);
  assert.equal(under.notes.length, 1);
  assert.ok(under.notes[0].includes('10.0 s'));
});

test('convertPlanSegmentsToCuts validates tolerantly: discards invalid IDs, routes empty-ID recurso with valid times, discards recurso without times, and generates notes', () => {
  const sentencesByClip = new Map([
    [
      0,
      [
        {
          id: 'C1-F001',
          clipIndex: 0,
          start: 0.5,
          end: 2.5,
          text: 'Primera frase válida.',
          words: [
            { start: 0.5, end: 1.2, text: 'Primera' },
            { start: 1.25, end: 1.8, text: 'frase' },
            { start: 1.85, end: 2.5, text: 'válida.' },
          ],
        },
        {
          id: 'C1-F002',
          clipIndex: 0,
          start: 4.0,
          end: 6.0,
          text: 'Segunda frase válida.',
          words: [
            { start: 4.0, end: 4.7, text: 'Segunda' },
            { start: 4.75, end: 5.3, text: 'frase' },
            { start: 5.35, end: 6.0, text: 'válida.' },
          ],
        },
      ],
    ],
  ]);

  // Verify PHASE_B_SCHEMA documents C{clip}-F{nnn} and empty-only-for-recurso rule
  const segProps = PHASE_B_SCHEMA.properties.segmentos.items.properties;
  assert.match(segProps.desde_frase.description, /C\{clip\}-F\{nnn\}/);
  assert.match(segProps.desde_frase.description, /recurso/i);
  assert.match(segProps.hasta_frase.description, /C\{clip\}-F\{nnn\}/);
  assert.match(segProps.hasta_frase.description, /recurso/i);

  const converted = convertPlanSegmentsToCuts({
    segmentos: [
      {
        tipo: 'frases',
        desde_frase: 'C1-F001',
        hasta_frase: 'C1-F001',
        funcion: 'gancho',
        motivo: 'Gancho válido',
      },
      {
        tipo: 'frases',
        desde_frase: '',
        hasta_frase: '',
        funcion: 'desarrollo',
        motivo: 'Corte normal con ID vacío',
      },
      {
        tipo: 'frases',
        desde_frase: 'C1-F001',
        hasta_frase: 'C1-F999',
        funcion: 'desarrollo',
        motivo: 'Corte con ID inexistente',
      },
      {
        // Even if Gemini puts tipo: 'frases' with empty ID and funcion: 'recurso' + valid clip/times -> survives as recurso
        tipo: 'frases',
        desde_frase: '',
        hasta_frase: '',
        clip_index: 0,
        desde: 8.0,
        hasta: 15.0, // clamped to 4.0 s (RECURSO_MAX_SEC)
        funcion: 'recurso',
        motivo: 'Plano recurso sin ID con tiempos válidos',
      },
      {
        // Recurso without timestamps -> MUST be discarded
        tipo: 'recurso',
        desde_frase: '',
        clip_index: 0,
        funcion: 'recurso',
        motivo: 'Plano recurso sin tiempos',
      },
      {
        tipo: 'frases',
        desde_frase: 'C1-F002',
        hasta_frase: 'C1-F002',
        funcion: 'cierre',
        motivo: 'Cierre válido',
      },
    ],
    sentencesByClip,
    clipDurations: [20.0],
    silenceTrimEnabled: false,
    targetDurationSec: 20,
  });

  // Surviving cuts: C1-F001 (gancho), valid recurso (8..12s), C1-F002 (cierre)
  assert.equal(converted.cortes.length, 3);
  assert.equal(converted.cortes[0].funcion, 'gancho');
  assert.equal(converted.cortes[0].texto, 'Primera frase válida.');
  assert.equal(converted.cortes[1].funcion, 'recurso');
  assert.equal(converted.cortes[1].start_sec, 8.0);
  assert.equal(converted.cortes[1].end_sec, 12.0);
  assert.equal(converted.cortes[2].funcion, 'cierre');
  assert.equal(converted.cortes[2].texto, 'Segunda frase válida.');

  // 3 discarded out of 6 segments = 50%
  assert.equal(converted.totalSegments, 6);
  assert.equal(converted.discardedCount, 3);
  assert.equal(converted.discardRatio, 0.5);
  assert.ok(converted.invalidIds.includes(''));
  assert.ok(converted.invalidIds.includes('C1-F999'));
  assert.equal(converted.validationNotes.length, 3);
  assert.ok(converted.validationNotes.some((n) => n.includes('ID vacío')));
  assert.ok(converted.validationNotes.some((n) => n.includes('C1-F999')));
  assert.ok(converted.validationNotes.some((n) => n.includes('recurso sin clip o tiempos válidos')));
});

test('runPhaseBWithValidationRetry retries ONLY when discarded > 30% or script is empty, passes invalid IDs feedback, and throws after 2 empty attempts', async () => {
  const sentencesByClip = new Map([
    [
      0,
      [
        {
          id: 'C1-F001',
          clipIndex: 0,
          start: 0.5,
          end: 3.0,
          text: 'Frase uno.',
          words: [{ start: 0.5, end: 3.0, text: 'Frase uno.' }],
        },
        {
          id: 'C1-F002',
          clipIndex: 0,
          start: 4.0,
          end: 6.5,
          text: 'Frase dos.',
          words: [{ start: 4.0, end: 6.5, text: 'Frase dos.' }],
        },
        {
          id: 'C1-F003',
          clipIndex: 0,
          start: 7.5,
          end: 10.0,
          text: 'Frase tres.',
          words: [{ start: 7.5, end: 10.0, text: 'Frase tres.' }],
        },
      ],
    ],
  ]);

  // 1. Exactly 25% discarded (1 of 4 <= 30%) -> NO retry!
  let lowDiscardCalls = 0;
  const lowDiscardRes = await runPhaseBWithValidationRetry({
    runPhaseB: async () => {
      lowDiscardCalls += 1;
      return {
        titulo: 'Test 25%',
        segmentos: [
          { tipo: 'frases', desde_frase: 'C1-F001', hasta_frase: 'C1-F001', funcion: 'gancho', motivo: 'ok' },
          { tipo: 'frases', desde_frase: 'C1-F002', hasta_frase: 'C1-F002', funcion: 'desarrollo', motivo: 'ok' },
          { tipo: 'frases', desde_frase: 'C1-F003', hasta_frase: 'C1-F003', funcion: 'cierre', motivo: 'ok' },
          { tipo: 'frases', desde_frase: 'C1-F999', hasta_frase: 'C1-F999', funcion: 'desarrollo', motivo: 'bad' },
        ],
      };
    },
    sentencesByClip,
    clipDurations: [20],
    silenceTrimEnabled: false,
    targetDurationSec: 15,
  });
  assert.equal(lowDiscardCalls, 1, 'Must NOT retry when discarded ratio is <= 30%');
  assert.equal(lowDiscardRes.validationRetried, false);
  assert.equal(lowDiscardRes.converted.cortes.length, 3);
  assert.equal(lowDiscardRes.converted.validationNotes.length, 1);

  // 2. Exactly 30% discarded (3 of 10 = 0.30, NOT > 30%) -> NO retry!
  let boundaryCalls = 0;
  const boundaryRes = await runPhaseBWithValidationRetry({
    runPhaseB: async () => {
      boundaryCalls += 1;
      return {
        titulo: 'Test 30% exacto',
        segmentos: [
          ...Array.from({ length: 7 }, () => ({
            tipo: 'frases',
            desde_frase: 'C1-F001',
            hasta_frase: 'C1-F001',
            funcion: 'desarrollo',
            motivo: 'ok',
          })),
          ...Array.from({ length: 3 }, () => ({
            tipo: 'frases',
            desde_frase: '',
            funcion: 'desarrollo',
            motivo: 'vacío',
          })),
        ],
      };
    },
    sentencesByClip,
    clipDurations: [20],
    silenceTrimEnabled: false,
    targetDurationSec: 30,
  });
  assert.equal(boundaryCalls, 1, 'Must NOT retry at exact 30% boundary');
  assert.equal(boundaryRes.validationRetried, false);

  // 3. > 30% discarded (2 of 4 = 50%) -> retries ONCE with invalid IDs feedback
  let retryCalls = 0;
  let capturedFeedback = null;
  const retryRes = await runPhaseBWithValidationRetry({
    runPhaseB: async (feedback) => {
      retryCalls += 1;
      if (retryCalls === 1) {
        return {
          titulo: 'Intento 1',
          segmentos: [
            { tipo: 'frases', desde_frase: 'C1-F001', hasta_frase: 'C1-F001', funcion: 'gancho', motivo: 'ok' },
            { tipo: 'frases', desde_frase: '', funcion: 'desarrollo', motivo: 'vacío' },
            { tipo: 'frases', desde_frase: 'C1-F888', funcion: 'desarrollo', motivo: 'inexistente' },
            { tipo: 'recurso', clip_index: 0, desde: 12.0, hasta: 14.0, funcion: 'recurso', motivo: 'ok recurso' },
          ],
        };
      }
      capturedFeedback = feedback;
      return {
        titulo: 'Intento 2 corregido',
        segmentos: [
          { tipo: 'frases', desde_frase: 'C1-F001', hasta_frase: 'C1-F001', funcion: 'gancho', motivo: 'ok' },
          { tipo: 'frases', desde_frase: 'C1-F002', hasta_frase: 'C1-F002', funcion: 'cierre', motivo: 'ok' },
        ],
      };
    },
    sentencesByClip,
    clipDurations: [20],
    silenceTrimEnabled: false,
    targetDurationSec: 15,
  });
  assert.equal(retryCalls, 2, 'Must retry once when discarded > 30%');
  assert.equal(retryRes.validationRetried, true);
  assert.equal(retryRes.converted.cortes.length, 2);
  assert.ok(capturedFeedback, 'Retry must receive guided feedback');
  const feedbackBlob = [...capturedFeedback.problemas, ...capturedFeedback.cambios].join(' ');
  assert.ok(feedbackBlob.includes('C1-F888'), 'Feedback must include invalid phrase ID');
  assert.ok(feedbackBlob.includes('C{clip}-F{nnn}'), 'Feedback must instruct valid ID format');
  assert.ok(feedbackBlob.includes('recurso'), 'Feedback must mention recurso fallback with clip/times');

  // 4. Both attempts empty -> throws exact Spanish error with invalid count
  let failCalls = 0;
  await assert.rejects(
    () =>
      runPhaseBWithValidationRetry({
        runPhaseB: async () => {
          failCalls += 1;
          return {
            titulo: 'Todo inválido',
            segmentos: [
              { tipo: 'frases', desde_frase: '', funcion: 'gancho', motivo: 'bad 1' },
              { tipo: 'frases', desde_frase: 'C9-F999', funcion: 'cierre', motivo: 'bad 2' },
              { tipo: 'recurso', clip_index: 0, funcion: 'recurso', motivo: 'sin tiempos' },
            ],
          };
        },
        sentencesByClip,
        clipDurations: [20],
        silenceTrimEnabled: false,
        targetDurationSec: 15,
      }),
    /\[Análisis IA\] Gemini no devolvió un guion válido tras 2 intentos \(3 cortes inválidos\)\./
  );
  assert.equal(failCalls, 2);
});

test('kind: "analyze" manifests route strictly to analyze (never render), are claimed by cloud-worker, and ignored by pc-worker', () => {
  const analyzePending = {
    jobId: 'ana_001',
    kind: 'analyze',
    target: 'cloud',
    status: 'pending',
    sourceFiles: [{ name: 'clip.mov', driveFileId: 'drv123' }],
  };
  const analyzeNoTarget = {
    jobId: 'ana_002',
    kind: 'analyze',
    status: 'pending',
    sourceFiles: [{ name: 'clip.mov', driveFileId: 'drv123' }],
  };
  const analyzeDone = {
    jobId: 'ana_003',
    kind: 'analyze',
    target: 'cloud',
    status: 'analyzed',
  };
  const renderCloud = {
    jobId: 'ren_001',
    kind: 'render',
    target: 'cloud',
    status: 'pending',
  };

  assert.equal(isAnalyzeManifest(analyzePending), true);
  assert.equal(isAnalyzeManifest(renderCloud), false);

  assert.equal(getCloudJobRoute(analyzePending), 'analyze');
  assert.equal(getCloudJobRoute(analyzeNoTarget), 'analyze');
  assert.equal(getCloudJobRoute(renderCloud), 'render');

  // Cloud worker claims pending analyze jobs (with or without explicit target) and ignores analyzed ones
  assert.equal(shouldCloudWorkerClaimJob(analyzePending), true);
  assert.equal(shouldCloudWorkerClaimJob(analyzeNoTarget), true);
  assert.equal(shouldCloudWorkerClaimJob(analyzeDone), false);

  // PC worker MUST strictly ignore ALL kind === 'analyze' jobs
  assert.equal(shouldPcWorkerClaimJob(analyzePending), false);
  assert.equal(shouldPcWorkerClaimJob(analyzeNoTarget), false);
  assert.equal(shouldPcWorkerClaimJob(analyzeDone), false);

  // Safe deterministic Drive transcript cache key
  assert.equal(
    buildTranscriptCacheFilename('1AbC_dEf-123', '2026-11-22T10:30:00.000Z'),
    'transcript_1AbC_dEf-123_2026-11-22T10_30_00_000Z.json'
  );
});

test('pc-worker claims kind: "analyze" with target: "pc" while cloud-worker ignores it', () => {
  const analyzePc = {
    jobId: 'ana_pc_1',
    kind: 'analyze',
    target: 'pc',
    status: 'pending',
    sourceFiles: [{ name: 'clip.mov', driveFileId: 'drv123' }],
  };
  const analyzeCloud = {
    jobId: 'ana_cloud_1',
    kind: 'analyze',
    target: 'cloud',
    status: 'pending',
    sourceFiles: [{ name: 'clip.mov', driveFileId: 'drv123' }],
  };
  const analyzePcProcessing = {
    ...analyzePc,
    status: 'processing',
    claimedBy: 'pc',
  };

  assert.equal(shouldPcWorkerClaimJob(analyzePc), true);
  assert.equal(shouldPcWorkerClaimJob(analyzeCloud), false);
  assert.equal(shouldPcWorkerClaimJob(analyzePcProcessing), false);

  assert.equal(shouldCloudWorkerClaimJob(analyzePc), false);
  assert.equal(shouldCloudWorkerClaimJob(analyzeCloud), true);
  assert.equal(shouldCloudWorkerClaimJob(analyzePcProcessing), false);
});

test('claimJobAtomically allows strictly one winner when PC and cloud race on the same pending job', async () => {
  let sharedManifest = {
    jobId: 'race_001',
    kind: 'render',
    target: 'pc',
    status: 'pending',
    progress: 0,
  };

  // Force both workers to read the initial `pending` state before either writes,
  // then interleave writes and re-reads to simulate Drive sync race conditions.
  let readsDone = 0;
  let releaseBothReads;
  const bothReadPromise = new Promise((resolve) => {
    releaseBothReads = resolve;
  });

  let writesDone = 0;
  let releaseBothWrites;
  const bothWritePromise = new Promise((resolve) => {
    releaseBothWrites = resolve;
  });

  const makeAdapter = () => {
    let callNum = 0;
    return {
      readManifest: async () => {
        callNum += 1;
        if (callNum === 1) {
          const snapshot = { ...sharedManifest };
          readsDone += 1;
          if (readsDone === 2) releaseBothReads();
          await bothReadPromise;
          return snapshot;
        }
        // Second read happens AFTER both workers attempted to write
        await bothWritePromise;
        return { ...sharedManifest };
      },
      writeManifest: async (next) => {
        sharedManifest = { ...next };
        writesDone += 1;
        if (writesDone === 2) releaseBothWrites();
      },
    };
  };

  const [pcResult, cloudResult] = await Promise.all([
    claimJobAtomically({
      ...makeAdapter(),
      workerId: 'pc',
      nowIso: () => '2026-11-22T12:00:00.001Z',
    }),
    claimJobAtomically({
      ...makeAdapter(),
      workerId: 'cloud',
      nowIso: () => '2026-11-22T12:00:00.002Z',
    }),
  ]);

  const winners = [pcResult, cloudResult].filter((r) => r.claimed);
  const losers = [pcResult, cloudResult].filter((r) => !r.claimed);

  assert.equal(winners.length, 1, 'Strictly one worker must win the atomic claim');
  assert.equal(losers.length, 1, 'The other worker must abort cleanly');
  assert.equal(sharedManifest.status, 'processing');
  assert.equal(sharedManifest.claimedBy, winners[0].manifest.claimedBy);

  // A third worker arriving afterwards sees status: processing and immediately aborts
  const lateResult = await claimJobAtomically({
    readManifest: async () => ({ ...sharedManifest }),
    writeManifest: async () => {
      throw new Error('Must not write when job is not pending');
    },
    workerId: 'pc',
  });
  assert.equal(lateResult.claimed, false);
});

test('worker/transcribe.py falls back automatically from CUDA to CPU int8 when CUDA initialization fails', async (t) => {
  const pythonCheck = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  const pythonBin = pythonCheck.status === 0 ? 'python3' : 'python';
  const binCheck = spawnSync(pythonBin, ['--version'], { encoding: 'utf8' });
  if (binCheck.status !== 0) {
    t.skip('Python runtime not available in test environment');
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-transcribe-test-'));
  try {
    // Stub faster_whisper module where CUDA raises RuntimeError and CPU succeeds
    const stubModulePath = path.join(tmpDir, 'faster_whisper.py');
    await fs.writeFile(
      stubModulePath,
      [
        'class _Word:',
        '    def __init__(self, start, end, word):',
        '        self.start = start',
        '        self.end = end',
        '        self.word = word',
        '',
        'class _Segment:',
        '    def __init__(self):',
        '        self.start = 0.2',
        '        self.end = 1.8',
        '        self.text = "Hola desde CPU"',
        '        self.words = [_Word(0.2, 0.7, "Hola"), _Word(0.8, 1.8, "mundo")]',
        '',
        'class _Info:',
        '    language = "es"',
        '    duration = 2.0',
        '',
        'class WhisperModel:',
        '    def __init__(self, model_size, device="cpu", compute_type="int8", **kwargs):',
        '        if device == "cuda":',
        '            raise RuntimeError("CUDA driver version is insufficient")',
        '        self.device = device',
        '        self.compute_type = compute_type',
        '    def transcribe(self, input_path, **kwargs):',
        '        return ([_Segment()], _Info())',
      ].join('\n'),
      'utf8'
    );

    const dummyAudio = path.join(tmpDir, 'dummy.mp4');
    const outJson = path.join(tmpDir, 'transcript.json');
    await fs.writeFile(dummyAudio, 'dummy', 'utf8');

    const scriptPath = path.resolve(process.cwd(), 'worker', 'transcribe.py');
    const res = spawnSync(
      pythonBin,
      [scriptPath, '--in', dummyAudio, '--out', outJson, '--model', 'medium', '--device', 'auto'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: tmpDir,
        },
      }
    );

    assert.equal(res.status, 0, `transcribe.py failed: ${res.stderr}`);
    assert.ok(
      res.stderr.includes('fallback-cpu'),
      `Expected stderr to contain "fallback-cpu", got: ${res.stderr}`
    );

    const parsed = JSON.parse(await fs.readFile(outJson, 'utf8'));
    assert.equal(parsed.language, 'es');
    assert.equal(parsed.segments.length, 1);
    assert.equal(parsed.segments[0].words.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('formatSafePcLog redacts secrets/filenames and RotatingFileLogger rotates strictly within maxFiles', async () => {
  const fakeKey = 'AIzaSyD1234567890abcdefghijklmnopqrstuv';
  const fakeOAuth = 'ya29.a0AfH6SMBxFakeGoogleOAuthTokenValue1234567890';
  const fakePat = 'github_pat_11ABCDEFG0123456789_secretTokenValueXYZ987654321';

  const safeLine = formatSafePcLog('INFO', 'pc_worker_event', {
    jobId: 'job_42',
    stage: 'transcripcion',
    progress: 55,
    // Disallowed sensitive keys & raw values MUST be dropped/redacted
    token: fakeOAuth,
    apiKey: fakeKey,
    fileName: 'vacaciones_familia_privado.mp4',
    error: `Fallo con Bearer ${fakeOAuth} key=${fakeKey} pat=${fakePat} en G:\\Mi unidad\\secreto.mov`,
  });

  assert.ok(!safeLine.includes(fakeKey));
  assert.ok(!safeLine.includes(fakeOAuth));
  assert.ok(!safeLine.includes(fakePat));
  assert.ok(!safeLine.includes('vacaciones_familia_privado.mp4'));
  assert.ok(!safeLine.includes('secreto.mov'));
  assert.ok(safeLine.includes('"jobId":"job_42"'));
  assert.ok(safeLine.includes('"progress":55'));

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-logrot-'));
  try {
    const logFilePath = path.join(tmpDir, 'pc-worker.log');
    const logger = new RotatingFileLogger({
      logFilePath,
      maxBytes: 1024,
      maxFiles: 5,
      mirrorConsole: false,
    });

    for (let i = 0; i < 80; i += 1) {
      logger.write('INFO', 'heartbeat_tick_rotation_test_padding_event', {
        jobId: `job_${i}`,
        stage: 'transcripcion',
        progress: i,
      });
    }

    const files = await fs.readdir(tmpDir);
    assert.ok(files.includes('pc-worker.log'));
    assert.ok(files.includes('pc-worker.log.1'), `Expected rotation to create .1 backup, got: ${files}`);
    assert.ok(files.length <= 5, `Expected <= 5 rotated log files, got ${files.length}: ${files}`);
    assert.ok(!files.includes('pc-worker.log.5'), 'Must not exceed 5 files total (.log + .1..4)');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Voz sobre recursos: validateAndFilterOverlays enforces duration, gancho, 70% coverage, overlaps, and density rules with Spanish notes', () => {
  // Disabled mode keeps Phase B prompt identical and produces zero overlays
  assert.equal(
    buildPhaseBSystemInstruction('funny_jumpcut', false),
    buildPhaseBSystemInstruction('funny_jumpcut')
  );
  assert.ok(PHASE_B_WITH_OVERLAYS_SCHEMA.properties.overlays);
  assert.equal(PHASE_B_SCHEMA.properties.overlays, undefined);

  const cortes = [
    { id: 'cut-001', clip_index: 0, start_sec: 0, end_sec: 6.0, funcion: 'gancho', motivo: 'Hook', texto: 'Hola', words: [] },
    { id: 'cut-002', clip_index: 0, start_sec: 6.0, end_sec: 16.0, funcion: 'desarrollo', motivo: 'Body 1', texto: 'Mira el paisaje', words: [] },
    { id: 'cut-003', clip_index: 0, start_sec: 16.0, end_sec: 28.0, funcion: 'cierre', motivo: 'Body 2', texto: 'Seguimos aquí', words: [] },
  ];
  const clipDurations = [30.0, 20.0];

  // Test rule rejections in 'alta' (6 s window)
  const res = validateAndFilterOverlays({
    overlays: [
      // Rejected: gancho offset < 1.5 s
      { anchorCutId: 'cut-001', clip_index: 1, start_sec: 1.0, end_sec: 3.0, offsetSec: 0.5, motivo: 'En primeros 1.5s del gancho', encuadreX: 0.5 },
      // Valid on gancho: offsetSec = 2.0, dur = 2.5 (41.7% of 6s cut) -> ACCEPTED (timeline 2.0s)
      { id: 'ov-gancho', anchorCutId: 'cut-001', clip_index: 1, start_sec: 2.0, end_sec: 4.5, offsetSec: 2.0, motivo: 'Gancho válido', encuadreX: 0.3 },
      // Rejected: too short (< 1.5s)
      { anchorCutId: 'cut-002', clip_index: 1, start_sec: 0.0, end_sec: 1.2, offsetSec: 4.0, motivo: 'Muy corto', encuadreX: 0.5 },
      // Rejected: too long (> 5.0s)
      { anchorCutId: 'cut-002', clip_index: 1, start_sec: 0.0, end_sec: 5.5, offsetSec: 4.0, motivo: 'Muy largo', encuadreX: 0.5 },
      // Rejected: out of clip bounds (> 20s)
      { anchorCutId: 'cut-002', clip_index: 1, start_sec: 18.0, end_sec: 20.5, offsetSec: 4.0, motivo: 'Fuera de clip', encuadreX: 0.5 },
      // Valid on cut-002: timeline = 6 + 3 = 9s (>= 2 + 6s) -> ACCEPTED (2.5s)
      { id: 'ov-body1', anchorCutId: 'cut-002', clip_index: 1, start_sec: 5.0, end_sec: 7.5, offsetSec: 3.0, motivo: 'Válido desarrollo', encuadreX: 0.7 },
      // Rejected: overlaps ov-body1 (3.0..5.5 vs 4.5..6.5)
      { anchorCutId: 'cut-002', clip_index: 1, start_sec: 8.0, end_sec: 10.0, offsetSec: 4.5, motivo: 'Solapado', encuadreX: 0.5 },
      // Rejected: exceeds 70% on cut-002 (2.5 + 4.6 = 7.1 > 7.0) while fitting inside cut-002 (5.4 + 4.6 = 10.0)
      { anchorCutId: 'cut-002', clip_index: 1, start_sec: 10.0, end_sec: 14.6, offsetSec: 5.4, motivo: 'Excede 70%', encuadreX: 0.5 },
    ],
    cortes,
    clipDurations,
    brollDensity: 'alta',
    voiceoverBrollEnabled: true,
  });

  assert.deepEqual(
    res.overlays.map((o) => o.id),
    ['ov-gancho', 'ov-body1']
  );
  assert.ok(res.notas.some((n) => n.includes('gancho')));
  assert.ok(res.notas.some((n) => n.includes('duración fuera de rango')));
  assert.ok(res.notas.some((n) => n.includes('sale del clip')));
  assert.ok(res.notas.some((n) => n.includes('solaparse')));
  assert.ok(res.notas.some((n) => n.includes('70 %')));

  // Density enforcement across baja (20s), media (10s), alta (6s)
  const densityCandidates = [
    { id: 'd1', anchorCutId: 'cut-001', clip_index: 1, start_sec: 0, end_sec: 2.0, offsetSec: 2.0, motivo: 't=2s', encuadreX: 0.5 },
    { id: 'd2', anchorCutId: 'cut-002', clip_index: 1, start_sec: 3, end_sec: 5.0, offsetSec: 3.0, motivo: 't=9s (delta 7s)', encuadreX: 0.5 },
    { id: 'd3', anchorCutId: 'cut-003', clip_index: 1, start_sec: 6, end_sec: 8.0, offsetSec: 0.5, motivo: 't=16.5s (delta 7.5s from d2, 14.5s from d1)', encuadreX: 0.5 },
    { id: 'd4', anchorCutId: 'cut-003', clip_index: 1, start_sec: 9, end_sec: 11.0, offsetSec: 7.0, motivo: 't=23s (delta 21s from d1)', encuadreX: 0.5 },
  ];

  assert.deepEqual(
    validateAndFilterOverlays({ overlays: densityCandidates, cortes, clipDurations, brollDensity: 'alta' }).overlays.map((o) => o.id),
    ['d1', 'd2', 'd3', 'd4']
  );
  assert.deepEqual(
    validateAndFilterOverlays({ overlays: densityCandidates, cortes, clipDurations, brollDensity: 'media' }).overlays.map((o) => o.id),
    ['d1', 'd3']
  );
  assert.deepEqual(
    validateAndFilterOverlays({ overlays: densityCandidates, cortes, clipDurations, brollDensity: 'baja' }).overlays.map((o) => o.id),
    ['d1', 'd4']
  );

  // Disabled skips everything cleanly
  assert.deepEqual(
    validateAndFilterOverlays({ overlays: densityCandidates, cortes, clipDurations, voiceoverBrollEnabled: false }),
    { overlays: [], notas: [] }
  );

  // Mapping anchor_frase -> anchorCutId
  const mapped = mapPhaseBOverlaysToCuts({
    rawOverlays: [
      { anchor_frase: 'C1-F002', clip_index: 1, start_sec: 2.0, end_sec: 4.0, offset_sec: 1.0, motivo: 'Playa', encuadreX: 0.8 },
    ],
    cortes,
    sentencesByClip: new Map([[0, [{ id: 'C1-F002', clipIndex: 0, start: 7.0, end: 11.0, text: 'Mira el paisaje' }]]]),
  });
  assert.equal(mapped.mappedOverlays.length, 1);
  assert.equal(mapped.mappedOverlays[0].anchorCutId, 'cut-002');
  assert.equal(mapped.mappedOverlays[0].offsetSec, 2.0); // 7.0 + 1.0 - cut.start_sec (6.0)
});

test('Voz sobre recursos FFmpeg args: identical without overlays, horizontal pan + HDR->SDR, vertical, and continuous anchor audio', () => {
  const baseParams = {
    inputPath: '/tmp/anchor.mov',
    outputPath: '/tmp/seg_000.mp4',
    cut: { clipIndex: 0, start: 4.0, end: 10.0 },
    profile: QUALITY_PROFILES['1080p'],
    framing: 'center_crop',
    audioMode: 'source',
    encoderCodec: 'libx264',
    cpuPreset: 'veryfast',
  };

  // 1. Without overlays: identical args whether overlays omitted or empty []
  const argsBaseline = buildSegmentFfmpegArgs(baseParams);
  const argsEmptyOverlays = buildSegmentFfmpegArgs({
    ...baseParams,
    overlays: [],
    brollSmoothPan: true,
    brollAmbientAudio: true,
  });
  assert.deepEqual(argsEmptyOverlays, argsBaseline);

  // 2. Horizontal B-roll overlay (with HDR HLG + encuadreX + 8% smooth pan, default muted ambient, uncut anchor audio)
  const argsHorizPan = buildSegmentFfmpegArgs({
    ...baseParams,
    overlays: [
      {
        inputPath: '/tmp/broll_landscape.mov',
        start: 1.0,
        end: 3.5,
        offsetSec: 2.0,
        encuadreX: 0.7,
        colorTransfer: 'arib-std-b67',
        isLandscape: true,
        hasAudio: true,
      },
    ],
    brollSmoothPan: true,
    brollAmbientAudio: false,
  });

  const fcHoriz = argsHorizPan[argsHorizPan.indexOf('-filter_complex') + 1];
  assert.ok(argsHorizPan.includes('/tmp/broll_landscape.mov'));
  assert.ok(fcHoriz.includes('zscale=tin=arib-std-b67'), 'B-roll HDR->SDR must apply to landscape overlay');
  assert.ok(fcHoriz.includes('[1:v:0]setpts=PTS-STARTPTS'), 'B-roll video stream must start at PTS=0');
  assert.ok(fcHoriz.includes('scale=-2:1920,crop=1080:1920:'), 'Landscape B-roll must scale height to 1920 and crop 1080 width');
  assert.ok(fcHoriz.includes('0.6600+0.0800*min(1,t/2.500)'), 'Smooth pan must shift crop by 8% centered on encuadreX=0.7');
  assert.ok(fcHoriz.includes('[segv_0][segv_1][segv_2]concat=n=3:v=1:a=0[v0]'), 'Anchor -> B-roll -> Anchor subsegments must concatenate visually');
  // Continuous uncut anchor audio without B-roll mix
  assert.ok(fcHoriz.includes('[0:a:0]asetpts=PTS-STARTPTS,aresample=48000'));
  assert.ok(fcHoriz.includes('apad=whole_dur=6.000[a0]'));
  assert.ok(!fcHoriz.includes('volume=-20dB'), 'Ambient audio must stay muted by default');
  assert.ok(!fcHoriz.includes('amix='), 'No amix when ambient audio is OFF');

  // Landscape without smooth pan -> static crop at encuadreX
  const argsHorizStatic = buildSegmentFfmpegArgs({
    ...baseParams,
    overlays: [
      {
        inputPath: '/tmp/broll_landscape.mov',
        start: 1.0,
        end: 3.5,
        offsetSec: 2.0,
        encuadreX: 0.25,
        isLandscape: true,
      },
    ],
    brollSmoothPan: false,
    brollAmbientAudio: false,
  });
  const fcStatic = argsHorizStatic[argsHorizStatic.indexOf('-filter_complex') + 1];
  assert.ok(fcStatic.includes('(iw-ow)*0.2500'));
  assert.ok(!fcStatic.includes('0.0800*min(1'));

  // 3. Vertical B-roll overlay with ambient audio ON (-20 dB) + continuous uncut anchor voice
  const argsVertAmbient = buildSegmentFfmpegArgs({
    ...baseParams,
    overlays: [
      {
        inputPath: '/tmp/broll_vertical.mp4',
        start: 0.5,
        end: 3.0,
        offsetSec: 1.5,
        encuadreX: 0.5,
        isLandscape: false,
        hasAudio: true,
      },
    ],
    brollSmoothPan: true,
    brollAmbientAudio: true,
  });
  const fcVert = argsVertAmbient[argsVertAmbient.indexOf('-filter_complex') + 1];
  assert.ok(fcVert.includes('[1:v:0]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'));
  assert.ok(fcVert.includes('[0:a:0]asetpts=PTS-STARTPTS'), 'Anchor voice remains continuous');
  assert.ok(fcVert.includes('[1:a:0]atrim=duration=2.500'), 'B-roll ambient trimmed to overlay duration');
  assert.ok(fcVert.includes('volume=-20dB,adelay=1500|1500[a_amb_0]'), 'Ambient audio mixed at -20 dB and delayed to offsetSec');
  assert.ok(fcVert.includes('[a_anchor][a_amb_0]amix=inputs=2:duration=first:normalize=0,apad=whole_dur=6.000[a0]'));
});




// ---------------------------------------------------------------------------
// PC local: DLL de CUDA, carpeta de trabajo, limpieza y almacenamiento
// ---------------------------------------------------------------------------

function findPythonBin() {
  for (const candidate of ['python3', 'python']) {
    const check = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (check.status === 0) return candidate;
  }
  return null;
}

async function writeFileOfSize(filePath, bytes = 1024) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(bytes, 1));
}

async function setAgeHours(target, hours) {
  const when = new Date(Date.now() - hours * 3600 * 1000);
  await fs.utimes(target, when, when);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const MB = 1024 * 1024;

test('transcribe.py registra site-packages/nvidia/*/bin con os.add_dll_directory y PATH al simular win32 (y no hace nada en otras plataformas)', async (t) => {
  const pythonBin = findPythonBin();
  if (!pythonBin) {
    t.skip('Python runtime not available in test environment');
    return;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-dll-test-'));
  try {
    const nvidiaRoot = path.join(tmpDir, 'site-packages', 'nvidia');
    await fs.mkdir(path.join(nvidiaRoot, 'cublas', 'bin'), { recursive: true });
    await fs.mkdir(path.join(nvidiaRoot, 'cudnn', 'bin'), { recursive: true });
    await fs.mkdir(path.join(nvidiaRoot, 'cuda_runtime', 'include'), { recursive: true });

    const workerDir = path.resolve(process.cwd(), 'worker');
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(workerDir)})`,
      'import transcribe',
      'class Spec:',
      `    submodule_search_locations = [${JSON.stringify(nvidiaRoot)}]`,
      'calls = []',
      'env = {"PATH": "base"}',
      'win = transcribe.register_cuda_dll_dirs(platform="win32", find_spec=lambda name: Spec() if name == "nvidia" else None, add_dll_directory=calls.append, environ=env)',
      'env2 = {"PATH": "base"}',
      'lin = transcribe.register_cuda_dll_dirs(platform="linux", find_spec=lambda name: Spec(), add_dll_directory=calls.append, environ=env2)',
      'none = transcribe.register_cuda_dll_dirs(platform="win32", find_spec=lambda name: None, add_dll_directory=calls.append, environ={"PATH": "x"})',
      'print(json.dumps({"win": win, "calls": calls, "path": env["PATH"], "lin": lin, "path2": env2["PATH"], "none": none}))',
    ].join('\n');

    const res = spawnSync(pythonBin, ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, `python failed: ${res.stderr}`);
    const out = JSON.parse(res.stdout.trim());

    const expected = [path.join(nvidiaRoot, 'cublas', 'bin'), path.join(nvidiaRoot, 'cudnn', 'bin')];
    assert.deepEqual(out.win, expected);
    assert.deepEqual(out.calls, expected);
    assert.ok(out.path.startsWith(expected.join(path.delimiter)), `PATH: ${out.path}`);
    assert.ok(out.path.endsWith('base'));
    assert.deepEqual(out.lin, []);
    assert.equal(out.path2, 'base');
    assert.deepEqual(out.none, []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('transcribe.py escribe "whisper-device: cuda/float16" cuando CUDA carga y el filtro no cuenta el aviso de Hugging Face como error', async (t) => {
  const pythonBin = findPythonBin();
  if (!pythonBin) {
    t.skip('Python runtime not available in test environment');
    return;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-device-test-'));
  try {
    await fs.writeFile(
      path.join(tmpDir, 'faster_whisper.py'),
      [
        'class _Info:',
        '    language = "es"',
        '    duration = 1.0',
        'class WhisperModel:',
        '    def __init__(self, model_size, device="cpu", compute_type="int8", **kwargs):',
        '        self.device = device',
        '    def transcribe(self, input_path, **kwargs):',
        '        return ([], _Info())',
      ].join('\n'),
      'utf8'
    );
    const dummyAudio = path.join(tmpDir, 'dummy.wav');
    const outJson = path.join(tmpDir, 'out.json');
    await fs.writeFile(dummyAudio, 'dummy', 'utf8');

    const res = spawnSync(
      pythonBin,
      [path.resolve(process.cwd(), 'worker', 'transcribe.py'), '--in', dummyAudio, '--out', outJson, '--device', 'auto'],
      { encoding: 'utf8', env: { ...process.env, PYTHONPATH: tmpDir } }
    );
    assert.equal(res.status, 0, `transcribe.py failed: ${res.stderr}`);
    assert.match(res.stderr, /whisper-device: cuda\/float16/);
    assert.ok(!res.stderr.includes('fallback-cpu'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  assert.deepEqual(parseWhisperDeviceLine('x\nwhisper-device: cpu/int8\n'), { device: 'cpu', computeType: 'int8' });
  assert.deepEqual(parseWhisperDeviceLine('whisper-device: cuda/float16'), { device: 'cuda', computeType: 'float16' });
  assert.equal(parseWhisperDeviceLine('sin linea'), null);

  const noisy = [
    'Warning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN to enable higher rate limits.',
    'whisper-device: cpu/int8',
    'Traceback: boom real',
  ].join('\n');
  assert.equal(stripBenignWhisperStderr(noisy), 'Traceback: boom real');
});

test('AUTOCUT_WORK_DIR: se crea si no existe, aloja las carpetas temporales y HF_HOME llega a transcribe.py', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-workdir-test-'));
  try {
    const configured = path.join(base, 'no', 'existe', 'aun');
    const cfg = getWorkDirConfig({ AUTOCUT_WORK_DIR: configured });
    assert.equal(cfg.workDir, path.resolve(configured));
    assert.equal(cfg.dedicated, true);

    const fallback = getWorkDirConfig({});
    assert.equal(fallback.workDir, os.tmpdir());
    assert.equal(fallback.dedicated, false);

    assert.equal(await pathExists(configured), false);
    const tempDir = await createTempWorkDir({ workDir: cfg.workDir, prefix: 'autocut_job_abc_' });
    assert.equal(path.dirname(tempDir), path.resolve(configured));
    assert.ok(path.basename(tempDir).startsWith('autocut_job_abc_'));
    assert.equal(await pathExists(tempDir), true);
    await releaseTempWorkDir(tempDir);
    assert.equal(await pathExists(tempDir), false);

    const cli = parseCliArgs([], { AUTOCUT_WORK_DIR: configured, HF_HOME: 'E:\\cache\\hf', AUTOCUT_DRIVE_DIR: 'G:\\x' });
    assert.equal(cli.workDir, configured);
    assert.equal(cli.hfHome, 'E:\\cache\\hf');
    assert.equal(buildWhisperEnv({ HF_HOME: 'E:\\cache\\hf', OTRA: '1' }).HF_HOME, 'E:\\cache\\hf');
    assert.equal(buildWhisperEnv({ OTRA: '1' }).OTRA, '1');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('Limpieza automática: borra autocut_* con más de 24 h salvo jobs en curso y no toca otras carpetas', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-stale-test-'));
  try {
    const old = path.join(workDir, 'autocut_job_old_1');
    const recent = path.join(workDir, 'autocut_job_recent_2');
    const foreign = path.join(workDir, 'otra_carpeta_vieja');
    for (const dir of [old, recent, foreign]) {
      await writeFileOfSize(path.join(dir, 'f.bin'), MB);
    }
    const active = await createTempWorkDir({ workDir, prefix: 'autocut_pc_analyze_run_' });
    await writeFileOfSize(path.join(active, 'f.bin'), MB);

    await setAgeHours(old, 30);
    await setAgeHours(foreign, 30);
    await setAgeHours(active, 48); // en curso pero muy antigua: no se toca

    const res = await cleanupStaleTempDirs({ workDir });
    assert.equal(res.removed, 1);
    assert.equal(Math.round(res.bytes / MB), 1);
    assert.equal(await pathExists(old), false);
    assert.equal(await pathExists(recent), true);
    assert.equal(await pathExists(foreign), true);
    assert.equal(await pathExists(active), true);

    await releaseTempWorkDir(active);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

async function buildDriveFixture() {
  const driveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-drive-test-'));
  const jobsDir = path.join(driveDir, '_AutoCut_Jobs');
  const outputDir = path.join(driveDir, '_AutoCut_Output');
  await fs.mkdir(jobsDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const raw = (name) => writeFileOfSize(path.join(driveDir, name), MB);
  const out = (name) => writeFileOfSize(path.join(outputDir, name), 2048);
  const job = (file, manifest) =>
    fs.writeFile(path.join(jobsDir, file), JSON.stringify(manifest), 'utf8');
  const daysAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

  // Editados por job completado (fuente principal)
  await raw('a.mp4');
  await out('a_EDITADO_X.mp4');
  await job('job_a.json', {
    jobId: 'a', status: 'completed', updatedAt: daysAgo(10),
    outputFileName: 'a_EDITADO_X.mp4', sourceFiles: [{ name: 'a.mp4' }],
  });
  // Multi-Clip: un MP4 sale de dos brutos
  await raw('m1.mov');
  await raw('m2.mov');
  await out('proy_COMBINADO_EDITADO_Z.mp4');
  await job('job_multi.json', {
    jobId: 'multi', status: 'completed', updatedAt: daysAgo(1),
    outputFileName: 'proy_COMBINADO_EDITADO_Z.mp4',
    sourceFiles: [{ name: 'm1.mov' }, { name: 'm2.mov' }],
  });
  // Respaldo: regla de la PWA (sin job)
  await raw('c.mp4');
  await out('c_EDITADO_Y.mp4');
  // Job completado pero MP4 final ausente: se conserva
  await raw('b.mp4');
  await job('job_b.json', {
    jobId: 'b', status: 'completed', updatedAt: daysAgo(10),
    outputFileName: 'b_EDITADO_X.mp4', sourceFiles: [{ name: 'b.mp4' }],
  });
  // Sin nada: se conserva
  await raw('d.mp4');
  // Con MP4 final pero citado por un job pendiente: se conserva
  await raw('e.mp4');
  await out('e_EDITADO_X.mp4');
  await job('job_e_pending.json', {
    jobId: 'e', status: 'pending', createdAt: daysAgo(10), sourceFiles: [{ name: 'e.mp4' }],
  });
  // Ambiguo: mismo nombre base con dos extensiones y sin job
  await raw('dup.mp4');
  await raw('dup.mov');
  await out('dup_EDITADO_X.mp4');
  // Fuera de la carpeta raíz: no se toca nunca
  await writeFileOfSize(path.join(driveDir, 'sub', 'f.mp4'), MB);
  await out('f_EDITADO_X.mp4');

  // Manifiestos para jobs_terminados
  await job('analyze_old.json', { jobId: 'o', kind: 'analyze', status: 'analyzed', updatedAt: daysAgo(9), sourceFiles: [] });
  await job('analyze_err.json', { jobId: 'r', kind: 'analyze', status: 'error', updatedAt: daysAgo(30), sourceFiles: [] });
  await job('analyze_recent.json', { jobId: 'n', kind: 'analyze', status: 'analyzed', updatedAt: daysAgo(2), sourceFiles: [] });
  await job('job_old_pending.json', { jobId: 'p', status: 'pending', updatedAt: daysAgo(40), sourceFiles: [{ name: 'zzz.mp4' }] });

  return { driveDir, jobsDir, outputDir };
}

test('brutos_editados solo borra brutos de la raíz con MP4 final (job completado, Multi-Clip o regla PWA) y preview no borra nada', async () => {
  const { driveDir } = await buildDriveFixture();
  try {
    const shouldDelete = ['a.mp4', 'm1.mov', 'm2.mov', 'c.mp4'];
    const shouldKeep = ['b.mp4', 'd.mp4', 'e.mp4', 'dup.mp4', 'dup.mov', path.join('sub', 'f.mp4')];

    const preview = await executeCleanupScopes({
      scopes: ['preview_brutos_editados'],
      driveDir, workDir: path.join(driveDir, 'no-usada'), dedicated: true,
    });
    assert.equal(preview.status, 'done');
    assert.equal(preview.liberadoMB, 0);
    assert.deepEqual(preview.detalle.preview_brutos_editados, { archivos: 4, mb: 4 });
    for (const name of [...shouldDelete, ...shouldKeep]) {
      assert.equal(await pathExists(path.join(driveDir, name)), true, `preview no debe borrar ${name}`);
    }

    const real = await cleanEditedRawVideos({ driveDir });
    assert.equal(real.archivos, 4);
    for (const name of shouldDelete) {
      assert.equal(await pathExists(path.join(driveDir, name)), false, `${name} debía borrarse`);
    }
    for (const name of shouldKeep) {
      assert.equal(await pathExists(path.join(driveDir, name)), true, `${name} debía conservarse`);
    }
    const outputs = await fs.readdir(path.join(driveDir, '_AutoCut_Output'));
    assert.equal(outputs.length, 6);
  } finally {
    await fs.rm(driveDir, { recursive: true, force: true });
  }
});

test('jobs_terminados borra manifiestos completed/analyzed/error con más de 7 días; con ambos scopes brutos_editados corre antes', async () => {
  const { driveDir, jobsDir } = await buildDriveFixture();
  try {
    const res = await executeCleanupScopes({
      scopes: ['jobs_terminados', 'brutos_editados'], // orden invertido a propósito
      driveDir, workDir: path.join(driveDir, 'no-usada'), dedicated: true,
    });
    assert.equal(res.status, 'done');
    // Se borraron los brutos (necesitaban los job_*.json) y también los manifiestos viejos
    assert.equal(res.detalle.brutos_editados.archivos, 4);
    assert.equal(await pathExists(path.join(driveDir, 'a.mp4')), false);
    assert.equal(await pathExists(path.join(driveDir, 'm1.mov')), false);

    assert.equal(res.detalle.jobs_terminados.archivos, 4); // job_a, job_b, analyze_old, analyze_err
    assert.equal(await pathExists(path.join(jobsDir, 'job_a.json')), false);
    assert.equal(await pathExists(path.join(jobsDir, 'job_b.json')), false);
    assert.equal(await pathExists(path.join(jobsDir, 'analyze_old.json')), false);
    assert.equal(await pathExists(path.join(jobsDir, 'analyze_err.json')), false);
    assert.equal(await pathExists(path.join(jobsDir, 'job_multi.json')), true); // 1 día
    assert.equal(await pathExists(path.join(jobsDir, 'analyze_recent.json')), true); // 2 días
    assert.equal(await pathExists(path.join(jobsDir, 'job_old_pending.json')), true); // no terminado
    assert.equal(await pathExists(path.join(jobsDir, 'job_e_pending.json')), true);
    assert.ok(res.liberadoMB >= 4);
  } finally {
    await fs.rm(driveDir, { recursive: true, force: true });
  }
});

test('temp_pc vacía la carpeta de trabajo salvo el job en curso; sin carpeta dedicada solo toca autocut_*; rechaza solaparse con Drive', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-temp-pc-test-'));
  const driveDir = path.join(base, 'drive');
  await fs.mkdir(driveDir, { recursive: true });
  try {
    const workDir = path.join(base, 'work');
    await writeFileOfSize(path.join(workDir, 'autocut_job_x_1', 'a.bin'), MB);
    await writeFileOfSize(path.join(workDir, 'suelto.tmp'), MB);
    const active = await createTempWorkDir({ workDir, prefix: 'autocut_job_live_' });
    await writeFileOfSize(path.join(active, 'seg.mp4'), MB);

    const res = await executeCleanupScopes({ scopes: ['temp_pc'], driveDir, workDir, dedicated: true });
    assert.equal(res.status, 'done');
    assert.equal(res.detalle.temp_pc.archivos, 2);
    assert.equal(res.detalle.temp_pc.mb, 2);
    assert.equal(await pathExists(path.join(active, 'seg.mp4')), true);
    assert.equal(await pathExists(path.join(workDir, 'suelto.tmp')), false);
    assert.equal(await pathExists(path.join(workDir, 'autocut_job_x_1')), false);
    await releaseTempWorkDir(active);

    // Carpeta no dedicada (equivale a os.tmpdir()): solo autocut_*
    const shared = path.join(base, 'shared');
    await writeFileOfSize(path.join(shared, 'autocut_job_y_1', 'a.bin'), 1024);
    await writeFileOfSize(path.join(shared, 'documento_ajeno.txt'), 1024);
    const soft = await emptyWorkDir({ workDir: shared, dedicated: false, driveDir });
    assert.equal(soft.archivos, 1);
    assert.equal(await pathExists(path.join(shared, 'documento_ajeno.txt')), true);

    // Solapamiento con la carpeta de Drive: rechazado, no se borra nada
    await writeFileOfSize(path.join(driveDir, 'bruto.mp4'), 1024);
    const bad = await executeCleanupScopes({ scopes: ['temp_pc'], driveDir, workDir: driveDir, dedicated: true });
    assert.equal(bad.status, 'error');
    assert.ok(bad.detalle.temp_pc.error);
    assert.equal(await pathExists(path.join(driveDir, 'bruto.mp4')), true);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('cleanup_<id>.json: el worker reescribe el mismo archivo con status done/error, liberadoMB, detalle y finishedAt', async () => {
  const { driveDir, jobsDir } = await buildDriveFixture();
  try {
    const commandsDir = path.join(jobsDir, '_commands');
    await fs.mkdir(commandsDir, { recursive: true });
    const ctx = { driveDir, workDir: path.join(driveDir, 'no-usada'), dedicated: true };

    const previewFile = path.join(commandsDir, 'cleanup_p1.json');
    // Con BOM a propósito: PowerShell 5.1 lo añade al escribir JSON en UTF-8
    const bom = String.fromCharCode(0xfeff);
    await fs.writeFile(previewFile, bom + JSON.stringify({ scopes: ['preview_brutos_editados'], createdAt: new Date().toISOString(), status: 'pending' }), 'utf8');
    const done = await processCleanupCommandFile(previewFile, ctx);
    const saved = JSON.parse(await fs.readFile(previewFile, 'utf8'));
    assert.equal(done.status, 'done');
    assert.equal(saved.status, 'done');
    assert.equal(saved.liberadoMB, 0);
    assert.equal(saved.detalle.preview_brutos_editados.archivos, 4);
    assert.deepEqual(saved.scopes, ['preview_brutos_editados']);
    assert.ok(Date.parse(saved.finishedAt) > 0);
    assert.equal(await pathExists(path.join(driveDir, 'a.mp4')), true);

    // Ya no está pendiente: no se vuelve a ejecutar
    assert.equal(await processCleanupCommandFile(previewFile, ctx), null);

    const badFile = path.join(commandsDir, 'cleanup_p2.json');
    await fs.writeFile(
      badFile,
      JSON.stringify({ scopes: ['borrar_todo'], createdAt: new Date().toISOString(), status: 'pending' }),
      'utf8'
    );
    await processCleanupCommandFile(badFile, ctx);
    const savedBad = JSON.parse(await fs.readFile(badFile, 'utf8'));
    assert.equal(savedBad.status, 'error');
    assert.deepEqual(savedBad.detalle.scopes_desconocidos, ['borrar_todo']);
    assert.equal(await pathExists(path.join(driveDir, 'd.mp4')), true);
  } finally {
    await fs.rm(driveDir, { recursive: true, force: true });
  }
});

test('Latido: writeWorkerHeartbeat incluye storage { workDirMB, hfCacheMB, freeGB } y collectStorageInfo mide carpetas reales', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'autocut-storage-test-'));
  try {
    const workDir = path.join(base, 'work');
    const hfHome = path.join(base, 'hf');
    await writeFileOfSize(path.join(workDir, 'autocut_job_1', 'a.bin'), 2 * MB);
    await writeFileOfSize(path.join(hfHome, 'hub', 'modelo.bin'), 3 * MB);

    const storage = await collectStorageInfo({ workDir, dedicated: true, hfHome });
    assert.equal(storage.workDirMB, 2);
    assert.equal(storage.hfCacheMB, 3);
    assert.equal(typeof storage.freeGB, 'number');
    assert.ok(storage.freeGB > 0);

    const payload = await writeWorkerHeartbeat({
      jobsDir: base, encoder: 'libx264', whisperDevice: 'cuda', whisperModel: 'medium', busy: false, storage,
    });
    const onDisk = JSON.parse(await fs.readFile(path.join(base, '_worker_status.json'), 'utf8'));
    assert.deepEqual(onDisk.storage, storage);
    assert.equal(onDisk.whisperDevice, 'cuda');
    assert.deepEqual(payload.storage, storage);

    const sin = await writeWorkerHeartbeat({ jobsDir: base, encoder: 'libx264', busy: false });
    assert.equal('storage' in sin, false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

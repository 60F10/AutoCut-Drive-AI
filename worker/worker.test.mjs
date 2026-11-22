import test from 'node:test';
import assert from 'node:assert/strict';
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
import { shouldPcWorkerClaimJob } from './pc-worker.mjs';
import {
  RESUMABLE_CHUNK_BYTES,
  formatSafeCloudLog,
  parseCloudCliArgs,
  shouldCloudWorkerClaimJob,
} from './cloud-worker.mjs';

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

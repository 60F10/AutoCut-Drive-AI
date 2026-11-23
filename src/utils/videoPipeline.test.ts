import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SUBTITLE_STYLES,
  DEFAULT_SUBTITLE_STYLE_ID,
  duplicateSubtitleStyleProfile,
  hexToAssColor,
  isBuiltInSubtitleStyleId,
  mergeSubtitleStyleProfiles,
} from './subtitleStyles';
import {
  AI_FRAME_JPEG_QUALITY,
  AI_FRAME_MAX_COUNT,
  AI_FRAME_MIN_COUNT,
  AI_FRAME_TARGET_WIDTH,
  AI_MAX_JSON_PAYLOAD_BYTES,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_TIKTOK_OPTIONS,
  DEFAULT_WHISPER_MODEL,
  EDIT_STYLE_PRESETS,
  MOBILE_MULTICLIP_SAFE_CLIP_LIMIT,
  MOBILE_RAM_WARNING_BYTES,
  PC_RENDER_RECOMMENDED_BYTES,
  RECOMMENDED_GEMINI_MODELS,
  buildAnalyzeJobManifest,
  buildAssSubtitles,
  buildCombinedEditedFilename,
  buildConcatCopyFfmpegArgs,
  buildConcatListContent,
  buildEditedFilename,
  buildFfmpegFilterComplex,
  buildGeminiSystemPrompt,
  buildMultiClipFfmpegFilterComplex,
  buildRenderJobManifest,
  buildSingleSegmentFfmpegArgs,
  buildSrtSubtitles,
  calculateSelectedDuration,
  cloudEditPlanToGeminiEditPlan,
  computeFrameTimestamps,
  computeQueueAnalytics,
  computeScaledDimensions,
  detectDefaultExportQuality,
  detectPendingVideos,
  enforceAiPayloadBudget,
  evaluateHeavyVideoWarning,
  evaluateMultiClipMobileRamProtection,
  exceedsMobileRamThreshold,
  extractDriveFolderId,
  filterEditedCuts,
  formatAnalyzeStageLabel,
  formatBytes,
  formatDurationHuman,
  formatPcJobStatusLabel,
  formatPhaseError,
  formatSeconds,
  getDefaultTargetDurationForPreset,
  isMobileViewportOrUserAgent,
  mergeMultiClipEditPlans,
  normalizeStylePreset,
  normalizeTikTokOptions,
  normalizeWhisperModel,
  parseGeminiEditPlan,
  parseHumanReadableApiError,
  planSequentialMultiClipJobs,
  remapSubtitlesToFinalTimeline,
  sanitizeEtiqueta,
  sanitizeGeminiModelName,
  shouldRecommendPcRender,
  toLocalDateKey,
  type ExtractedVideoFrame,
} from './videoPipeline';
import {
  DEBUG_LOGS_STORAGE_KEY,
  MAX_DEBUG_LOG_ENTRIES,
  MAX_PERSISTED_DEBUG_LOG_ENTRIES,
  NEW_SESSION_SEPARATOR,
  buildDiagnosticReport,
  clearDebugLogs,
  getDebugLogStats,
  getDebugLogs,
  hydrateDebugLogsFromStorage,
  logError,
  logInfo,
  sanitizeLogString,
} from '../services/debugLogger';
import { FFMPEG_ASSET_MIME_TYPES, FFMPEG_CORE_SOURCES } from '../services/ffmpegService';
import type { AnalyticsRecord, DriveFileMeta, SubtitleBlock, VideoCut } from '../types';

test('extractDriveFolderId parses raw IDs and full Google Drive URLs', () => {
  assert.equal(
    extractDriveFolderId('https://drive.google.com/drive/folders/1A2B3C4D5E6F7G8H9I0J?usp=sharing'),
    '1A2B3C4D5E6F7G8H9I0J'
  );
  assert.equal(
    extractDriveFolderId('https://drive.google.com/drive/u/0/folders/abc_DEF-123456'),
    'abc_DEF-123456'
  );
  assert.equal(
    extractDriveFolderId('  1A2B3C4D5E6F7G8H9I0J  '),
    '1A2B3C4D5E6F7G8H9I0J'
  );
  assert.equal(extractDriveFolderId(''), '');
});

test('sanitizeEtiqueta returns one accent-free uppercase keyword', () => {
  assert.equal(sanitizeEtiqueta('cocína rápida!'), 'COCINA');
  assert.equal(sanitizeEtiqueta('  vídeo_fail  '), 'VIDEO');
  assert.equal(sanitizeEtiqueta('Receta'), 'RECETA');
  assert.equal(sanitizeEtiqueta('   '), 'VIDEO');
});

test('buildEditedFilename and buildCombinedEditedFilename follow exact naming conventions', () => {
  assert.equal(
    buildEditedFilename('IMG_4821.MOV', 'batido'),
    'IMG_4821_EDITADO_BATIDO.mp4'
  );
  assert.equal(
    buildEditedFilename('mi.video.cocina.mp4', 'recéta'),
    'mi.video.cocina_EDITADO_RECETA.mp4'
  );
  assert.equal(
    buildCombinedEditedFilename('Escapada Asturias', 'viáje'),
    'Escapada_Asturias_COMBINADO_EDITADO_VIAJE.mp4'
  );
  assert.equal(
    buildCombinedEditedFilename('IMG_1001.MOV', 'vlog'),
    'IMG_1001_COMBINADO_EDITADO_VLOG.mp4'
  );
});

test('detectPendingVideos skips already edited files and prevents infinite loops', () => {
  const files: DriveFileMeta[] = [
    { id: '1', name: 'batido_platano.MOV', mimeType: 'video/quicktime' },
    { id: '2', name: 'batido_platano_EDITADO_COCINA.mp4', mimeType: 'video/mp4' },
    { id: '3', name: 'vlog_coche.mp4', mimeType: 'video/mp4' },
    { id: '4', name: 'prueba_clip.webm', mimeType: 'video/webm' },
    { id: '5', name: 'notas.txt', mimeType: 'text/plain' },
    { id: '6', name: 'foto.jpg', mimeType: 'image/jpeg' },
  ];

  const result = detectPendingVideos(files);

  assert.deepEqual(
    result.pending.map((f) => f.name),
    ['vlog_coche.mp4', 'prueba_clip.webm']
  );
  assert.deepEqual(
    result.alreadyEditedSources.map((f) => f.name),
    ['batido_platano.MOV']
  );
  assert.deepEqual(
    result.editedOutputs.map((f) => f.name),
    ['batido_platano_EDITADO_COCINA.mp4']
  );
});

test('buildFfmpegFilterComplex supports 720p mobile_fast ultrafast and 1080p high_1080p profiles', () => {
  const cuts: VideoCut[] = [
    { id: 'c1', clip_index: 0, start_sec: 0.5, end_sec: 4.2, motivo: 'Gancho', enabled: true },
    { id: 'c2', clip_index: 0, start_sec: 10.0, end_sec: 15.0, motivo: 'Silencio descartado', enabled: false },
    { id: 'c3', clip_index: 0, start_sec: 18.25, end_sec: 23.75, motivo: 'Remate', enabled: true },
  ];

  const mobileBuilt = buildFfmpegFilterComplex(cuts, 'raw.mov', 'out.mp4', true, 'mobile_fast');
  assert.equal(mobileBuilt.activeCount, 2);
  assert.ok(mobileBuilt.filterComplex.includes('scale=720:1280:force_original_aspect_ratio=decrease'));
  assert.ok(mobileBuilt.filterComplex.includes('pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1[v0]'));
  assert.ok(mobileBuilt.filterComplex.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'));
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-preset') + 1], 'ultrafast');
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-crf') + 1], '26');
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-maxrate') + 1], '3M');
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-bufsize') + 1], '6M');
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-b:a') + 1], '128k');

  const hdBuilt = buildFfmpegFilterComplex(cuts, 'raw.mov', 'out.mp4', true, 'high_1080p');
  assert.equal(hdBuilt.activeCount, 2);
  assert.ok(hdBuilt.filterComplex.includes('scale=1080:1920:force_original_aspect_ratio=decrease'));
  assert.ok(hdBuilt.filterComplex.includes('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1[v0]'));
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-preset') + 1], 'veryfast');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-crf') + 1], '21');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-maxrate') + 1], '6M');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-bufsize') + 1], '12M');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-profile:v') + 1], 'high');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-b:a') + 1], '192k');
});

test('buildMultiClipFfmpegFilterComplex references clip_index inputs for both 1080p and 720p mobile_fast', () => {
  const cuts: VideoCut[] = [
    { id: 'm1', clip_index: 1, start_sec: 2.0, end_sec: 6.5, motivo: 'Gancho del clip 2', enabled: true },
    { id: 'm2', clip_index: 0, start_sec: 1.0, end_sec: 5.0, motivo: 'Contexto del clip 1', enabled: true },
    { id: 'm3', clip_index: 2, start_sec: 0.5, end_sec: 3.0, motivo: 'Descartado', enabled: false },
  ];

  const hdBuilt = buildMultiClipFfmpegFilterComplex(
    cuts,
    ['input_0.mov', 'input_1.mp4', 'input_2.webm'],
    'combined.mp4',
    true,
    'high_1080p'
  );

  assert.equal(hdBuilt.activeCount, 2);
  // Preserves Gemini's cross-clip narrative order (clip 1 first, then clip 0)
  assert.ok(hdBuilt.filterComplex.startsWith('[1:v]trim=start=2.000:end=6.500,setpts=PTS-STARTPTS,scale=1080:1920'));
  assert.ok(hdBuilt.filterComplex.includes('fps=30,format=yuv420p,setsar=1[v0]'));
  assert.ok(hdBuilt.filterComplex.includes('[1:a]atrim=start=2.000:end=6.500,asetpts=PTS-STARTPTS'));
  assert.ok(hdBuilt.filterComplex.includes('[0:v]trim=start=1.000:end=5.000'));
  assert.ok(hdBuilt.filterComplex.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'));
  assert.deepEqual(hdBuilt.args.slice(0, 6), ['-i', 'input_0.mov', '-i', 'input_1.mp4', '-i', 'input_2.webm']);
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-preset') + 1], 'veryfast');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-crf') + 1], '21');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-b:a') + 1], '192k');

  const mobileBuilt = buildMultiClipFfmpegFilterComplex(
    cuts,
    ['input_0.mov', 'input_1.mp4', 'input_2.webm'],
    'combined_mobile.mp4',
    true,
    'mobile_fast'
  );
  assert.ok(mobileBuilt.filterComplex.startsWith('[1:v]trim=start=2.000:end=6.500,setpts=PTS-STARTPTS,scale=720:1280'));
  assert.ok(mobileBuilt.filterComplex.includes('pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1[v0]'));
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-preset') + 1], 'ultrafast');
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-crf') + 1], '26');
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-b:a') + 1], '128k');
});

test('buildGeminiSystemPrompt applies all 3 style presets and injects custom user instructions', () => {
  assert.equal(EDIT_STYLE_PRESETS.length, 3);
  assert.equal(normalizeStylePreset('unknown'), 'funny_jumpcut');
  assert.equal(normalizeStylePreset('agile_vlog'), 'agile_vlog');
  assert.equal(normalizeStylePreset('express_summary'), 'express_summary');

  const funnyPrompt = buildGeminiSystemPrompt('single', 'funny_jumpcut');
  assert.ok(funnyPrompt.includes('GRACIOSO / JUMP-CUT'));
  assert.ok(funnyPrompt.includes('esquema JSON'));
  assert.ok(!funnyPrompt.includes('INSTRUCCIÓN PRIORITARIA'));

  const vlogPrompt = buildGeminiSystemPrompt(
    'single',
    'agile_vlog',
    'Deja sí o sí la parte en la que se cae la taza, máximo 25 seg'
  );
  assert.ok(vlogPrompt.includes('VLOG ÁGIL'));
  assert.ok(vlogPrompt.includes('INSTRUCCIÓN PRIORITARIA DEL USUARIO'));
  assert.ok(vlogPrompt.includes('se cae la taza, máximo 25 seg'));

  const multiExpressPrompt = buildGeminiSystemPrompt(
    'multi',
    'express_summary',
    'Empieza con el clip de la cafetera'
  );
  assert.ok(multiExpressPrompt.includes('RESUMEN EXPRÉS'));
  assert.ok(multiExpressPrompt.includes('20 a 30 segundos'));
  assert.ok(multiExpressPrompt.includes('clip_index'));
  assert.ok(multiExpressPrompt.includes('Empieza con el clip de la cafetera'));
});

test('detectDefaultExportQuality picks mobile_fast on iPhone/Android and high_1080p on desktop', () => {
  assert.equal(
    detectDefaultExportQuality('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', 390),
    'mobile_fast'
  );
  assert.equal(
    detectDefaultExportQuality('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 412),
    'mobile_fast'
  );
  assert.equal(
    detectDefaultExportQuality('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 1440),
    'high_1080p'
  );
});

test('parseGeminiEditPlan sanitizes tag, handles single-clip overlap clamping and multi-clip clip_index', () => {
  const singleJson = JSON.stringify({
    etiqueta: 'cocína casera',
    titulo_interno: 'El batido explota en la encimera',
    duracion_objetivo_seg: 32,
    cortes: [
      { start_sec: 12.0, end_sec: 16.5, motivo: 'Reacción final' },
      { start_sec: 1.2, end_sec: 5.5, motivo: 'Intro rápida' },
      { start_sec: 5.0, end_sec: 9.0, motivo: 'Se cae la tapa' },
    ],
  });

  const singlePlan = parseGeminiEditPlan(singleJson);
  assert.equal(singlePlan.etiqueta, 'COCINA');
  assert.equal(singlePlan.cortes.length, 3);
  assert.equal(singlePlan.cortes[0].start_sec, 1.2);
  assert.equal(singlePlan.cortes[1].start_sec, 5.5);
  assert.equal(calculateSelectedDuration(singlePlan.cortes), 12.3);

  const multiJson = JSON.stringify({
    etiqueta: 'viaje',
    titulo_interno: 'Resumen caótico de 2 tomas',
    duracion_objetivo_seg: 35,
    cortes: [
      { clip_index: 1, start_sec: 4.0, end_sec: 8.0, motivo: 'Gancho fuerte' },
      { clip_index: 0, start_sec: 1.0, end_sec: 6.0, motivo: 'Explicación' },
      { clip_index: 99, start_sec: 9.0, end_sec: 12.0, motivo: 'Clamped index' },
    ],
  });

  const multiPlan = parseGeminiEditPlan(multiJson, { clipCount: 2, preserveOrder: true });
  assert.equal(multiPlan.cortes[0].clip_index, 1);
  assert.equal(multiPlan.cortes[1].clip_index, 0);
  assert.equal(multiPlan.cortes[2].clip_index, 1); // clamped safely to clipCount - 1
});

test('computeQueueAnalytics groups videos by day, computes saved footage time, and ranks tags', () => {
  const now = new Date('2026-11-21T12:00:00Z').getTime();
  const todayKey = toLocalDateKey(now);
  const yesterdayKey = toLocalDateKey(now - 86_400_000);

  const records: AnalyticsRecord[] = [
    { id: '1', dateKey: todayKey, processedAt: now, etiqueta: 'COCINA', rawDurationSec: 120, editedDurationSec: 30 },
    { id: '2', dateKey: todayKey, processedAt: now, etiqueta: 'COCINA', rawDurationSec: 90, editedDurationSec: 30 },
    { id: '3', dateKey: yesterdayKey, processedAt: now - 86_400_000, etiqueta: 'VIAJE', rawDurationSec: 200, editedDurationSec: 50 },
  ];

  const summary = computeQueueAnalytics(records, 7, now);
  assert.equal(summary.totalProcessed, 3);
  assert.equal(summary.totalSavedSec, 300); // 90 + 60 + 150
  assert.equal(summary.avgReductionPct, 73);
  assert.equal(summary.dailySeries.length, 7);
  assert.equal(summary.dailySeries[summary.dailySeries.length - 1].count, 2);
  assert.equal(summary.dailySeries[summary.dailySeries.length - 2].count, 1);
  assert.equal(summary.tagBreakdown[0].etiqueta, 'COCINA');
  assert.equal(summary.tagBreakdown[0].count, 2);
  assert.equal(summary.tagBreakdown[1].etiqueta, 'VIAJE');
});

test('exceedsMobileRamThreshold triggers strictly above 200 MB', () => {
  assert.equal(exceedsMobileRamThreshold(MOBILE_RAM_WARNING_BYTES), false);
  assert.equal(exceedsMobileRamThreshold(MOBILE_RAM_WARNING_BYTES + 1), true);
});

test('evaluateHeavyVideoWarning detects heavy size, 4K resolution, and long duration', () => {
  const light = evaluateHeavyVideoWarning({
    sizeBytes: 35 * 1024 * 1024,
    durationSec: 90,
    width: 1080,
    height: 1920,
  });
  assert.equal(light.isHeavy, false);
  assert.equal(light.message, null);

  const heavy4k = evaluateHeavyVideoWarning({
    sizeBytes: 260 * 1024 * 1024,
    durationSec: 420,
    width: 2160,
    height: 3840,
  });
  assert.equal(heavy4k.isHeavy, true);
  assert.equal(heavy4k.reasons.length, 3);
  assert.ok(heavy4k.message?.includes('4K'));
  assert.ok(heavy4k.message?.includes('720p móvil'));
});

test('TikTok pipeline defaults have subtitles OFF, silence trim ON, loudnorm ON, and center_crop framing', () => {
  assert.equal(DEFAULT_TIKTOK_OPTIONS.subtitlesEnabled, false);
  assert.equal(DEFAULT_TIKTOK_OPTIONS.silenceTrimEnabled, true);
  assert.equal(DEFAULT_TIKTOK_OPTIONS.audioNormalizeEnabled, true);
  assert.equal(DEFAULT_TIKTOK_OPTIONS.framingMode, 'center_crop');

  const normalized = normalizeTikTokOptions({ framingMode: 'blur_pad', subtitlesEnabled: true });
  assert.equal(normalized.framingMode, 'blur_pad');
  assert.equal(normalized.subtitlesEnabled, true);
  assert.equal(normalized.silenceTrimEnabled, true);
  assert.equal(normalized.audioNormalizeEnabled, true);
});

test('Gemini prompt and parser skip subtitles when OFF and include interest scores + subtitles when ON', () => {
  const promptNoSubs = buildGeminiSystemPrompt('single', 'funny_jumpcut', '', {
    subtitlesEnabled: false,
    silenceTrimEnabled: true,
  });
  assert.ok(promptNoSubs.includes('puntuacion_interes'));
  assert.ok(!promptNoSubs.includes('SUBTÍTULOS AUTOMÁTICOS ACTIVADOS'));

  const promptWithSubs = buildGeminiSystemPrompt('single', 'funny_jumpcut', '', {
    subtitlesEnabled: true,
    silenceTrimEnabled: true,
  });
  assert.ok(promptWithSubs.includes('SUBTÍTULOS AUTOMÁTICOS ACTIVADOS'));
  assert.ok(promptWithSubs.includes('"subtitulos"'));

  const mockGeminiResponse = JSON.stringify({
    etiqueta: 'COCINA',
    titulo_interno: 'Fail épico con batidora',
    duracion_objetivo_seg: 25,
    cortes: [
      { clip_index: 0, start_sec: 1.0, end_sec: 6.0, motivo: 'Gancho', puntuacion_interes: 9 },
      { clip_index: 0, start_sec: 12.0, end_sec: 18.0, motivo: 'Remate', puntuacion_interes: 10 },
    ],
    subtitulos: [
      { clip_index: 0, start_sec: 1.5, end_sec: 3.5, text: 'Mira esto' },
      { clip_index: 0, start_sec: 13.0, end_sec: 16.0, text: 'Se explotó todo' },
    ],
  });

  // With subtitles OFF: completely strips/skips subtitles
  const planNoSubs = parseGeminiEditPlan(mockGeminiResponse, { subtitlesEnabled: false });
  assert.equal(planNoSubs.subtitulos, undefined);
  assert.equal(planNoSubs.cortes[0].puntuacion_interes, 9);
  assert.equal(planNoSubs.cortes[1].puntuacion_interes, 10);

  // With subtitles ON: preserves structured subtitles
  const planWithSubs = parseGeminiEditPlan(mockGeminiResponse, { subtitlesEnabled: true });
  assert.equal(planWithSubs.subtitulos?.length, 2);
  assert.equal(planWithSubs.subtitulos?.[1].text, 'Se explotó todo');
});

test('filterEditedCuts and remapSubtitlesToFinalTimeline respect user-disabled, trimmed, and reordered EDL cuts', () => {
  const userEditedCuts: VideoCut[] = [
    // User moved Cut 2 BEFORE Cut 1 and disabled Cut 3
    { id: 'c2', clip_index: 0, start_sec: 20.0, end_sec: 25.0, motivo: 'Remate al inicio', puntuacion_interes: 10, enabled: true },
    { id: 'c3', clip_index: 0, start_sec: 30.0, end_sec: 34.0, motivo: 'Descartado por usuario', puntuacion_interes: 5, enabled: false },
    { id: 'c1', clip_index: 0, start_sec: 2.0, end_sec: 6.0, motivo: 'Contexto después', puntuacion_interes: 8, enabled: true },
    { id: 'c-bad', clip_index: 0, start_sec: 8.0, end_sec: 8.05, motivo: 'Demasiado corto', enabled: true },
  ];

  const active = filterEditedCuts(userEditedCuts, true);
  assert.deepEqual(
    active.map((c) => c.id),
    ['c2', 'c1']
  );

  const rawSubs: SubtitleBlock[] = [
    { id: 's1', clip_index: 0, start_sec: 2.5, end_sec: 5.5, text: 'Contexto' },
    { id: 's2', clip_index: 0, start_sec: 21.0, end_sec: 24.0, text: 'Remate' },
    { id: 's3', clip_index: 0, start_sec: 31.0, end_sec: 33.0, text: 'No debe aparecer' },
  ];

  const remapped = remapSubtitlesToFinalTimeline(rawSubs, active);
  assert.equal(remapped.length, 2);
  // First cut in EDL is 20..25 (5s), so s2 (21..24) maps to 1..4s
  assert.equal(remapped[0].text, 'Remate');
  assert.equal(remapped[0].start_sec, 1);
  assert.equal(remapped[0].end_sec, 4);
  // Second cut in EDL starts at offset 5s (raw 2..6), so s1 (2.5..5.5) maps to 5.5..8.5s
  assert.equal(remapped[1].text, 'Contexto');
  assert.equal(remapped[1].start_sec, 5.5);
  assert.equal(remapped[1].end_sec, 8.5);

  const srt = buildSrtSubtitles(remapped);
  assert.ok(srt.includes('00:00:01,000 --> 00:00:04,000'));
  assert.ok(srt.includes('Remate'));
  assert.ok(!srt.includes('No debe aparecer'));

  const ass = buildAssSubtitles(remapped, 1080, 1920);
  assert.ok(ass.includes('PlayResX: 1080'));
  assert.ok(ass.includes('Dialogue: 0,0:00:01.00,0:00:04.00,TikTok'));
});

test('FFmpeg pipeline applies framingMode, silence trim, -14 LUFS loudnorm, and optional burned subtitles', () => {
  const cuts: VideoCut[] = [
    { id: 'c2', clip_index: 0, start_sec: 15.0, end_sec: 20.0, motivo: 'Gancho', enabled: true },
    { id: 'c1', clip_index: 0, start_sec: 2.0, end_sec: 6.0, motivo: 'Desarrollo', enabled: true },
  ];

  // Subtitles OFF + blur_pad + loudnorm + silence trim + preserve user EDL order
  const noSubsBlur = buildFfmpegFilterComplex(cuts, 'in.mp4', 'out.mp4', true, 'high_1080p', {
    framingMode: 'blur_pad',
    silenceTrimEnabled: true,
    audioNormalizeEnabled: true,
    preserveOrder: true,
  });
  assert.ok(noSubsBlur.filterComplex.startsWith('[0:v]trim=start=15.000:end=20.000'));
  assert.ok(noSubsBlur.filterComplex.includes('boxblur=24:4'));
  assert.ok(noSubsBlur.filterComplex.includes('overlay=(W-w)/2:(H-h)/2'));
  assert.ok(noSubsBlur.filterComplex.includes('silenceremove=start_periods=1'));
  assert.ok(noSubsBlur.filterComplex.includes('loudnorm=I=-14:TP=-1.5:LRA=11[outa_norm]'));
  assert.ok(!noSubsBlur.filterComplex.includes('subtitles='));
  assert.equal(noSubsBlur.args[noSubsBlur.args.indexOf('-map') + 1], '[outv]');

  // Subtitles ON + center_crop + no loudnorm + no silence trim
  const withSubsCrop = buildFfmpegFilterComplex(cuts, 'in.mp4', 'out.mp4', true, 'mobile_fast', {
    framingMode: 'center_crop',
    silenceTrimEnabled: false,
    audioNormalizeEnabled: false,
    subtitleFileName: 'subs_job1.ass',
    preserveOrder: true,
  });
  assert.ok(withSubsCrop.filterComplex.includes('scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280'));
  assert.ok(withSubsCrop.filterComplex.includes('[outv]subtitles=subs_job1.ass[outv_sub]'));
  assert.ok(!withSubsCrop.filterComplex.includes('silenceremove='));
  assert.ok(!withSubsCrop.filterComplex.includes('loudnorm='));
  assert.equal(withSubsCrop.args[withSubsCrop.args.indexOf('-map') + 1], '[outv_sub]');
});

test('formatSeconds, formatDurationHuman, and formatBytes produce clean deterministic labels', () => {
  assert.equal(formatSeconds(65.4), '1:05.4');
  assert.equal(formatSeconds(4.2), '0:04.2');
  assert.equal(formatSeconds(1.2), '0:01.2');
  assert.equal(formatSeconds(5.8), '0:05.8');
  assert.equal(formatSeconds(38.9), '0:38.9');
  assert.equal(formatSeconds(59.96), '1:00.0');
  assert.equal(formatDurationHuman(305), '5 min 5 s');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(26214400), '25.0 MB');
});

test('Gemini model configuration defaults to gemini-3.8-flash and sanitizes custom or retired model IDs', () => {
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  assert.equal(RECOMMENDED_GEMINI_MODELS[0].id, 'gemini-3.8-flash');

  // Supports env / user custom model overrides and strips optional "models/" prefix
  assert.equal(sanitizeGeminiModelName('models/gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModelName('  gemini-4-hydrogen  '), 'gemini-4-hydrogen');
  assert.equal(sanitizeGeminiModelName('gemini-3.9-custom-preview'), 'gemini-3.9-custom-preview');

  // Auto-migrates retired Gemini 1.x / 2.x names and rejects blank or unsafe strings
  const retiredLegacyName = ['gemini', '2.0', 'flash'].join('-');
  assert.equal(sanitizeGeminiModelName(retiredLegacyName), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModelName(''), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModelName('invalid model with spaces'), 'gemini-3.8-flash');
  assert.equal(sanitizeGeminiModelName(undefined, 'gemini-4-hydrogen'), 'gemini-4-hydrogen');
});

test('parseHumanReadableApiError converts raw Gemini JSON/HTTP errors into clear Spanish messages', () => {
  const retired404Json = JSON.stringify({
    error: {
      code: 404,
      message: 'models/legacy-model is no longer available to new users. Please update your code to use models/gemini-3.8-flash.',
      status: 'NOT_FOUND',
    },
  });

  const parsed404 = parseHumanReadableApiError(retired404Json);
  assert.equal(
    parsed404.userMessage,
    'El modelo de IA configurado no está disponible. Revisa o cambia el modelo en Ajustes.'
  );
  assert.equal(parsed404.actionHint, 'settings');
  assert.ok(parsed404.technicalDetail?.includes('no longer available'));
  assert.ok(!parsed404.userMessage.includes('{'));

  const parsed429 = parseHumanReadableApiError(
    JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } })
  );
  assert.ok(parsed429.userMessage.includes('cuota'));
  assert.equal(parsed429.actionHint, 'settings');

  const parsed403 = parseHumanReadableApiError(
    JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API_KEY_INVALID' } })
  );
  assert.ok(parsed403.userMessage.includes('clave de la API'));

  const parsed503 = parseHumanReadableApiError(
    JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Model overloaded' } })
  );
  assert.ok(parsed503.userMessage.includes('saturado'));

  const parsedHuman = parseHumanReadableApiError('Selecciona archivos de vídeo válidos.');
  assert.equal(parsedHuman.userMessage, 'Selecciona archivos de vídeo válidos.');
  assert.equal(parsedHuman.technicalDetail, undefined);

  // Safari "Load failed" and AbortError timeout handling
  const parsedSafari = parseHumanReadableApiError('Load failed');
  assert.ok(parsedSafari.userMessage.includes('Conexión interrumpida'));
  assert.equal(parsedSafari.technicalDetail, 'Load failed');

  const parsedTimeout = parseHumanReadableApiError('AbortError: The operation timed out');
  assert.ok(parsedTimeout.userMessage.includes('Tiempo de espera agotado'));
});

test('Lightweight frame extraction sampling caps at 12-16 frames and 480px width for any video length', () => {
  assert.equal(AI_FRAME_MIN_COUNT, 12);
  assert.equal(AI_FRAME_MAX_COUNT, 16);
  assert.equal(AI_FRAME_TARGET_WIDTH, 480);
  assert.equal(AI_FRAME_JPEG_QUALITY, 0.55);
  assert.equal(AI_MAX_JSON_PAYLOAD_BYTES, 2 * 1024 * 1024);

  // Short 10s video (like the 11.9 MB iOS clip)
  const shortTs = computeFrameTimestamps(10);
  assert.ok(shortTs.length >= 12 && shortTs.length <= 16);
  assert.ok(shortTs[0] >= 0 && shortTs[shortTs.length - 1] < 10);

  // Long 4:30 video (like the 301 MB iOS clip)
  const longTs = computeFrameTimestamps(270);
  assert.equal(longTs.length, 16);
  assert.ok(longTs[0] >= 0 && longTs[longTs.length - 1] < 270);

  // Even if caller requests 50 frames, hard-capped at 16
  assert.equal(computeFrameTimestamps(600, 50).length, 16);

  // 4K portrait video scales proportionally down to 480px wide
  const scaled4k = computeScaledDimensions(2160, 3840);
  assert.equal(scaled4k.width, 480);
  assert.equal(scaled4k.height, 854);

  // Already-small video does not upscale beyond original width
  const small = computeScaledDimensions(320, 568);
  assert.equal(small.width, 320);
});

test('enforceAiPayloadBudget guarantees <= 16 frames and strictly < 2 MB JSON payload', () => {
  // Simulate 24 oversized frames (~180 KB base64 each = > 4.3 MB total)
  const bigBase64 = 'A'.repeat(180_000);
  const oversizedFrames: ExtractedVideoFrame[] = Array.from({ length: 24 }, (_, i) => ({
    timestampSec: Number((i * 10).toFixed(2)),
    dataBase64: bigBase64,
    mimeType: 'image/jpeg',
    width: 480,
    height: 854,
  }));

  const budgeted = enforceAiPayloadBudget({
    fileName: 'IMG_301MB_4K.MOV',
    durationSec: 270,
    model: 'gemini-3.8-flash',
    frames: oversizedFrames,
  });

  assert.ok(budgeted.payload.frames.length <= AI_FRAME_MAX_COUNT);
  assert.ok(budgeted.byteLength <= AI_MAX_JSON_PAYLOAD_BYTES);
  assert.ok(budgeted.trimmedFrames > 0);

  // Typical 16 lightweight JPEG frames (~35 KB each = ~560 KB) pass untouched well below 2 MB
  const normalFrames: ExtractedVideoFrame[] = Array.from({ length: 16 }, (_, i) => ({
    timestampSec: i * 5,
    dataBase64: 'B'.repeat(35_000),
    mimeType: 'image/jpeg',
    width: 480,
    height: 854,
  }));
  const normalBudgeted = enforceAiPayloadBudget({
    fileName: 'clip_corto.mp4',
    durationSec: 10,
    frames: normalFrames,
  });
  assert.equal(normalBudgeted.payload.frames.length, 16);
  assert.equal(normalBudgeted.trimmedFrames, 0);
  assert.ok(normalBudgeted.byteLength < 700_000);

  // Single impossibly huge frame (> 2 MB alone) throws a [Extracción frames] error
  assert.throws(
    () =>
      enforceAiPayloadBudget({
        fileName: 'broken.mp4',
        frames: [
          {
            timestampSec: 0,
            dataBase64: 'C'.repeat(AI_MAX_JSON_PAYLOAD_BYTES + 10_000),
            mimeType: 'image/jpeg',
            width: 480,
            height: 854,
          },
        ],
      }),
    /\[Extracción frames\]/
  );
});

test('mergeMultiClipEditPlans combines per-clip analyses preserving clip_index and formatPhaseError avoids duplicates', () => {
  const merged = mergeMultiClipEditPlans(
    [
      {
        clipIndex: 0,
        fileName: 'clip_a.mov',
        durationSec: 40,
        plan: {
          etiqueta: 'VIAJE',
          titulo_interno: 'Salida desde casa',
          duracion_objetivo_seg: 15,
          cortes: [
            { id: 'a1', clip_index: 0, start_sec: 1, end_sec: 7, motivo: 'Gancho', puntuacion_interes: 9, enabled: true },
          ],
        },
      },
      {
        clipIndex: 1,
        fileName: 'clip_b.mov',
        durationSec: 50,
        plan: {
          etiqueta: 'VIAJE',
          titulo_interno: 'Llegada a la playa',
          duracion_objetivo_seg: 18,
          cortes: [
            { id: 'b1', clip_index: 0, start_sec: 3, end_sec: 11, motivo: 'Remate', puntuacion_interes: 10, enabled: true },
          ],
        },
      },
    ],
    { projectName: 'Escapada' }
  );

  assert.equal(merged.etiqueta, 'VIAJE');
  assert.equal(merged.cortes.length, 2);
  assert.equal(merged.cortes[0].clip_index, 0);
  assert.equal(merged.cortes[1].clip_index, 1);
  assert.ok(merged.titulo_interno.includes('Escapada'));

  assert.equal(formatPhaseError('Drive', 'Token expirado'), '[Drive] Token expirado');
  assert.equal(formatPhaseError('FFmpeg', '[FFmpeg] Error WASM'), '[FFmpeg] Error WASM');
  assert.equal(formatPhaseError('Análisis IA', 'Timeout'), '[Análisis IA] Timeout');
  assert.equal(formatPhaseError('Extracción frames', 'Códec no soportado'), '[Extracción frames] Códec no soportado');
});

test('debugLogger keeps a 200-entry circular buffer, redacts secrets/base64, and builds a clean diagnostic report', () => {
  clearDebugLogs();
  assert.equal(MAX_DEBUG_LOG_ENTRIES, 200);

  // Fill 215 entries -> circular buffer keeps strictly the last 200
  for (let i = 1; i <= 215; i += 1) {
    logInfo('UI', `Evento número ${i}`);
  }
  const all = getDebugLogs();
  assert.equal(all.length, 200);
  assert.equal(all[0].message, 'Evento número 16');
  assert.equal(all[199].message, 'Evento número 215');
  assert.match(all[0].timestamp, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);

  // Security redaction: API keys, OAuth tokens, Authorization Bearer, and base64 images are NEVER stored raw
  clearDebugLogs();
  const fakeApiKey = 'AIzaSyD1234567890abcdefghijklmnopqrstuv';
  const fakeOAuth = 'ya29.a0AfH6SMBxFakeGoogleOAuthTokenValue1234567890';
  const fakeBase64 = `data:image/jpeg;base64,${'A'.repeat(4000)}`;

  logError(
    'IA',
    `Fallo con Authorization: Bearer ${fakeOAuth} y key ${fakeApiKey} img=${fakeBase64}`,
    {
      access_token: fakeOAuth,
      authorization: `Bearer ${fakeOAuth}`,
      apiKey: fakeApiKey,
      dataBase64: 'B'.repeat(8000),
      http: 404,
      archivo: 'clip.mov',
    },
    new Error(`Boom ${fakeApiKey}`)
  );

  const report = buildDiagnosticReport({
    settings: {
      model: 'gemini-3.8-flash',
      exportQuality: 'mobile_fast',
      autoWatchEnabled: false,
      watchIntervalSec: 60,
      autoUploadEnabled: true,
      hasFolderId: true,
    },
    tiktokOptions: {
      subtitlesEnabled: false,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    stylePreset: 'funny_jumpcut',
    queueSummary: { total: 3, pending: 1, active: 0, completed: 1, error: 1 },
    activeError: '[Análisis IA] Error 404',
  });

  // Never leaks secrets or raw base64
  assert.ok(!report.includes(fakeApiKey));
  assert.ok(!report.includes(fakeOAuth));
  assert.ok(!report.includes('AAAA'.repeat(40)));
  assert.ok(!report.includes('BBBB'.repeat(40)));
  assert.ok(report.includes('[OMITIDO]'));
  assert.ok(report.includes('[base64:'));
  assert.ok(sanitizeLogString(fakeBase64).startsWith('[base64:'));

  // Contains structured sections required for mobile debugging
  assert.ok(report.includes('--- ENTORNO ---'));
  assert.ok(report.includes('--- CONFIGURACIÓN ACTIVA ---'));
  assert.ok(report.includes('Modelo Gemini: gemini-3.8-flash'));
  assert.ok(report.includes('720p móvil'));
  assert.ok(report.includes('Subtítulos automáticos: No'));
  assert.ok(report.includes('--- ESTADO DE LA COLA ---'));
  assert.ok(report.includes('--- CRONOLOGÍA (1 eventos · 1 errores'));
  assert.equal(getDebugLogStats().errors, 1);

  clearDebugLogs();
  assert.equal(getDebugLogStats().total, 0);
});

test('FFmpeg core sources prioritize dist/esm for module workers with dist/umd strictly as fallback and exact MIME types', () => {
  assert.equal(FFMPEG_ASSET_MIME_TYPES.coreJs, 'text/javascript');
  assert.equal(FFMPEG_ASSET_MIME_TYPES.coreWasm, 'application/wasm');

  assert.ok(FFMPEG_CORE_SOURCES.length >= 3);
  assert.equal(FFMPEG_CORE_SOURCES[0].format, 'esm');
  assert.equal(
    FFMPEG_CORE_SOURCES[0].baseURL,
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'
  );
  assert.equal(FFMPEG_CORE_SOURCES[1].format, 'esm');
  assert.equal(
    FFMPEG_CORE_SOURCES[1].baseURL,
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm'
  );

  const firstUmdIndex = FFMPEG_CORE_SOURCES.findIndex((s) => s.format === 'umd');
  assert.ok(firstUmdIndex >= 2, 'dist/umd must only appear after all dist/esm sources');
  assert.ok(
    FFMPEG_CORE_SOURCES.slice(firstUmdIndex).every(
      (s) => s.format === 'umd' && s.baseURL.endsWith('/dist/umd')
    )
  );
});

test('debugLogger persists last 120 events to localStorage, appends session separator on reload, and clears storage on reset', () => {
  const store = new Map<string, string>();
  const mockLocalStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };

  const prevLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = mockLocalStorage;

  try {
    clearDebugLogs();
    assert.equal(MAX_PERSISTED_DEBUG_LOG_ENTRIES, 120);
    assert.equal(DEBUG_LOGS_STORAGE_KEY, 'autocut_debug_logs_v1');

    // Emit 145 events -> persisted tail must cap strictly at 120 entries
    for (let i = 1; i <= 145; i += 1) {
      logInfo('FFmpeg', `Paso previo ${i}`);
    }
    const rawSaved = store.get(DEBUG_LOGS_STORAGE_KEY);
    assert.ok(rawSaved, 'Logs should be persisted in localStorage');
    const parsedSaved = JSON.parse(rawSaved);
    assert.equal(parsedSaved.length, 120);
    assert.equal(parsedSaved[0].message, 'Paso previo 26');
    assert.equal(parsedSaved[119].message, 'Paso previo 145');

    // Simulate OOM reload: hydrate restores prior events WITHOUT deleting them and appends session separator
    const restoredCount = hydrateDebugLogsFromStorage();
    assert.equal(restoredCount, 120);

    const afterReload = getDebugLogs();
    assert.equal(afterReload.length, 121);
    assert.equal(afterReload[119].message, 'Paso previo 145');
    assert.equal(afterReload[120].message, NEW_SESSION_SEPARATOR);

    // Manual clear wipes both in-memory buffer and localStorage
    clearDebugLogs();
    assert.equal(getDebugLogs().length, 0);
    assert.equal(store.has(DEBUG_LOGS_STORAGE_KEY), false);
  } finally {
    if (prevLocalStorage === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      (globalThis as Record<string, unknown>).localStorage = prevLocalStorage;
    }
  }
});

test('Sequential Multi-Clip pipeline groups 1 clip at a time while preserving cross-clip order and using zero-reencode concat -c copy', () => {
  const cuts: VideoCut[] = [
    { id: 'c1', clip_index: 0, start_sec: 1, end_sec: 4, motivo: 'Intro clip 0', enabled: true },
    { id: 'c2', clip_index: 2, start_sec: 2, end_sec: 6, motivo: 'Salto clip 2', enabled: true },
    { id: 'c3', clip_index: 0, start_sec: 10, end_sec: 14, motivo: 'Vuelta clip 0', enabled: true },
    { id: 'c4', clip_index: 1, start_sec: 0, end_sec: 3, motivo: 'Desactivado', enabled: false },
  ];

  const plan = planSequentialMultiClipJobs(cuts, 4, 't1');
  assert.equal(plan.totalSegments, 3);
  // Only clips 0 and 2 have active cuts; clips 1 and 3 are skipped completely to save RAM!
  assert.deepEqual(
    plan.clipBatches.map((b) => b.clipIndex),
    [0, 2]
  );
  assert.deepEqual(
    plan.clipBatches[0].cuts.map((j) => j.orderIndex),
    [0, 2]
  );
  assert.deepEqual(
    plan.clipBatches[1].cuts.map((j) => j.orderIndex),
    [1]
  );
  assert.deepEqual(plan.orderedSegmentFileNames, [
    'seg_t1_000.mp4',
    'seg_t1_001.mp4',
    'seg_t1_002.mp4',
  ]);

  // Single-segment FFmpeg command encodes strictly 1 input with uniform timescale 90000
  const segCmd = buildSingleSegmentFfmpegArgs(
    cuts[0],
    'mc_raw_t1_0.mov',
    'seg_t1_000.mp4',
    'source',
    'mobile_fast',
    { framingMode: 'center_crop', silenceTrimEnabled: true, audioNormalizeEnabled: true }
  );
  assert.ok(segCmd.args.includes('-video_track_timescale'));
  assert.ok(segCmd.args.includes('90000'));
  assert.ok(segCmd.filterComplex.includes('loudnorm=I=-14'));
  assert.equal(segCmd.args.filter((a) => a === '-i').length, 1);

  // Silent-audio fallback generates matching 48kHz stereo track for uniform concat -c copy
  const silentCmd = buildSingleSegmentFfmpegArgs(
    cuts[0],
    'mc_raw_t1_0.mov',
    'seg_t1_000.mp4',
    'silent',
    'mobile_fast'
  );
  assert.ok(silentCmd.args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));

  // Final concat demuxer uses -c copy (zero re-encoding)
  const listTxt = buildConcatListContent(plan.orderedSegmentFileNames);
  assert.equal(
    listTxt,
    "file 'seg_t1_000.mp4'\nfile 'seg_t1_001.mp4'\nfile 'seg_t1_002.mp4'\n"
  );
  const concatArgs = buildConcatCopyFfmpegArgs('concat_t1.txt', 'combined_t1.mp4');
  assert.deepEqual(concatArgs, [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    'concat_t1.txt',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    'combined_t1.mp4',
  ]);
});

test('evaluateMultiClipMobileRamProtection warns on mobile 1080p when clips > 3 or total > 200 MB', () => {
  assert.equal(MOBILE_MULTICLIP_SAFE_CLIP_LIMIT, 3);
  assert.equal(
    isMobileViewportOrUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 390),
    true
  );
  assert.equal(
    isMobileViewportOrUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 1440),
    false
  );

  // 7 clips (~680 MB) on iPhone in 1080p -> MUST warn
  const sevenClipsIos = evaluateMultiClipMobileRamProtection({
    clipCount: 7,
    totalBytes: 680 * 1024 * 1024,
    exportQuality: 'high_1080p',
    isMobile: true,
  });
  assert.equal(sevenClipsIos.shouldWarn, true);
  assert.ok(sevenClipsIos.reason?.includes('7 clips'));
  assert.ok(sevenClipsIos.reason?.includes('720p móvil'));

  // 4 small clips (80 MB) on mobile in 1080p -> MUST warn (> 3 clips)
  const fourSmallClips = evaluateMultiClipMobileRamProtection({
    clipCount: 4,
    totalBytes: 80 * 1024 * 1024,
    exportQuality: 'high_1080p',
    isMobile: true,
  });
  assert.equal(fourSmallClips.shouldWarn, true);

  // 2 large clips (250 MB) on mobile in 1080p -> MUST warn (> 200 MB)
  const twoHeavyClips = evaluateMultiClipMobileRamProtection({
    clipCount: 2,
    totalBytes: 250 * 1024 * 1024,
    exportQuality: 'high_1080p',
    isMobile: true,
  });
  assert.equal(twoHeavyClips.shouldWarn, true);

  // Same 7 clips (~680 MB) on mobile once switched to 720p móvil -> cleared!
  const safe720p = evaluateMultiClipMobileRamProtection({
    clipCount: 7,
    totalBytes: 680 * 1024 * 1024,
    exportQuality: 'mobile_fast',
    isMobile: true,
  });
  assert.equal(safe720p.shouldWarn, false);

  // Desktop 1080p -> does not trigger mobile guard
  const desktop1080p = evaluateMultiClipMobileRamProtection({
    clipCount: 7,
    totalBytes: 680 * 1024 * 1024,
    exportQuality: 'high_1080p',
    isMobile: false,
  });
  assert.equal(desktop1080p.shouldWarn, false);
});

test('Hybrid PC render contract: buildRenderJobManifest, shouldRecommendPcRender, and formatPcJobStatusLabel', () => {
  assert.equal(PC_RENDER_RECOMMENDED_BYTES, 100 * 1024 * 1024);
  assert.equal(shouldRecommendPcRender({ sizeBytes: 50 * 1024 * 1024, isMultiClip: false }), false);
  assert.equal(shouldRecommendPcRender({ sizeBytes: 120 * 1024 * 1024, isMultiClip: false }), true);
  assert.equal(shouldRecommendPcRender({ sizeBytes: 25 * 1024 * 1024, isMultiClip: true }), true);

  assert.equal(formatPcJobStatusLabel('pending', 0), 'En cola PC');
  assert.equal(formatPcJobStatusLabel('processing', 45), 'Renderizando en PC (45%)');
  assert.equal(formatPcJobStatusLabel('completed', 100), 'Completado');
  assert.equal(formatPcJobStatusLabel('error', 30), 'Error');

  // Multi-Clip manifest with subtitles ON and blur_pad -> blur_bg
  const multiManifest = buildRenderJobManifest({
    jobId: 'testjob1',
    createdAt: '2026-11-22T10:00:00.000Z',
    exportQuality: 'high_1080p',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'blur_pad',
    },
    item: {
      id: 'mc-1',
      originalName: 'Viaje_Combinado',
      projectName: 'Viaje',
      isMultiClip: true,
      sourceClips: [
        { id: 's0', source: 'drive', driveFileId: 'drv-0', originalName: 'clip_a.mov', mimeType: 'video/quicktime', sizeBytes: 180_000_000 },
        { id: 's1', source: 'drive', driveFileId: 'drv-1', originalName: 'clip_b.mp4', mimeType: 'video/mp4', sizeBytes: 210_000_000 },
      ],
      analysis: {
        etiqueta: 'VIAJE',
        titulo_interno: 'Escapada express',
        duracion_objetivo_seg: 12,
        cortes: [
          { id: 'c1', clip_index: 1, start_sec: 5, end_sec: 10, motivo: 'Gancho', enabled: true },
          { id: 'c2', clip_index: 0, start_sec: 2, end_sec: 4, motivo: 'Omitido', enabled: false },
          { id: 'c3', clip_index: 0, start_sec: 12, end_sec: 18, motivo: 'Remate', enabled: true },
        ],
        subtitulos: [
          { id: 'sub1', clip_index: 1, start_sec: 5.5, end_sec: 7.5, text: '¡Arrancamos!' },
          { id: 'sub2', clip_index: 0, start_sec: 13, end_sec: 15, text: 'Final épico' },
        ],
      },
    },
  });

  assert.equal(multiManifest.jobId, 'testjob1');
  assert.equal(multiManifest.status, 'pending');
  assert.equal(multiManifest.progress, 0);
  assert.equal(multiManifest.sourceFiles.length, 2);
  assert.deepEqual(multiManifest.sourceFiles[0], { name: 'clip_a.mov', driveFileId: 'drv-0' });
  assert.deepEqual(multiManifest.cuts, [
    { clipIndex: 1, start: 5, end: 10 },
    { clipIndex: 0, start: 12, end: 18 },
  ]);
  assert.equal(multiManifest.options.quality, '1080p');
  assert.equal(multiManifest.options.framing, 'blur_bg');
  assert.equal(multiManifest.options.removeSilences, true);
  assert.equal(multiManifest.options.normalizeAudio, true);
  assert.equal(multiManifest.options.subtitlesEnabled, true);
  assert.deepEqual(multiManifest.options.subtitlesData, [
    { start: 0.5, end: 2.5, text: '¡Arrancamos!' },
    { start: 6, end: 8, text: 'Final épico' },
  ]);
  assert.ok(multiManifest.outputFileName.endsWith('.mp4'));

  // Single-clip manifest with subtitles OFF omits subtitlesData completely & maps mobile_fast -> 720p
  const singleManifest = buildRenderJobManifest({
    jobId: 'testjob2',
    exportQuality: 'mobile_fast',
    tiktokOptions: {
      subtitlesEnabled: false,
      silenceTrimEnabled: false,
      audioNormalizeEnabled: false,
      framingMode: 'center_crop',
    },
    item: {
      id: 'sc-1',
      originalName: 'IMG_4021.MOV',
      driveFileId: 'drv-single',
      isMultiClip: false,
      analysis: {
        etiqueta: 'VLOG',
        titulo_interno: 'Café rápido',
        duracion_objetivo_seg: 8,
        cortes: [
          { id: 'c1', clip_index: 0, start_sec: 1, end_sec: 9, motivo: 'Único corte', enabled: true },
        ],
        subtitulos: [{ id: 's1', clip_index: 0, start_sec: 2, end_sec: 4, text: 'No incluir' }],
      },
    },
  });

  assert.equal(singleManifest.options.quality, '720p');
  assert.equal(singleManifest.options.framing, 'center_crop');
  assert.equal(singleManifest.options.subtitlesEnabled, false);
  assert.equal(singleManifest.options.subtitlesData, undefined);
  assert.deepEqual(singleManifest.sourceFiles, [
    { name: 'IMG_4021.MOV', driveFileId: 'drv-single' },
  ]);
  assert.equal(singleManifest.target, 'pc');
});

test('Cloud render contract: target "cloud" manifest, uploadedTempSource, status labels, and GitHub PAT log redaction', () => {
  assert.equal(formatPcJobStatusLabel('pending', 0, 'cloud'), 'En cola nube');
  assert.equal(
    formatPcJobStatusLabel('processing', 62, 'cloud'),
    'Renderizando en la nube (62%)'
  );
  assert.equal(formatPcJobStatusLabel('completed', 100, 'cloud'), 'Completado');
  assert.equal(formatPcJobStatusLabel('error', 10, 'cloud'), 'Error');

  const cloudManifest = buildRenderJobManifest({
    jobId: 'cloudjob1',
    target: 'cloud',
    createdAt: '2026-11-22T12:00:00.000Z',
    exportQuality: 'high_1080p',
    tiktokOptions: {
      subtitlesEnabled: false,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    sourceFilesOverride: [
      { name: 'drive_clip.mp4', driveFileId: 'drv-original-1' },
      { name: 'phone_clip.mov', driveFileId: 'drv-temp-2', uploadedTempSource: true },
    ],
    item: {
      id: 'mc-cloud-1',
      originalName: 'Proyecto_Nube',
      projectName: 'Proyecto_Nube',
      isMultiClip: true,
      sourceClips: [
        { id: 'c0', source: 'drive', driveFileId: 'drv-original-1', originalName: 'drive_clip.mp4', mimeType: 'video/mp4', sizeBytes: 150_000_000 },
        { id: 'c1', source: 'local', originalName: 'phone_clip.mov', mimeType: 'video/quicktime', sizeBytes: 190_000_000 },
      ],
      analysis: {
        etiqueta: 'VLOG',
        titulo_interno: 'Día en la nube',
        duracion_objetivo_seg: 15,
        cortes: [
          { id: 'cut-1', clip_index: 0, start_sec: 1, end_sec: 8, motivo: 'Inicio', enabled: true },
          { id: 'cut-2', clip_index: 1, start_sec: 3, end_sec: 11, motivo: 'Cierre', enabled: true },
        ],
      },
    },
  });

  assert.equal(cloudManifest.target, 'cloud');
  assert.equal(cloudManifest.status, 'pending');
  assert.equal(cloudManifest.sourceFiles.length, 2);
  assert.equal(cloudManifest.sourceFiles[0].uploadedTempSource, undefined);
  assert.equal(cloudManifest.sourceFiles[1].uploadedTempSource, true);
  assert.equal(cloudManifest.sourceFiles[1].driveFileId, 'drv-temp-2');

  // Verify debugLogger supports 'Nube' category and redacts GitHub PATs
  clearDebugLogs();
  const fakePat = 'github_pat_11ABCDEFG0123456789_secretTokenValueXYZ987654321';
  const fakeClassicPat = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';
  logInfo('Nube', `Disparo fallido con ${fakePat} y ${fakeClassicPat}`, {
    token: fakePat,
    http: 401,
  });
  const logs = getDebugLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].category, 'Nube');
  assert.ok(!logs[0].message.includes('secretTokenValue'));
  assert.ok(!logs[0].message.includes('ghp_1234567890'));
  assert.ok(logs[0].message.includes('[OMITIDO]'));
  clearDebugLogs();
});

test('buildRenderJobManifest preserves cut.words and evaluateHeavyVideoWarning stays silent for cloud render target', () => {
  // Cloud target MUST suppress mobile RAM heavy-video warning even for 4K / 400 MB / 10 min footage
  const cloudWarning = evaluateHeavyVideoWarning({
    sizeBytes: 420 * 1024 * 1024,
    durationSec: 600,
    width: 3840,
    height: 2160,
    renderTarget: 'cloud',
  });
  assert.equal(cloudWarning.isHeavy, false);
  assert.equal(cloudWarning.message, null);

  // Mobile target still warns normally
  const mobileWarning = evaluateHeavyVideoWarning({
    sizeBytes: 420 * 1024 * 1024,
    durationSec: 600,
    width: 3840,
    height: 2160,
    renderTarget: 'mobile',
  });
  assert.equal(mobileWarning.isHeavy, true);
  assert.ok(mobileWarning.message?.includes('720p móvil'));

  // Manifest copies cut.words verbatim while preserving user's edited start/end
  const manifestWithWords = buildRenderJobManifest({
    jobId: 'wordsjob1',
    target: 'cloud',
    exportQuality: 'high_1080p',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    item: {
      id: 'item-words',
      originalName: 'IMG_HDR.MOV',
      driveFileId: 'drv-hdr',
      isMultiClip: false,
      analysis: {
        etiqueta: 'VLOG',
        titulo_interno: 'Prueba palabras',
        duracion_objetivo_seg: 6,
        cortes: [
          {
            id: 'cut-w1',
            clip_index: 0,
            start_sec: 4.5,
            end_sec: 8.2,
            motivo: 'Frase clave',
            enabled: true,
            words: [
              { start: 4.1, end: 4.4, text: 'Antes' },
              { start: 4.6, end: 4.95, text: 'Hola' },
              { start: 5.0, end: 5.45, text: 'mundo!' },
            ],
          },
        ],
      },
    },
  });

  assert.equal(manifestWithWords.cuts.length, 1);
  assert.equal(manifestWithWords.cuts[0].start, 4.5);
  assert.equal(manifestWithWords.cuts[0].end, 8.2);
  assert.deepEqual(manifestWithWords.cuts[0].words, [
    { start: 4.1, end: 4.4, text: 'Antes' },
    { start: 4.6, end: 4.95, text: 'Hola' },
    { start: 5.0, end: 5.45, text: 'mundo!' },
  ]);
  assert.equal(manifestWithWords.kind, 'render');
});

test('Cloud multimodal analysis contract: buildAnalyzeJobManifest, cloudEditPlanToGeminiEditPlan, stage labels, and Whisper model', () => {
  assert.equal(DEFAULT_WHISPER_MODEL, 'small');
  assert.equal(normalizeWhisperModel('medium'), 'medium');
  assert.equal(normalizeWhisperModel('small'), 'small');
  assert.equal(normalizeWhisperModel('large-v3'), 'small');
  assert.equal(getDefaultTargetDurationForPreset('express_summary'), 35);
  assert.equal(getDefaultTargetDurationForPreset('agile_vlog'), 50);
  assert.equal(getDefaultTargetDurationForPreset('funny_jumpcut'), 42);

  assert.equal(formatAnalyzeStageLabel('transcripcion', 'processing', 40), 'Transcribiendo audio (40%)...');
  assert.equal(formatAnalyzeStageLabel('vision', 'processing', 65), 'Gemini viendo el vídeo (65%)...');
  assert.equal(formatAnalyzeStageLabel('guion', 'processing', 85), 'Montando la historia (85%)...');
  assert.equal(formatAnalyzeStageLabel('revision', 'analyzed', 100), 'Historia lista para revisar');

  const analyzeManifest = buildAnalyzeJobManifest({
    jobId: 'ana_test_1',
    createdAt: '2026-11-22T14:00:00.000Z',
    sourceFiles: [
      { name: 'clip1.MOV', driveFileId: 'drv-c1', modifiedTime: '2026-11-22T09:00:00Z' },
      { name: 'clip2.MOV', driveFileId: 'drv-c2', modifiedTime: '2026-11-22T09:05:00Z', uploadedTempSource: true },
    ],
    model: 'gemini-3.8-flash',
    whisperModel: 'medium',
    stylePreset: 'funny_jumpcut',
    customInstruction: 'Prioriza el momento del café',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    queueItemId: 'mc-99',
    projectName: 'Cafe_Asturias',
  });

  assert.equal(analyzeManifest.jobId, 'ana_test_1');
  assert.equal(analyzeManifest.kind, 'analyze');
  assert.equal(analyzeManifest.target, 'cloud');
  assert.equal(analyzeManifest.status, 'pending');
  assert.equal(analyzeManifest.stage, 'descarga');
  assert.equal(analyzeManifest.isMultiClip, true);
  assert.equal(analyzeManifest.options.whisperModel, 'medium');
  assert.equal(analyzeManifest.options.model, 'gemini-3.8-flash');
  assert.equal(analyzeManifest.options.targetDurationSec, 42);
  assert.equal(analyzeManifest.options.customInstruction, 'Prioriza el momento del café');
  assert.equal(analyzeManifest.sourceFiles[1].uploadedTempSource, true);

  const geminiPlan = cloudEditPlanToGeminiEditPlan(
    {
      etiqueta: 'viaje épico',
      titulo: 'Café bajo la lluvia',
      gancho: 'Dije que no llovía… y mira esto.',
      historia: 'Salida soleada, tormenta sorpresa y remate con café caliente.',
      ordenClips: [0, 1],
      cortes: [
        {
          id: 'cloud-1',
          clip_index: 0,
          start_sec: 1.5,
          end_sec: 5.2,
          funcion: 'gancho',
          motivo: 'Promesa inicial',
          puntuacion_interes: 9,
          texto: 'Hoy no cae ni una gota.',
          words: [
            { start: 1.6, end: 1.9, text: 'Hoy' },
            { start: 1.95, end: 2.2, text: 'no' },
          ],
        },
      ],
      guionResultante: 'Hoy no cae ni una gota.',
      duracionTotalSec: 3.7,
      revision: {
        coherente: true,
        notas: ['Buen ritmo narrativo.'],
      },
    },
    { targetDurationSec: 40 }
  );

  assert.equal(geminiPlan.etiqueta, 'VIAJE');
  assert.equal(geminiPlan.titulo_interno, 'Café bajo la lluvia');
  assert.equal(geminiPlan.gancho, 'Dije que no llovía… y mira esto.');
  assert.equal(geminiPlan.historia, 'Salida soleada, tormenta sorpresa y remate con café caliente.');
  assert.equal(geminiPlan.guionResultante, 'Hoy no cae ni una gota.');
  assert.equal(geminiPlan.analysisMode, 'cloud');
  assert.equal(geminiPlan.revision?.coherente, true);
  assert.deepEqual(geminiPlan.revision?.notas, ['Buen ritmo narrativo.']);
  assert.equal(geminiPlan.cortes[0].funcion, 'gancho');
  assert.equal(geminiPlan.cortes[0].texto, 'Hoy no cae ni una gota.');
  assert.equal(geminiPlan.cortes[0].words?.length, 2);

  // PC-targeted analyze manifest and stage label
  const pcAnalyzeManifest = buildAnalyzeJobManifest({
    jobId: 'ana_pc_99',
    target: 'pc',
    sourceFiles: [{ name: 'clip_pc.mov', driveFileId: 'drv-pc-1' }],
    model: 'gemini-3.8-flash',
    whisperModel: 'medium',
    stylePreset: 'agile_vlog',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
  });
  assert.equal(pcAnalyzeManifest.kind, 'analyze');
  assert.equal(pcAnalyzeManifest.target, 'pc');
  assert.equal(
    formatAnalyzeStageLabel('descarga', 'pending', 0, 'pc'),
    'En cola PC (análisis)...'
  );
  assert.equal(
    formatAnalyzeStageLabel('descarga', 'pending', 0, 'cloud'),
    'En cola nube (análisis)...'
  );
});

test('Voz sobre recursos PWA contract: analyze/render manifests carry B-roll options and filter disabled overlays', () => {
  const analyzeWithBroll = buildAnalyzeJobManifest({
    jobId: 'ana_broll_1',
    sourceFiles: [{ name: 'clip1.mp4', driveFileId: 'd1' }],
    model: 'gemini-3.8-flash',
    whisperModel: 'small',
    stylePreset: 'agile_vlog',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    voiceoverBrollEnabled: true,
    brollDensity: 'alta',
    brollSmoothPanEnabled: false,
    brollAmbientAudioEnabled: true,
  });
  assert.equal(analyzeWithBroll.options.voiceoverBrollEnabled, true);
  assert.equal(analyzeWithBroll.options.brollDensity, 'alta');
  assert.equal(analyzeWithBroll.options.brollSmoothPanEnabled, false);
  assert.equal(analyzeWithBroll.options.brollAmbientAudioEnabled, true);

  const geminiFromCloud = cloudEditPlanToGeminiEditPlan({
    etiqueta: 'VIAJE',
    titulo: 'Ruta con recursos',
    gancho: 'Intro gancho',
    historia: 'Resumen breve del viaje.',
    ordenClips: [0, 1],
    duracionTotalSec: 13.0,
    guionResultante: 'Hola. Mira.',
    revision: { coherente: true, notas: [] },
    cortes: [
      { id: 'c1', clip_index: 0, start_sec: 1.0, end_sec: 7.0, funcion: 'gancho', motivo: 'Intro', texto: 'Hola', words: [], puntuacion_interes: 9 },
      { id: 'c2', clip_index: 0, start_sec: 8.0, end_sec: 15.0, funcion: 'desarrollo', motivo: 'Paseo', texto: 'Mira', words: [], puntuacion_interes: 8 },
    ],
    overlays: [
      {
        id: 'ov1',
        anchorCutId: 'c1',
        clip_index: 1,
        start_sec: 2.0,
        end_sec: 4.5,
        offsetSec: 2.0,
        motivo: 'Plano general playa',
        encuadreX: 0.75,
      },
      {
        id: 'ov2',
        anchorCutId: 'c2',
        clip_index: 1,
        start_sec: 5.0,
        end_sec: 7.0,
        offsetSec: 1.0,
        motivo: 'Desactivado en estudio',
        encuadreX: 0.5,
        enabled: false,
      },
    ],
  });

  assert.equal(geminiFromCloud.overlays?.length, 2);
  assert.equal(geminiFromCloud.overlays?.[0].enabled, true);
  assert.equal(geminiFromCloud.overlays?.[1].enabled, false);

  const renderWithBroll = buildRenderJobManifest({
    jobId: 'ren_broll_1',
    target: 'cloud',
    exportQuality: 'high_1080p',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    voiceoverBrollEnabled: true,
    brollDensity: 'media',
    brollSmoothPanEnabled: true,
    brollAmbientAudioEnabled: true,
    item: {
      id: 'item-broll',
      originalName: 'Viaje',
      isMultiClip: true,
      sourceClips: [
        { id: 's0', source: 'drive', driveFileId: 'd0', originalName: 'c0.mov', mimeType: 'video/quicktime', sizeBytes: 1000 },
        { id: 's1', source: 'drive', driveFileId: 'd1', originalName: 'c1.mov', mimeType: 'video/quicktime', sizeBytes: 1000 },
      ],
      analysis: {
        ...geminiFromCloud,
        cortes: geminiFromCloud.cortes.map((c) => ({ ...c, enabled: true })),
      },
    },
  });

  // Disabled overlay ov2 MUST be filtered out; ov1 maps to cutIndex 0
  assert.equal(renderWithBroll.overlays?.length, 1);
  assert.deepEqual(renderWithBroll.overlays?.[0], {
    id: 'ov1',
    anchorCutId: 'c1',
    cutIndex: 0,
    clipIndex: 1,
    start: 2.0,
    end: 4.5,
    offsetSec: 2.0,
    encuadreX: 0.75,
  });
  assert.equal(renderWithBroll.options.voiceoverBrollEnabled, true);
  assert.equal(renderWithBroll.options.brollSmoothPanEnabled, true);
  assert.equal(renderWithBroll.options.brollAmbientAudioEnabled, true);

  // When voiceoverBrollEnabled is false, overlays are omitted completely
  const renderNoBroll = buildRenderJobManifest({
    jobId: 'ren_no_broll',
    exportQuality: 'high_1080p',
    tiktokOptions: {
      subtitlesEnabled: false,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    voiceoverBrollEnabled: false,
    item: {
      id: 'item-no-broll',
      originalName: 'Viaje',
      isMultiClip: false,
      driveFileId: 'd0',
      analysis: {
        ...geminiFromCloud,
        cortes: geminiFromCloud.cortes.map((c) => ({ ...c, enabled: true })),
      },
    },
  });
  assert.equal(renderNoBroll.overlays, undefined);
  assert.equal(renderNoBroll.options.voiceoverBrollEnabled, false);
});

test('SubtitleStyleProfile built-in presets, non-deletable guards, and full job manifest snapshot', () => {
  assert.equal(BUILTIN_SUBTITLE_STYLES.length, 4);
  assert.equal(BUILTIN_SUBTITLE_STYLES[0].id, DEFAULT_SUBTITLE_STYLE_ID);
  assert.equal(isBuiltInSubtitleStyleId('clasico-tiktok'), true);
  assert.equal(isBuiltInSubtitleStyleId('karaoke-amarillo'), true);
  assert.equal(isBuiltInSubtitleStyleId('minimal'), true);
  assert.equal(isBuiltInSubtitleStyleId('caja-negra'), true);
  assert.equal(isBuiltInSubtitleStyleId('mi-perfil-custom'), false);

  assert.equal(hexToAssColor('#FFE500', 1), '&H0000E5FF');
  assert.equal(hexToAssColor('#000000', 0.78), '&H38000000');

  const karaokePreset = BUILTIN_SUBTITLE_STYLES.find((p) => p.id === 'karaoke-amarillo')!;
  const duplicated = duplicateSubtitleStyleProfile(
    karaokePreset,
    BUILTIN_SUBTITLE_STYLES.map((p) => p.id),
    'Mi Karaoke Verde'
  );
  assert.equal(duplicated.id, 'mi-karaoke-verde');
  assert.equal(isBuiltInSubtitleStyleId(duplicated.id), false);
  duplicated.highlightColor = '#22C55E';

  const merged = mergeSubtitleStyleProfiles([duplicated]);
  assert.equal(merged.length, 5);

  const manifest = buildRenderJobManifest({
    jobId: 'job_style_snapshot',
    exportQuality: 'high_1080p',
    tiktokOptions: {
      subtitlesEnabled: true,
      silenceTrimEnabled: true,
      audioNormalizeEnabled: true,
      framingMode: 'center_crop',
    },
    subtitleStyle: duplicated,
    item: {
      id: 'item-style',
      originalName: 'Clip.mp4',
      driveFileId: 'drive-1',
      analysis: {
        etiqueta: 'VLOG',
        titulo_interno: 'Test',
        duracion_objetivo_seg: 10,
        cortes: [{ id: 'c1', clip_index: 0, start_sec: 0, end_sec: 5, motivo: 'Inicio', enabled: true }],
      },
    },
  });

  // Mutate original profile after manifest creation -> manifest snapshot MUST remain untouched
  duplicated.highlightColor = '#FF0000';
  assert.equal(manifest.options.subtitleStyle?.id, 'mi-karaoke-verde');
  assert.equal(manifest.options.subtitleStyle?.highlightColor, '#22C55E');
  assert.equal(manifest.options.subtitleStyle?.highlightMode, 'karaoke');
  assert.equal(manifest.options.subtitleStyle?.popAnimation, true);
});







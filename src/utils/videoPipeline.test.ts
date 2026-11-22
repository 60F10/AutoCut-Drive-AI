import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_FRAME_JPEG_QUALITY,
  AI_FRAME_MAX_COUNT,
  AI_FRAME_MIN_COUNT,
  AI_FRAME_TARGET_WIDTH,
  AI_MAX_JSON_PAYLOAD_BYTES,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_TIKTOK_OPTIONS,
  EDIT_STYLE_PRESETS,
  MOBILE_RAM_WARNING_BYTES,
  RECOMMENDED_GEMINI_MODELS,
  buildAssSubtitles,
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildFfmpegFilterComplex,
  buildGeminiSystemPrompt,
  buildMultiClipFfmpegFilterComplex,
  buildSrtSubtitles,
  calculateSelectedDuration,
  computeFrameTimestamps,
  computeQueueAnalytics,
  computeScaledDimensions,
  detectDefaultExportQuality,
  detectPendingVideos,
  enforceAiPayloadBudget,
  evaluateHeavyVideoWarning,
  exceedsMobileRamThreshold,
  extractDriveFolderId,
  filterEditedCuts,
  formatBytes,
  formatDurationHuman,
  formatPhaseError,
  formatSeconds,
  mergeMultiClipEditPlans,
  normalizeStylePreset,
  normalizeTikTokOptions,
  parseGeminiEditPlan,
  parseHumanReadableApiError,
  remapSubtitlesToFinalTimeline,
  sanitizeEtiqueta,
  sanitizeGeminiModelName,
  toLocalDateKey,
  type ExtractedVideoFrame,
} from './videoPipeline';
import {
  MAX_DEBUG_LOG_ENTRIES,
  buildDiagnosticReport,
  clearDebugLogs,
  getDebugLogStats,
  getDebugLogs,
  logError,
  logInfo,
  sanitizeLogString,
} from '../services/debugLogger';
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




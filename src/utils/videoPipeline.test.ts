import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIKTOK_OPTIONS,
  EDIT_STYLE_PRESETS,
  MOBILE_RAM_WARNING_BYTES,
  buildAssSubtitles,
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildFfmpegFilterComplex,
  buildGeminiSystemPrompt,
  buildMultiClipFfmpegFilterComplex,
  buildSrtSubtitles,
  calculateSelectedDuration,
  computeQueueAnalytics,
  detectDefaultExportQuality,
  detectPendingVideos,
  evaluateHeavyVideoWarning,
  exceedsMobileRamThreshold,
  extractDriveFolderId,
  filterEditedCuts,
  formatBytes,
  formatDurationHuman,
  formatSeconds,
  normalizeStylePreset,
  normalizeTikTokOptions,
  parseGeminiEditPlan,
  remapSubtitlesToFinalTimeline,
  sanitizeEtiqueta,
  toLocalDateKey,
} from './videoPipeline';
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

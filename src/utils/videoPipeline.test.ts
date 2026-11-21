import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDIT_STYLE_PRESETS,
  MOBILE_RAM_WARNING_BYTES,
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildFfmpegFilterComplex,
  buildGeminiSystemPrompt,
  buildMultiClipFfmpegFilterComplex,
  calculateSelectedDuration,
  computeQueueAnalytics,
  detectDefaultExportQuality,
  detectPendingVideos,
  exceedsMobileRamThreshold,
  extractDriveFolderId,
  formatBytes,
  formatDurationHuman,
  formatSeconds,
  normalizeStylePreset,
  parseGeminiEditPlan,
  sanitizeEtiqueta,
  toLocalDateKey,
} from './videoPipeline';
import type { AnalyticsRecord, DriveFileMeta, VideoCut } from '../types';

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
  assert.equal(mobileBuilt.args[mobileBuilt.args.indexOf('-b:a') + 1], '128k');

  const hdBuilt = buildFfmpegFilterComplex(cuts, 'raw.mov', 'out.mp4', true, 'high_1080p');
  assert.equal(hdBuilt.activeCount, 2);
  assert.ok(hdBuilt.filterComplex.includes('scale=1080:1920:force_original_aspect_ratio=decrease'));
  assert.ok(hdBuilt.filterComplex.includes('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1[v0]'));
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-preset') + 1], 'veryfast');
  assert.equal(hdBuilt.args[hdBuilt.args.indexOf('-crf') + 1], '21');
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

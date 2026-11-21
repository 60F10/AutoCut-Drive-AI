import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_RAM_WARNING_BYTES,
  buildCombinedEditedFilename,
  buildEditedFilename,
  buildFfmpegFilterComplex,
  buildMultiClipFfmpegFilterComplex,
  calculateSelectedDuration,
  computeQueueAnalytics,
  detectPendingVideos,
  exceedsMobileRamThreshold,
  extractDriveFolderId,
  formatBytes,
  formatDurationHuman,
  formatSeconds,
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

test('buildFfmpegFilterComplex builds trim/atrim/setpts/concat for enabled cuts only', () => {
  const cuts: VideoCut[] = [
    { id: 'c1', clip_index: 0, start_sec: 0.5, end_sec: 4.2, motivo: 'Gancho', enabled: true },
    { id: 'c2', clip_index: 0, start_sec: 10.0, end_sec: 15.0, motivo: 'Silencio descartado', enabled: false },
    { id: 'c3', clip_index: 0, start_sec: 18.25, end_sec: 23.75, motivo: 'Remate', enabled: true },
  ];

  const built = buildFfmpegFilterComplex(cuts, 'raw.mov', 'out.mp4', true);
  assert.equal(built.activeCount, 2);
  assert.equal(
    built.filterComplex,
    '[0:v]trim=start=0.500:end=4.200,setpts=PTS-STARTPTS[v0];' +
      '[0:a]atrim=start=0.500:end=4.200,asetpts=PTS-STARTPTS[a0];' +
      '[0:v]trim=start=18.250:end=23.750,setpts=PTS-STARTPTS[v1];' +
      '[0:a]atrim=start=18.250:end=23.750,asetpts=PTS-STARTPTS[a1];' +
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'
  );
  assert.ok(built.args.includes('libx264'));
  assert.ok(built.args.includes('aac'));
});

test('buildMultiClipFfmpegFilterComplex references clip_index inputs and normalizes to 1080x1920 30fps yuv420p', () => {
  const cuts: VideoCut[] = [
    { id: 'm1', clip_index: 1, start_sec: 2.0, end_sec: 6.5, motivo: 'Gancho del clip 2', enabled: true },
    { id: 'm2', clip_index: 0, start_sec: 1.0, end_sec: 5.0, motivo: 'Contexto del clip 1', enabled: true },
    { id: 'm3', clip_index: 2, start_sec: 0.5, end_sec: 3.0, motivo: 'Descartado', enabled: false },
  ];

  const built = buildMultiClipFfmpegFilterComplex(
    cuts,
    ['input_0.mov', 'input_1.mp4', 'input_2.webm'],
    'combined.mp4',
    true
  );

  assert.equal(built.activeCount, 2);
  // Preserves Gemini's cross-clip narrative order (clip 1 first, then clip 0)
  assert.ok(built.filterComplex.startsWith('[1:v]trim=start=2.000:end=6.500,setpts=PTS-STARTPTS,scale=1080:1920'));
  assert.ok(built.filterComplex.includes('fps=30,format=yuv420p,setsar=1[v0]'));
  assert.ok(built.filterComplex.includes('[1:a]atrim=start=2.000:end=6.500,asetpts=PTS-STARTPTS'));
  assert.ok(built.filterComplex.includes('[0:v]trim=start=1.000:end=5.000'));
  assert.ok(built.filterComplex.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'));
  assert.deepEqual(built.args.slice(0, 6), ['-i', 'input_0.mov', '-i', 'input_1.mp4', '-i', 'input_2.webm']);
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

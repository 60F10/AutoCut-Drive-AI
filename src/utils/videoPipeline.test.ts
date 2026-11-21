import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEditedFilename,
  buildFfmpegFilterComplex,
  calculateSelectedDuration,
  detectPendingVideos,
  extractDriveFolderId,
  formatBytes,
  formatSeconds,
  parseGeminiEditPlan,
  sanitizeEtiqueta,
} from './videoPipeline';
import type { DriveFileMeta, VideoCut } from '../types';

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

test('buildEditedFilename follows {nombreOriginalSinExtension}_EDITADO_{etiqueta}.mp4', () => {
  assert.equal(
    buildEditedFilename('IMG_4821.MOV', 'batido'),
    'IMG_4821_EDITADO_BATIDO.mp4'
  );
  assert.equal(
    buildEditedFilename('mi.video.cocina.mp4', 'recéta'),
    'mi.video.cocina_EDITADO_RECETA.mp4'
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
    { id: 'c1', start_sec: 0.5, end_sec: 4.2, motivo: 'Gancho', enabled: true },
    { id: 'c2', start_sec: 10.0, end_sec: 15.0, motivo: 'Silencio descartado', enabled: false },
    { id: 'c3', start_sec: 18.25, end_sec: 23.75, motivo: 'Remate', enabled: true },
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

test('parseGeminiEditPlan sanitizes tag, sorts cuts, and removes overlaps', () => {
  const rawJson = JSON.stringify({
    etiqueta: 'cocína casera',
    titulo_interno: 'El batido explota en la encimera',
    duracion_objetivo_seg: 32,
    cortes: [
      { start_sec: 12.0, end_sec: 16.5, motivo: 'Reacción final' },
      { start_sec: 1.2, end_sec: 5.5, motivo: 'Intro rápida' },
      { start_sec: 5.0, end_sec: 9.0, motivo: 'Se cae la tapa' },
    ],
  });

  const plan = parseGeminiEditPlan(rawJson);
  assert.equal(plan.etiqueta, 'COCINA');
  assert.equal(plan.cortes.length, 3);
  assert.equal(plan.cortes[0].start_sec, 1.2);
  assert.equal(plan.cortes[1].start_sec, 5.5); // overlap clamped cleanly
  assert.equal(calculateSelectedDuration(plan.cortes), 12.3);
});

test('formatSeconds and formatBytes produce clean deterministic labels', () => {
  assert.equal(formatSeconds(65.4), '1:05.4');
  assert.equal(formatSeconds(4.2), '0:04.2');
  assert.equal(formatSeconds(1.2), '0:01.2');
  assert.equal(formatSeconds(5.8), '0:05.8');
  assert.equal(formatSeconds(38.9), '0:38.9');
  assert.equal(formatSeconds(59.96), '1:00.0');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(26214400), '25.0 MB');
});

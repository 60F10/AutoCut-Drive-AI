import type { QueueItem } from '../types';
import { buildEditedFilename } from './videoPipeline';

export function createDemoQueueItems(): QueueItem[] {
  const now = Date.now();

  const smoothiePlan = {
    etiqueta: 'COCINA',
    titulo_interno: 'El batido de plátano que casi explota en toda la cocina',
    duracion_objetivo_seg: 30,
    cortes: [
      {
        id: 'demo-cut-1',
        start_sec: 1.2,
        end_sec: 5.8,
        motivo: 'Gancho inicial rápido enseñando el plátano y prometiendo el mejor batido en 10 segundos',
        enabled: true,
      },
      {
        id: 'demo-cut-2',
        start_sec: 14.4,
        end_sec: 19.6,
        motivo: 'Comentario espontáneo mientras cae media bolsa de avena fuera del vaso',
        enabled: true,
      },
      {
        id: 'demo-cut-3',
        start_sec: 32.1,
        end_sec: 38.9,
        motivo: 'Momento fail: enciende la batidora sin encajar bien la tapa y pega un salto',
        enabled: true,
      },
      {
        id: 'demo-cut-4',
        start_sec: 54.0,
        end_sec: 61.5,
        motivo: 'Risa incrédula limpiando la salpicadura de la cámara y queja cómica',
        enabled: true,
      },
      {
        id: 'demo-cut-5',
        start_sec: 78.3,
        end_sec: 84.1,
        motivo: 'Remate final probando el batido con cara seria: "Bueno, al menos está brutal"',
        enabled: true,
      },
    ],
  };

  return [
    {
      id: 'demo-smoothie-01',
      source: 'demo',
      originalName: 'IMG_4821_batido_platano.MOV',
      mimeType: 'video/quicktime',
      sizeBytes: 48_600_000,
      durationSec: 94.5,
      modifiedTime: new Date(now - 1000 * 60 * 14).toISOString(),
      stage: 'completed',
      stageDetail: 'Renderizado con 5 jump cuts y listo para revisar',
      progress: 100,
      outputFileName: buildEditedFilename('IMG_4821_batido_platano.MOV', smoothiePlan.etiqueta),
      geminiFileCleaned: true,
      analysis: smoothiePlan,
      lastUpdated: now - 1000 * 60 * 12,
    },
    {
      id: 'demo-car-02',
      source: 'demo',
      originalName: 'vlog_arranque_coche_frio.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 72_400_000,
      durationSec: 162.0,
      modifiedTime: new Date(now - 1000 * 60 * 4).toISOString(),
      stage: 'pending',
      stageDetail: 'Detectado sin versión _EDITADO en la carpeta',
      progress: 0,
      lastUpdated: now - 1000 * 60 * 4,
    },
  ];
}

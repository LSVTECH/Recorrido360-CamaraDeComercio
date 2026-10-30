// Arranque del recorrido virtual.
import { Tour } from './core.js';
import { UI } from './ui.js';
import { PanoViewer } from './pano.js';
import { Player } from './player.js';
import { VR } from './vr.js';
import { initOffline } from './offline.js';

async function start() {
  const preload = document.getElementById('preload');
  let data;
  try {
    data = await fetch('data/tour.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch (e) {
    preload.querySelector('span').textContent = location.protocol === 'file:'
      ? 'Abre el recorrido desde un servidor web (ver LEEME.md): los navegadores bloquean WebGL con file://'
      : 'No se pudo cargar el recorrido.';
    throw e;
  }

  const tour = new Tour(data);
  const ui = new UI(tour, document.getElementById('viewer'));
  ui.build();

  const mainViewer = tour.byId('MainViewer');
  const viewer = new PanoViewer(mainViewer.el, tour, {
    // clic en un hotspot: se disparan las acciones de sus áreas (igual que 3DVista)
    onHotspotClick: overlay => {
      for (const a of overlay.get('areas') || []) a?.trigger('click');
      overlay.trigger('click');
    }
  });
  const player = new Player(tour, ui, viewer);
  const vr = new VR(tour, player, viewer, ui);
  player.vr = vr;

  // Script de inicio del proyecto (audio de fondo, visibilidad inicial de la interfaz...)
  tour.run(tour.root.raw.start || '', tour.root);

  // Primer panorama
  const main = tour.byId('mainPlayList');
  const first = new Promise(res => tour.bind('panoloaded', res));
  player.select(main, player._startIndex ?? 0);
  await Promise.race([first, new Promise(r => setTimeout(r, 8000))]);
  preload.classList.add('hidden');
  setTimeout(() => preload.remove(), 600);

  initOffline({ enabled: data.downloadEnabled !== false, version: data.hash || '1' });

  // Acceso para depuración desde la consola
  window.recorrido = { tour, ui, viewer, player, vr };
}

start();

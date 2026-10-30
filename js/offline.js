// Descarga del tour para verlo sin conexión (equivalente al "Descargar" de 3DVista).
// Guarda todos los archivos de data/files.json en la Cache Storage; el service worker (sw.js) los sirve offline.
export const CACHE = 'tour-camara-comercio-v1';
const DONE_KEY = 'tour-offline-done';

const fmt = b => b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB';

export function initOffline({ enabled, version }) {
  const bar = document.getElementById('download-bar');
  const supported = 'serviceWorker' in navigator && 'caches' in window && location.protocol !== 'file:';
  if (!supported) return;
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker no registrado', e));
  if (!enabled || !bar) return;

  const text = bar.querySelector('.dl-text');
  const btn = bar.querySelector('.dl-btn');
  const closeBtn = bar.querySelector('.dl-close');
  const progress = bar.querySelector('.dl-progress');
  const fill = bar.querySelector('.dl-fill');
  let abort = null;

  const show = () => { bar.hidden = false; document.body.classList.add('has-download-bar'); window.dispatchEvent(new Event('resize')); };
  const hide = () => { bar.hidden = true; document.body.classList.remove('has-download-bar'); window.dispatchEvent(new Event('resize')); };

  let done = null;
  try { done = localStorage.getItem(DONE_KEY); } catch {}
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('tour-offline-dismissed') === '1'; } catch {}
  if (done === version || dismissed) return;
  show();

  closeBtn.addEventListener('click', () => {
    if (abort) abort.cancelled = true;
    try { sessionStorage.setItem('tour-offline-dismissed', '1'); } catch {}
    hide();
  });

  btn.addEventListener('click', async () => {
    if (abort) { abort.cancelled = true; return; }
    abort = { cancelled: false };
    const state = abort;
    btn.textContent = 'Cancelar';
    progress.hidden = false;
    text.textContent = 'Preparando descarga…';
    try {
      try { await navigator.storage?.persist?.(); } catch {}
      const list = await fetch('data/files.json', { cache: 'no-cache' }).then(r => r.json());
      const entries = Object.entries(list);
      entries.push(['./', 0], ['data/files.json', 0]);
      const total = entries.reduce((s, [, n]) => s + (n || 0), 0);
      const est = await navigator.storage?.estimate?.();
      if (est && est.quota && est.quota - (est.usage || 0) < total) {
        text.textContent = `No hay espacio suficiente en el navegador (se necesitan ${fmt(total)}).`;
        btn.textContent = 'Descargar'; abort = null; return;
      }
      const cache = await caches.open(CACHE);
      let doneBytes = 0, doneFiles = 0, errors = 0, i = 0;
      const update = () => {
        const k = total ? doneBytes / total : doneFiles / entries.length;
        fill.style.width = (k * 100).toFixed(1) + '%';
        text.textContent = `Descargando ${(k * 100).toFixed(0)}%  (${fmt(doneBytes)} de ${fmt(total)})`;
      };
      const worker = async () => {
        while (i < entries.length && !state.cancelled) {
          const [path, size] = entries[i++];
          try {
            if (!(await cache.match(path, { ignoreSearch: true }))) {
              let res = await fetch(path, { cache: 'no-cache' });
              if (!res.ok) res = await fetch(path, { cache: 'reload' });
              if (!res.ok) throw new Error(res.status);
              await cache.put(path, res);
            }
          } catch { errors++; }
          doneBytes += size || 0; doneFiles++;
          if (doneFiles % 20 === 0) update();
        }
      };
      await Promise.all(Array.from({ length: 12 }, worker));
      update();
      if (state.cancelled) { text.textContent = 'Descarga cancelada. Puedes reanudarla cuando quieras.'; btn.textContent = 'Reanudar'; abort = null; return; }
      if (errors) {
        text.textContent = `Descarga incompleta: ${errors} archivos fallaron. Pulsa para reintentar.`;
        btn.textContent = 'Reintentar'; abort = null; return;
      }
      try { localStorage.setItem(DONE_KEY, version); } catch {}
      text.textContent = 'Tour descargado. Ya puedes verlo sin conexión.';
      btn.hidden = true;
      setTimeout(hide, 4000);
    } catch (e) {
      console.warn(e);
      text.textContent = 'No se pudo descargar el tour. Revisa tu conexión e inténtalo de nuevo.';
      btn.textContent = 'Reintentar';
    }
    abort = null;
  });
}

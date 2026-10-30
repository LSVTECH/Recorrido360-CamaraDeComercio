// Service worker: sirve el tour descargado cuando no hay conexión.
// - Imágenes, videos y librerías (inmutables): primero caché, luego red.
// - Resto (html, js, datos): primero red, si falla, caché.
// - Soporta peticiones "Range" para que los videos se reproduzcan offline (Safari/iOS las exige).
const CACHE = 'tour-camara-comercio-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Los videos se cortan como Blob (respaldado en disco): no se copia el archivo entero a memoria
// en cada petición, algo que en Meta Quest hacía fallar la reproducción sin conexión.
async function rangeResponse(req, res) {
  const range = req.headers.get('range');
  if (!range || !res || res.status !== 200) return res;
  const blob = await res.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const size = blob.size;
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
  end = Math.min(end, size - 1);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const immutable = /\/(media|skin|lib|misc)\//.test(url.pathname);
  if (immutable) {
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
      if (cached) return req.headers.has('range') ? rangeResponse(req, cached) : cached;
      try { return await fetch(req); }
      catch (err) {
        // Sin conexión y el archivo no está guardado: respuesta clara en vez de un error de red opaco
        return new Response('Archivo no descargado para uso sin conexión', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    try { return await fetch(req); }
    catch (err) {
      let cached = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
      if (!cached && req.mode === 'navigate') cached = (await caches.match('./')) || (await caches.match('index.html'));
      if (cached) return cached;
      throw err;
    }
  })());
});

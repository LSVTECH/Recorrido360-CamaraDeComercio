// Visor de panoramas cúbicos en WebGL (Three.js): mosaicos multinivel, hotspots y controles.
import * as THREE from '../lib/three.module.min.js';
import { deg, clamp, bestLevel, isMobile } from './core.js';

// Orientación de las caras del cubo (convención 3DVista: f, r, b, l, u, d)
// dir = centro de la cara, right/up = ejes de la imagen vistos desde dentro.
const FACES = {
  f: { dir: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
  r: { dir: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
  b: { dir: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0] },
  l: { dir: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },
  u: { dir: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  d: { dir: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1] }
};
const CUBE_R = 10;      // semilado del cubo
const HS_R = 5;         // radio donde se dibujan los hotspots

export function dirFromYawPitch(yaw, pitch, r = 1) {
  const y = yaw * deg, p = pitch * deg;
  return new THREE.Vector3(Math.sin(y) * Math.cos(p) * r, Math.sin(p) * r, -Math.cos(y) * Math.cos(p) * r);
}
export function yawPitchFromDir(v) {
  const n = v.clone().normalize();
  return { yaw: Math.atan2(n.x, -n.z) / deg, pitch: Math.asin(clamp(n.y, -1, 1)) / deg };
}

// ---------- Carga de texturas con cola y prioridad ----------
class TextureQueue {
  constructor(renderer, max = 8) { this.renderer = renderer; this.max = max; this.active = 0; this.q = []; this.cache = new Map(); }
  load(url, priority = 0) {
    let e = this.cache.get(url);
    if (e) { e.priority = Math.max(e.priority, priority); return e.promise; }
    e = { url, priority };
    e.promise = new Promise((res, rej) => { e.res = res; e.rej = rej; });
    this.cache.set(url, e);
    this.q.push(e);
    this._pump();
    return e.promise;
  }
  _pump() {
    while (this.active < this.max && this.q.length) {
      this.q.sort((a, b) => b.priority - a.priority);
      const e = this.q.shift();
      this.active++;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
        t.needsUpdate = true;
        e.texture = t;
        e.res(t);
        this.active--; this._pump();
      };
      img.onerror = () => { e.rej(new Error('No se pudo cargar ' + e.url)); this.active--; this.cache.delete(e.url); this._pump(); };
      img.src = e.url;
    }
  }
  release(url) {
    const e = this.cache.get(url);
    if (e?.texture) { e.texture.dispose(); this.cache.delete(url); }
    else if (e) { const i = this.q.indexOf(e); if (i >= 0) { this.q.splice(i, 1); this.cache.delete(url); } }
  }
}

// ---------- Un panorama cargado: caras por niveles + hotspots ----------
class PanoNode {
  constructor(viewer, pano) {
    this.viewer = viewer;
    this.pano = pano;
    this.group = new THREE.Group();
    this.tiles = [];           // todas las baldosas creadas {mesh, url, level, loaded}
    this.levels = [];
    this.hotspots = [];        // {mesh, overlay, item, anim}
    this.urls = new Set();
    const frame = pano.get('frames')?.[0];
    const cube = frame?.get ? frame.get('cube') : null;
    const levelsRaw = (cube?.raw?.levels || []).filter(l => l && l.url);
    // Ordenar de menor a mayor resolución
    this.levels = levelsRaw.map(l => ({
      url: l.url, faceSize: l.height, n: Math.max(1, Math.round(l.colCount / 6)), rows: l.rowCount,
      preload: [].concat(l.tags || []).includes('preload'), built: false, tiles: []
    })).sort((a, b) => a.faceSize - b.faceSize);
    this.baseLevel = this.levels.find(l => l.preload) || this.levels[0];
  }
  tileUrl(level, face, row, col) {
    return level.url.replace('{face}', face).replace('{row}', row).replace('{column}', col);
  }
  buildLevel(li) {
    const level = this.levels[li];
    if (level.built) return;
    level.built = true;
    const n = level.n;
    for (const face of Object.keys(FACES)) {
      const F = FACES[face];
      const dir = new THREE.Vector3(...F.dir).multiplyScalar(CUBE_R);
      const right = new THREE.Vector3(...F.right).multiplyScalar(CUBE_R);
      const up = new THREE.Vector3(...F.up).multiplyScalar(CUBE_R);
      for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
        const u0 = -1 + 2 * col / n, u1 = -1 + 2 * (col + 1) / n;
        const v0 = 1 - 2 * row / n, v1 = 1 - 2 * (row + 1) / n; // fila 0 arriba
        const p = (u, v) => dir.clone().addScaledVector(right, u).addScaledVector(up, v);
        const a = p(u0, v0), b = p(u1, v0), c = p(u1, v1), d = p(u0, v1);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()], 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
        g.setIndex([0, 3, 1, 1, 3, 2]);
        g.computeBoundingSphere();
        const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 0 });
        const mesh = new THREE.Mesh(g, m);
        mesh.renderOrder = li;
        mesh.visible = false;
        mesh.frustumCulled = false;
        const tile = { mesh, url: this.tileUrl(level, face, row, col), li, loaded: false, loading: false, box: new THREE.Box3().setFromPoints([a, b, c, d]) };
        level.tiles.push(tile);
        this.tiles.push(tile);
        this.group.add(mesh);
      }
    }
  }
  loadTile(tile, priority) {
    if (tile.loaded || tile.loading) return tile.promise;
    tile.loading = true;
    this.urls.add(tile.url);
    tile.promise = this.viewer.textures.load(tile.url, priority).then(t => {
      if (this.disposed) return;
      tile.mesh.material.map = t;
      tile.mesh.material.opacity = 1;
      tile.mesh.material.transparent = false;
      tile.mesh.material.needsUpdate = true;
      tile.mesh.visible = true;
      tile.loaded = true;
      this.viewer.dirty = true;
    }).catch(() => { tile.loading = false; });
    return tile.promise;
  }
  // Carga el nivel base completo (6 caras) — necesario antes de mostrar.
  loadBase() {
    const li = this.levels.indexOf(this.baseLevel);
    this.buildLevel(li);
    return Promise.all(this.baseLevel.tiles.map(t => this.loadTile(t, 100)));
  }
  // Carga los mosaicos visibles del nivel que corresponde a la resolución en pantalla.
  update(camera, pxPerDeg) {
    if (!this.levels.length) return;
    let li = 0;
    for (let i = 0; i < this.levels.length; i++) { li = i; if (this.levels[i].faceSize / 90 >= pxPerDeg) break; }
    const baseLi = this.levels.indexOf(this.baseLevel);
    if (li <= baseLi) return;
    // Asegurar niveles intermedios también (así se evita ver píxeles mientras carga)
    const frustum = this.viewer.frustum;
    for (let i = baseLi + 1; i <= li; i++) {
      this.buildLevel(i);
      for (const t of this.levels[i].tiles) {
        if (!t.loaded && !t.loading && frustum.intersectsBox(t.box)) {
          const center = t.box.getCenter(new THREE.Vector3()).normalize();
          const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
          this.loadTile(t, i * 10 + center.dot(look));
        }
      }
    }
  }
  setOpacity(o) {
    for (const t of this.tiles) if (t.loaded) { t.mesh.material.opacity = o; t.mesh.material.transparent = o < 1; }
    for (const h of this.hotspots) h.setFade(o);
  }
  setRenderOffset(off) {
    for (const t of this.tiles) t.mesh.renderOrder = t.li + off;
    for (const h of this.hotspots) h.mesh.renderOrder = h.baseOrder + off;
  }
  dispose() {
    this.disposed = true;
    for (const t of this.tiles) { t.mesh.geometry.dispose(); t.mesh.material.dispose(); }
    for (const h of this.hotspots) h.dispose();
    for (const u of this.urls) this.viewer.textures.release(u);
    this.group.removeFromParent();
  }
}

// ---------- Hotspot (imagen plana, cuadrilátero o animada) ----------
function quadHomography(p) { // cuadrado unidad -> cuadrilátero (Heckbert)
  const [x0, y0] = p[0], [x1, y1] = p[1], [x2, y2] = p[2], [x3, y3] = p[3];
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det; h = (dx1 * sy - sx * dy1) / det;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}

class Hotspot {
  constructor(viewer, node, overlay, item) {
    this.viewer = viewer; this.node = node; this.overlay = overlay; this.item = item;
    const raw = item.raw;
    const img = item.get('image');
    const imgRaw = img?.raw || img;
    this.anim = imgRaw?.class === 'AnimatedImageResource' ? imgRaw : null;
    const level = bestLevel(imgRaw, isMobile ? 2048 : 4096);
    this.url = level?.url;
    const fw = level ? level.width / (this.anim?.colCount || 1) : 1;
    const fh = level ? level.height / (this.anim?.rowCount || 1) : 1;
    this.material = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
    const dist = raw.distance ?? 100;
    this.baseOrder = 200 + Math.round(1000 - dist);
    let geom;
    if (raw.class === 'QuadHotspotPanoramaOverlayImage') {
      const dirs = (raw.vertices || []).map(v => dirFromYawPitch(v.yaw, v.pitch));
      const c = dirs.reduce((s, v) => s.add(v), new THREE.Vector3()).normalize();
      const e1 = new THREE.Vector3().crossVectors(c, Math.abs(c.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)).normalize();
      const e2 = new THREE.Vector3().crossVectors(e1, c).normalize();
      const pts2 = dirs.map(d => { const p = d.clone().divideScalar(d.dot(c)); return [p.dot(e1), p.dot(e2)]; });
      const H = quadHomography(pts2);
      const S = 16, pos = [], uv = [], idx = [];
      for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
        const [x, y] = H(i / S, j / S);
        const p = c.clone().addScaledVector(e1, x).addScaledVector(e2, y).normalize().multiplyScalar(HS_R);
        pos.push(p.x, p.y, p.z); uv.push(i / S, 1 - j / S);
      }
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const a = j * (S + 1) + i, b = a + 1, d = a + S + 1, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
      geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geom.setIndex(idx);
      this.mesh = new THREE.Mesh(geom, this.material);
    } else {
      const hf = raw.hfov ?? 10, vf = raw.vfov ?? hf;
      let w = 2 * Math.tan(hf * deg / 2), h = 2 * Math.tan(vf * deg / 2);
      const aspect = fw / fh;
      const mode = raw.scaleMode || 'fit_inside';
      if (mode === 'fit_inside') { if (aspect > w / h) h = w / aspect; else w = h * aspect; }
      else if (mode === 'fit_outside') { if (aspect > w / h) w = h * aspect; else h = w / aspect; }
      geom = new THREE.PlaneGeometry(w * HS_R, h * HS_R);
      this.mesh = new THREE.Mesh(geom, this.material);
      this.mesh.position.copy(dirFromYawPitch(raw.yaw || 0, raw.pitch || 0, HS_R));
      this.mesh.lookAt(0, 0, 0);            // la cara frontal (+Z) mira hacia el centro
      if (raw.roll) this.mesh.rotateZ(-raw.roll * deg);
      if (raw.rotationY) this.mesh.rotateY(-raw.rotationY * deg);
      if (raw.rotationX) this.mesh.rotateX(raw.rotationX * deg);
    }
    this.mesh.renderOrder = this.baseOrder;
    this.mesh.frustumCulled = false;
    this.mesh.userData.hotspot = this;
    this.hover = false;
    this.fade = 1;
    if (this.url) {
      this.node.urls.add(this.url);
      viewer.textures.load(this.url, 50).then(t => {
        if (this.disposed) return;
        let tex = t;
        if (this.anim) {
          tex = t.clone(); tex.needsUpdate = true;
          tex.repeat.set(1 / this.anim.colCount, 1 / this.anim.rowCount);
          this.setFrame(tex, 0);
        }
        this.texture = tex;
        this.material.map = tex;
        this.material.needsUpdate = true;
        this.ready = true;
        this.refresh();
      }).catch(() => {});
    }
    this.start = performance.now();
  }
  setFrame(tex, f) {
    const a = this.anim;
    const col = f % a.colCount, row = Math.floor(f / a.colCount);
    tex.offset.set(col / a.colCount, 1 - (row + 1) / a.rowCount);
  }
  tick(now) {
    if (!this.anim || !this.texture || !this.mesh.visible) return false;
    const f = Math.floor((now - this.start) / (this.anim.frameDuration || 41)) % (this.anim.frameCount || 1);
    if (f !== this.frame) { this.frame = f; this.setFrame(this.texture, f); return true; }
    return false;
  }
  isEnabled() {
    const o = this.overlay.raw;
    const vr = this.viewer.vrActive;
    if (o.enabled === false) return false;
    if (vr && o.enabledInVR !== true) return false;   // en VR solo los marcados explícitamente
    if (!vr && o.enabledInStandard === false) return false;
    if (this.viewer.hotspotsEnabled === false) return false;
    return true;
  }
  refresh() {
    const on = this.isEnabled();
    const rollOver = this.overlay.raw.rollOverDisplay;
    this.mesh.visible = on;
    this.material.opacity = this.ready ? (rollOver && !this.hover ? 0 : 1) * this.fade : 0;
    this.viewer.dirty = true;
  }
  hasAction() {
    const o = this.overlay.raw;
    if (o.click) return true;
    return (this.overlay.get('areas') || []).some(a => a && typeof a.raw.click === 'string' && a.raw.click.trim());
  }
  setFade(f) { this.fade = f; this.refresh(); }
  setHover(h) { if (this.hover !== h) { this.hover = h; this.refresh(); } }
  dispose() { this.disposed = true; this.mesh.geometry.dispose(); this.material.dispose(); if (this.texture && this.anim) this.texture.dispose(); this.mesh.removeFromParent(); }
}

// ---------- Visor principal ----------
export class PanoViewer {
  constructor(container, tour, opts = {}) {
    this.tour = tour;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.className = 'pano-canvas';
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.world = new THREE.Group();          // rotación base (se usa en VR)
    this.scene.add(this.world);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
    this.camera.rotation.order = 'YXZ';
    this.textures = new TextureQueue(this.renderer);
    this.frustum = new THREE.Frustum();
    this.raycaster = new THREE.Raycaster();
    this.yaw = 0; this.pitch = 0; this.hfov = 110;
    this.hfovMin = 30; this.hfovMax = 130;
    this.vel = { yaw: 0, pitch: 0 };
    this.node = null; this.oldNodes = [];
    this.hotspotsEnabled = true;
    this.vrActive = false;
    this.dirty = true;
    this.overlays3D = [];     // objetos extra (popups de video, paneles VR)
    this.onHotspotClick = opts.onHotspotClick || (() => {});
    this._bindControls();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.setAnimationLoop(t => this._frame(t));
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.width = w; this.height = h;
    this.dirty = true;
  }

  // hfov de 3DVista: horizontal en horizontal; en vertical (retrato) se aplica al eje vertical.
  _applyCamera() {
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    let vfov;
    if (aspect >= 1) vfov = 2 * Math.atan(Math.tan(this.hfov * deg / 2) / aspect) / deg;
    else vfov = 2 * Math.atan(Math.tan(this.hfov * deg / 2) * (1 + aspect) / 2) / deg; // retrato (medido contra 3DVista)
    this.camera.fov = clamp(vfov, 1, 170);
    this.camera.updateProjectionMatrix();
    if (!this.renderer.xr.isPresenting) {
      this.camera.rotation.set(this.pitch * deg, -this.yaw * deg, 0);
    }
    this.camera.updateMatrixWorld();
  }
  get horizontalFov() {
    const aspect = this.width / this.height;
    return aspect >= 1 ? this.hfov : 2 * Math.atan(Math.tan(this.hfov * deg / 2) * (1 + aspect) / 2 * aspect) / deg;
  }

  // Carga un panorama con posición de cámara inicial.
  async load(pano, cam = {}) {
    const token = (this._token = (this._token || 0) + 1);
    const node = new PanoNode(this, pano);
    const maxFace = Math.max(...node.levels.map(l => l.faceSize), 512);
    const hfovMinRaw = pano.raw.hfovMin;
    const hfovMax = typeof pano.raw.hfovMax === 'number' ? pano.raw.hfovMax : 130;
    let hfovMin = 30;
    if (typeof hfovMinRaw === 'string' && hfovMinRaw.endsWith('%')) {
      const f = parseFloat(hfovMinRaw) / 100;
      hfovMin = 90 * (this.width * this.renderer.getPixelRatio()) / (maxFace * f);
    } else if (typeof hfovMinRaw === 'number') hfovMin = hfovMinRaw;
    try { await node.loadBase(); } catch (e) { console.warn(e); }
    if (token !== this._token) { node.dispose(); return false; }
    this._buildHotspots(node);
    // transición: el panorama anterior se desvanece por encima del nuevo
    const prev = this.node;
    this.node = node;
    node.setRenderOffset(0);
    this.world.add(node.group);
    if (prev) {
      prev.setRenderOffset(5000);
      prev.fadeStart = performance.now();
      this.oldNodes.push(prev);
    }
    this.hfovMin = clamp(Math.min(hfovMin, hfovMax), 5, 120);
    this.hfovMax = hfovMax;
    if (cam.yaw !== undefined) this.yaw = cam.yaw;
    if (cam.pitch !== undefined) this.pitch = cam.pitch;
    this.hfov = clamp(cam.hfov ?? this.hfov ?? 110, this.hfovMin, this.hfovMax);
    this.vel.yaw = this.vel.pitch = 0;
    this.dirty = true;
    return true;
  }

  _buildHotspots(node) {
    const overlays = node.pano.get('overlays') || [];
    for (const ov of overlays) {
      if (!ov || ov.raw.class !== 'HotspotPanoramaOverlay') continue;
      for (const item of ov.get('items') || []) {
        if (!item) continue;
        const h = new Hotspot(this, node, ov, item);
        node.hotspots.push(h);
        node.group.add(h.mesh);
        h.refresh();
      }
    }
  }
  refreshHotspots() { if (this.node) for (const h of this.node.hotspots) h.refresh(); }
  setHotspotsEnabled(v) { this.hotspotsEnabled = v; this.refreshHotspots(); }

  // ---------- Selección (ratón / VR) ----------
  pick(ndcX, ndcY, cam = this.camera) {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
    return this.pickRay(this.raycaster.ray);
  }
  pickAll(ray) {
    this.raycaster.ray.copy(ray);
    const targets = [];
    for (const o of this.overlays3D) if (o.visible !== false && o.pickable?.parent) targets.push(o.pickable);
    if (this.node) for (const h of this.node.hotspots) if (h.mesh.visible) targets.push(h.mesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    // primero los objetos 3D extra (paneles), luego hotspots por orden de dibujo
    hits.sort((a, b) => (b.object.renderOrder - a.object.renderOrder) || (a.distance - b.distance));
    return hits;
  }
  // Devuelve el primer impacto "accionable" (panel, video o hotspot con acción de clic)
  pickRay(ray) {
    const hits = this.pickAll(ray);
    for (const h of hits) {
      if (h.object.userData.blocker) return null;   // velo de un panel VR: bloquea lo de detrás
      if (h.object.userData.onClick) return h;
      const hs = h.object.userData.hotspot;
      if (hs && hs.hasAction()) return h;
    }
    return null;
  }
  clickHit(hit) {
    if (!hit) return false;
    const o = hit.object;
    if (o.userData.onClick) { o.userData.onClick(hit); return true; }
    const hs = o.userData.hotspot;
    if (hs) { this.onHotspotClick(hs.overlay, hs); return true; }
    return false;
  }

  // ---------- Controles: arrastre, inercia, rueda, pellizco, teclado, giroscopio ----------
  _bindControls() {
    const el = this.renderer.domElement;
    const pointers = new Map();
    let down = null, pinch = null, moved = false;
    el.addEventListener('pointerdown', e => {
      if (this.vrActive && this.vrMode !== 'preview') return;
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { down = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = false; this.vel.yaw = this.vel.pitch = 0; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), hfov: this.hfov }; }
    });
    el.addEventListener('pointermove', e => {
      const p = pointers.get(e.pointerId);
      if (!p) { this._hover(e); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.hfov = clamp(pinch.hfov * pinch.d / d, this.hfovMin, this.hfovMax); this.dirty = true;
        moved = true; return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) moved = true;
      if (this.gyro?.enabled) { this.gyro.offset -= dx * this.horizontalFov / this.width; this.dirty = true; return; }
      const k = this.horizontalFov / this.width;
      this.yaw -= dx * k; this.pitch += dy * k;
      this.vel.yaw = -dx * k; this.vel.pitch = dy * k;
      this._lastMove = performance.now();
      this.dirty = true;
    });
    const end = e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        if (performance.now() - (this._lastMove || 0) > 60) this.vel.yaw = this.vel.pitch = 0;
        if (!moved && e.type === 'pointerup') {
          const r = el.getBoundingClientRect();
          const hit = this.pick(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
          this.clickHit(hit);
        }
        down = null;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { for (const h of this._hoveredSet || []) h.setHover(false); this._hoveredSet = null; });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.hfov = clamp(this.hfov * Math.exp(e.deltaY * 0.0012), this.hfovMin, this.hfovMax);
      this.dirty = true;
    }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
    this.keys = new Set();
    window.addEventListener('keydown', e => {
      if (e.target.closest?.('input,textarea')) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '=', '_'].includes(e.key)) { this.keys.add(e.key); }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }
  _hover(e) {
    if (this.vrActive && this.vrMode !== 'preview') return;
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hits = this.pickAll(this.raycaster.ray);
    // todos los hotspots bajo el puntero se activan (los "rollOverDisplay" aparecen al pasar por encima)
    const now = new Set(hits.map(h => h.object.userData.hotspot).filter(Boolean));
    for (const h of this._hoveredSet || []) if (!now.has(h)) h.setHover(false);
    for (const h of now) h.setHover(true);
    this._hoveredSet = now;
    const top = this.pickRay(this.raycaster.ray);
    const hs = top?.object.userData.hotspot;
    const clickable = top && (top.object.userData.onClick || (hs && hs.overlay.raw.useHandCursor !== false));
    el.style.cursor = clickable ? 'pointer' : '';
  }

  // Giroscopio (DeviceOrientation) — usado en móvil y en modo cardboard
  async enableGyro(on) {
    if (on) {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false; } catch { return false; }
      }
      if (!this.gyro) {
        this.gyro = { enabled: false, offset: 0, q: null };
        window.addEventListener('deviceorientation', e => {
          if (e.alpha == null) return;
          const zee = new THREE.Vector3(0, 0, 1), euler = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
          const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * deg;
          euler.set(e.beta * deg, e.alpha * deg, -e.gamma * deg, 'YXZ');
          const q = new THREE.Quaternion().setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -orient));
          this.gyro.q = q; this.dirty = true;
        });
      }
      this.gyro.enabled = true;
      this.gyro.calibrate = true;
    } else if (this.gyro) this.gyro.enabled = false;
    this.dirty = true;
    return true;
  }

  // ---------- Bucle de render ----------
  _frame(t) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    // teclado
    if (this.keys.size) {
      const sp = this.horizontalFov * dt * 0.9;
      if (this.keys.has('ArrowLeft')) this.yaw -= sp;
      if (this.keys.has('ArrowRight')) this.yaw += sp;
      if (this.keys.has('ArrowUp')) this.pitch += sp;
      if (this.keys.has('ArrowDown')) this.pitch -= sp;
      if (this.keys.has('+') || this.keys.has('=')) this.hfov = clamp(this.hfov * (1 - dt), this.hfovMin, this.hfovMax);
      if (this.keys.has('-') || this.keys.has('_')) this.hfov = clamp(this.hfov * (1 + dt), this.hfovMin, this.hfovMax);
      this.dirty = true;
    }
    // inercia
    if (Math.abs(this.vel.yaw) + Math.abs(this.vel.pitch) > 0.001 && !this._dragging) {
      this.yaw += this.vel.yaw; this.pitch += this.vel.pitch;
      this.vel.yaw *= 0.9; this.vel.pitch *= 0.9;
      this.dirty = true;
    }
    this.pitch = clamp(this.pitch, -90, 90);
    this.yaw = ((this.yaw + 180) % 360 + 360) % 360 - 180;

    // giroscopio
    if (this.gyro?.enabled && this.gyro.q && !this.renderer.xr.isPresenting) {
      const { yaw, pitch } = yawPitchFromDir(new THREE.Vector3(0, 0, -1).applyQuaternion(this.gyro.q));
      if (this.gyro.calibrate) { this.gyro.offset = this.yaw - yaw; this.gyro.calibrate = false; }
      this.yaw = yaw + this.gyro.offset; this.pitch = pitch;
      const e = new THREE.Euler().setFromQuaternion(this.gyro.q, 'YXZ');
      this.gyroRoll = e.z;
      this.dirty = true;
    }

    // transiciones
    for (const old of [...this.oldNodes]) {
      const k = (now - old.fadeStart) / 600;
      if (k >= 1) { old.dispose(); this.oldNodes.splice(this.oldNodes.indexOf(old), 1); }
      else old.setOpacity(1 - k * k);
      this.dirty = true;
    }

    // hotspots animados
    if (this.node) for (const h of this.node.hotspots) if (h.tick(now)) this.dirty = true;
    for (const o of this.overlays3D) if (o.tick && o.tick(now)) this.dirty = true;

    if (this.vrActive && this.onVRFrame) this.onVRFrame(now);

    const presenting = this.renderer.xr.isPresenting;
    if (!this.dirty && !presenting && !this.vrActive) return;
    this.dirty = false;
    this._applyCamera();
    if (this.gyro?.enabled && this.gyroRoll && !presenting) this.camera.rotateZ(this.gyroRoll);
    this.camera.updateMatrixWorld();
    // carga de mosaicos según resolución
    if (this.node) {
      this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
      const pxPerDeg = (this.width * this.renderer.getPixelRatio()) / this.horizontalFov;
      this.node.update(this.camera, presenting ? 1e9 : pxPerDeg);
    }
    if (this.customRender) this.customRender();
    else this.renderer.render(this.scene, this.camera);
    this.emitView?.();
  }
}

export { THREE, CUBE_R, HS_R };

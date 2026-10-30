// Modo VR: WebXR (visores), Cardboard (móvil con giroscopio, pantalla dividida) y vista previa en escritorio.
// Incluye retícula con selección por mirada, paneles XR (contenedores de la interfaz en 3D) y videos flotantes.
import { THREE, dirFromYawPitch, yawPitchFromDir } from './pano.js';
import { deg, isMobile } from './core.js';

const imgCache = new Map();
function loadImg(url) {
  if (!imgCache.has(url)) imgCache.set(url, new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; }));
  return imgCache.get(url);
}
const urlsOf = bg => [...(bg || '').matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]);

// Dibuja un subárbol DOM (hecho de fondos e imágenes) en un canvas
async function paintTree(host, ctx, scale) {
  const base = host.getBoundingClientRect();
  const jobs = [];
  const walk = (el, inheritedOpacity) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const op = inheritedOpacity * (parseFloat(cs.opacity) || (cs.opacity === '0' ? 0 : 1));
    if (op <= 0.01) return;
    const r = el.getBoundingClientRect();
    const box = { x: (r.left - base.left) * scale, y: (r.top - base.top) * scale, w: r.width * scale, h: r.height * scale };
    if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) jobs.push({ type: 'color', color: cs.backgroundColor, box, op });
    for (const url of urlsOf(cs.backgroundImage)) jobs.push({ type: 'img', url, box, op, size: cs.backgroundSize, pos: cs.backgroundPosition });
    if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') jobs.push({ type: 'color', color: '#000', box, op });
    for (const c of el.children) walk(c, op);
  };
  walk(host, 1);
  const imgs = await Promise.all(jobs.map(j => (j.type === 'img' ? loadImg(j.url) : null)));
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  jobs.forEach((j, i) => {
    ctx.globalAlpha = j.op;
    const { x, y, w, h } = j.box;
    if (j.type === 'color') { ctx.fillStyle = j.color; ctx.fillRect(x, y, w, h); return; }
    const im = imgs[i]; if (!im) return;
    let dw = w, dh = h;
    const ar = im.naturalWidth / im.naturalHeight;
    if (j.size === 'contain') { if (w / h > ar) { dh = h; dw = h * ar; } else { dw = w; dh = w / ar; } }
    else if (j.size === 'cover') { if (w / h > ar) { dw = w; dh = w / ar; } else { dh = h; dw = h * ar; } }
    else if (j.size === 'auto') { dw = im.naturalWidth * scale; dh = im.naturalHeight * scale; }
    const [px, py] = (j.pos || '50% 50%').split(' ').map(v => parseFloat(v) / 100);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(im, x + (w - dw) * (isNaN(px) ? .5 : px), y + (h - dh) * (isNaN(py) ? .5 : py), dw, dh);
    ctx.restore();
  });
  ctx.globalAlpha = 1;
}

export class VR {
  constructor(tour, player, viewer, ui) {
    this.tour = tour; this.player = player; this.viewer = viewer; this.ui = ui;
    this.active = false; this.mode = null;
    this.panels = new Map();     // component id -> panel
    this.popups = [];
    this.xrPanels = tour.all('XRPanel');
    this.selectionTime = tour.byId('MainViewer')?.raw.vrPointerSelectionTime ?? 2000;
    this.pointerColor = tour.byId('MainViewer')?.raw.vrPointerColor || '#FFFFFF';
    this.selectionColor = tour.byId('MainViewer')?.raw.vrPointerSelectionColor || '#FF6600';
    this.thumbStep = tour.byId('MainViewer')?.raw.vrThumbstickRotationStep ?? 20;
    this.xrSupported = false;
    if (navigator.xr?.isSessionSupported) navigator.xr.isSessionSupported('immersive-vr').then(s => { this.xrSupported = s; }).catch(() => {});
    viewer.scene.add(viewer.camera);
    this._buildReticle();
    ui.onRender.add((obj, visible) => this._onVisibility(obj, visible));
    tour.bind('panoloaded', () => this._onPanoLoaded());
    viewer.onVRFrame = now => this._frame(now);
    this.exitBtn = document.getElementById('vr-exit');
    this.exitBtn?.addEventListener('click', () => this.exit());
  }

  // ---------- Entrar / salir ----------
  async enter() {
    if (this.active) return;
    const v = this.viewer;
    let mode = 'preview';
    if (this.xrSupported) mode = 'xr';
    else if (isMobile) mode = 'cardboard';
    this.mode = mode;
    this.active = true;
    v.vrActive = true; v.vrMode = mode;
    document.body.classList.add('vr-mode', 'vr-' + mode);
    if (mode === 'xr') {
      try {
        const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
        v.renderer.xr.enabled = true;
        v.renderer.xr.setReferenceSpaceType('local');
        await v.renderer.xr.setSession(session);
        session.addEventListener('end', () => this.exit(true));
        this._setupControllers();
        this._alignWorld(true);
      } catch (e) {
        console.warn('WebXR no disponible, usando modo cardboard/preview', e);
        this.mode = mode = isMobile ? 'cardboard' : 'preview';
        v.vrMode = mode;
        document.body.classList.remove('vr-xr'); document.body.classList.add('vr-' + mode);
      }
    }
    if (mode === 'cardboard') {
      try { await document.documentElement.requestFullscreen?.(); } catch {}
      try { await screen.orientation?.lock?.('landscape'); } catch {}
      await v.enableGyro(true);
      const stereo = new THREE.StereoCamera();
      stereo.eyeSep = 0.064;
      v.customRender = () => {
        const r = v.renderer, size = r.getSize(new THREE.Vector2());
        v.camera.updateMatrixWorld();
        stereo.update(v.camera);
        r.setScissorTest(true);
        r.setScissor(0, 0, size.x / 2, size.y); r.setViewport(0, 0, size.x / 2, size.y); r.render(v.scene, stereo.cameraL);
        r.setScissor(size.x / 2, 0, size.x / 2, size.y); r.setViewport(size.x / 2, 0, size.x / 2, size.y); r.render(v.scene, stereo.cameraR);
        r.setScissorTest(false);
        r.setViewport(0, 0, size.x, size.y);
      };
      this._tapHandler = () => this._selectGaze();
      v.renderer.domElement.addEventListener('click', this._tapHandler);
    }
    this.reticle.visible = mode !== 'preview';
    v.refreshHotspots();
    // los contenedores ya visibles que tienen panel XR se abren en 3D
    for (const p of this.xrPanels) { const c = this.tour.resolve(p.raw.data?.content); if (c && c.raw.visible !== false) this.openPanel(c, p); }
    v.dirty = true;
    this.tour.emit('vrchange', true);
  }

  exit(fromSession) {
    if (!this.active) return;
    const v = this.viewer;
    const session = v.renderer.xr.getSession?.();
    if (session && !fromSession) session.end().catch(() => {});
    v.renderer.xr.enabled = false;
    v.customRender = null;
    if (this._tapHandler) v.renderer.domElement.removeEventListener('click', this._tapHandler);
    if (this.mode === 'cardboard') { v.enableGyro(false); try { screen.orientation?.unlock?.(); } catch {} if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }
    for (const [, p] of this.panels) this._closePanel(p);
    this.panels.clear();
    for (const p of [...this.popups]) p.close();
    for (const c of this.controllers || []) c.removeFromParent();
    this.controllers = [];
    v.world.rotation.set(0, 0, 0);
    this.reticle.visible = false;
    this.active = false; v.vrActive = false; v.vrMode = null;
    document.body.classList.remove('vr-mode', 'vr-xr', 'vr-cardboard', 'vr-preview');
    v.resize();
    v.refreshHotspots();
    v.dirty = true;
    this.tour.emit('vrchange', false);
  }

  _headYaw() {
    const cam = this.viewer.renderer.xr.isPresenting ? this.viewer.renderer.xr.getCamera() : this.viewer.camera;
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    return yawPitchFromDir(d).yaw;
  }
  // En WebXR la cabeza manda: se gira el mundo para que la vista inicial del panorama quede al frente.
  _alignWorld() {
    if (this.mode !== 'xr') return;
    this.viewer.world.rotation.y = (this.viewer.yaw - this._headYaw()) * deg;
  }
  _onPanoLoaded() {
    if (!this.active) return;
    if (this.mode === 'xr') this._alignWorld();
    if (this.mode === 'cardboard' && this.viewer.gyro) this.viewer.gyro.calibrate = true;
  }

  // ---------- Retícula (selección por mirada) ----------
  _buildReticle() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.018, 32), new THREE.MeshBasicMaterial({ color: this.pointerColor, depthTest: false, transparent: true, opacity: 0.9 }));
    const prog = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.028, 48, 1, Math.PI / 2, 0.0001), new THREE.MeshBasicMaterial({ color: this.selectionColor, depthTest: false, transparent: true }));
    ring.renderOrder = prog.renderOrder = 20000;
    g.add(ring, prog);
    g.position.set(0, 0, -1);
    g.visible = false;
    this.reticle = g; this.reticleProg = prog;
    this.viewer.camera.add(g);
  }
  _setProgress(k) {
    const old = this.reticleProg.geometry;
    this.reticleProg.geometry = new THREE.RingGeometry(0.02, 0.028, 48, 1, Math.PI / 2, Math.max(0.0001, k * Math.PI * 2));
    old.dispose();
  }
  _gazeRay() {
    const cam = this.viewer.renderer.xr.isPresenting ? this.viewer.renderer.xr.getCamera() : this.viewer.camera;
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    return new THREE.Ray(o, d);
  }
  _selectGaze() { const hit = this.viewer.pickRay(this._gazeRay()); this.viewer.clickHit(hit); this.gaze = null; this._setProgress(0); }

  _frame(now) {
    if (!this.active) return;
    // selección por mirada (cardboard / visores sin mandos)
    if (this.mode !== 'preview' && !(this.controllers?.some(c => c.userData.connected && c.userData.mode === 'tracked-pointer'))) {
      const hit = this.viewer.pickRay(this._gazeRay());
      let key = null;
      if (hit) {
        const pk = hit.object.userData.panelKey;
        if (pk) { const k = pk(hit); key = k ? hit.object.uuid + k : null; }
        else key = hit.object.userData.hotspot?.overlay.id || hit.object.uuid;
      }
      if (key !== this.gaze?.key) { this.gaze = key ? { key, t0: now } : null; this._setProgress(0); }
      else if (this.gaze) {
        const k = (now - this.gaze.t0) / this.selectionTime;
        this._setProgress(Math.min(1, k));
        if (k >= 1) { this.viewer.clickHit(hit); this.gaze = { key, t0: now + 1e9 }; this._setProgress(0); }
      }
    }
    // giro con joystick (snap turn)
    const session = this.viewer.renderer.xr.getSession?.();
    if (session) for (const src of session.inputSources) {
      const ax = src.gamepad?.axes; if (!ax) continue;
      const x = ax.length >= 4 ? ax[2] : ax[0];
      const k = src.handedness + 'turn';
      if (Math.abs(x) > 0.7) { if (!this[k]) { this[k] = true; this.viewer.world.rotation.y += (x > 0 ? -1 : 1) * this.thumbStep * deg; } }
      else this[k] = false;
    }
    for (const p of this.popups) p.tick?.(now);
  }

  _setupControllers() {
    const v = this.viewer;
    this.controllers = [];
    for (let i = 0; i < 2; i++) {
      const c = v.renderer.xr.getController(i);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -6)]), new THREE.LineBasicMaterial({ color: this.pointerColor, transparent: true, opacity: 0.8, depthTest: false }));
      line.renderOrder = 19000;
      c.add(line);
      c.addEventListener('connected', e => { c.userData.connected = true; c.userData.mode = e.data.targetRayMode; line.visible = e.data.targetRayMode === 'tracked-pointer'; });
      c.addEventListener('disconnected', () => { c.userData.connected = false; });
      c.addEventListener('select', () => {
        const m = c.matrixWorld;
        const ray = new THREE.Ray(new THREE.Vector3().setFromMatrixPosition(m), new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize());
        if (c.userData.mode === 'gaze' || c.userData.mode === 'screen') this._selectGaze();
        else v.clickHit(v.pickRay(ray));
      });
      v.scene.add(c);
      this.controllers.push(c);
    }
  }

  // ---------- Paneles XR (contenedores de la interfaz mostrados en 3D) ----------
  _panelFor(comp) { return this.xrPanels.find(p => this.tour.resolve(p.raw.data?.content) === comp); }
  _onVisibility(obj, visible) {
    if (!this.active) return;
    const xrp = this._panelFor(obj);
    if (xrp) { if (visible) this.openPanel(obj, xrp); else { const p = this.panels.get(obj.id); if (p) { this._closePanel(p); this.panels.delete(obj.id); } } return; }
    for (const [, p] of this.panels) if (p.host.contains(obj.el) || obj.el?.contains(p.comp.el)) p.repaint();
  }

  openPanel(comp, xrp) {
    if (this.panels.has(comp.id) || !comp.el) return;
    const W = xrp.raw.data?.width || 1182, H = xrp.raw.data?.height || 731;
    const el = comp.el;
    const restore = { parent: el.parentNode, next: el.nextSibling, css: el.style.cssText };
    const host = document.createElement('div');
    host.className = 'xr-host';
    host.style.width = W + 'px'; host.style.height = H + 'px';
    document.body.appendChild(host);
    host.appendChild(el);
    Object.assign(el.style, { left: '0', top: '0', right: 'auto', bottom: 'auto', width: '100%', height: '100%', display: '', opacity: '1', transition: 'none' });
    const scale = Math.min(2, 2048 / W);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const worldW = 3.2, worldH = worldW * H / W;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 10001;
    const veilColor = xrp.raw.veilColor || '#000000';
    const veil = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshBasicMaterial({ color: veilColor, transparent: true, opacity: 0.55, side: THREE.BackSide, depthTest: false }));
    veil.renderOrder = 10000;
    const yaw = this._headYaw();
    mesh.position.copy(dirFromYawPitch(yaw, 0, 3));
    mesh.lookAt(0, 0, 0);
    this.viewer.scene.add(veil, mesh);
    const panel = {
      comp, host, mesh, veil, restore, canvas, tex,
      repaint: () => {
        clearTimeout(panel._t);
        const go = () => paintTree(host, ctx, scale).then(() => { tex.needsUpdate = true; this.viewer.dirty = true; });
        go(); panel._t = setTimeout(go, 650);
      }
    };
    const toPx = hit => ({ x: hit.uv.x * W, y: (1 - hit.uv.y) * H });
    mesh.userData.panelKey = hit => { const t = this._panelTarget(panel, toPx(hit)); return t ? '#' + [...host.querySelectorAll('*')].indexOf(t) : ''; };
    mesh.userData.onClick = hit => {
      const t = this._panelTarget(panel, toPx(hit));
      if (t) { t._tdvClick({ stopPropagation() {} }); panel.repaint(); }
    };
    this.viewer.overlays3D.push({ pickable: mesh }, { pickable: veil });
    veil.userData.blocker = true;
    this.panels.set(comp.id, panel);
    panel.repaint();
  }
  _panelTarget(panel, p) {
    const base = panel.host.getBoundingClientRect();
    const cands = [...panel.host.querySelectorAll('*')].filter(e => e._tdvClick && e.checkVisibility?.({ checkOpacity: false }) !== false);
    let best = null;
    for (const e of cands) {
      const r = e.getBoundingClientRect();
      const x = p.x + base.left, y = p.y + base.top;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = e; // el último (más arriba) gana
    }
    return best;
  }
  _closePanel(p) {
    const el = p.comp.el;
    el.style.cssText = p.restore.css;
    if (p.comp.raw.visible === false) el.style.display = 'none';
    p.restore.parent?.insertBefore(el, p.restore.next);
    p.host.remove();
    p.mesh.removeFromParent(); p.veil.removeFromParent();
    p.mesh.geometry.dispose(); p.mesh.material.dispose(); p.tex.dispose();
    p.veil.geometry.dispose(); p.veil.material.dispose();
    this.viewer.overlays3D = this.viewer.overlays3D.filter(o => o.pickable !== p.mesh && o.pickable !== p.veil);
    this.viewer.dirty = true;
  }

  // ---------- Video flotante en el panorama (PopupPanoramaOverlay) ----------
  showPopupVideo(popup, stopAudios) {
    if (!popup) return;
    const raw = popup.raw;
    const res = this.tour.rawOf(raw.video);
    const levels = (res?.levels || []).map(l => this.tour.rawOf(l)).filter(l => l?.url).sort((a, b) => (a.width || 0) - (b.width || 0));
    const lvl = (isMobile ? levels.find(l => l.width <= 1920) : levels[levels.length - 1]) || levels[0];
    if (!lvl) return;
    for (const p of [...this.popups]) p.close();
    const video = document.createElement('video');
    video.src = lvl.url; video.crossOrigin = 'anonymous'; video.playsInline = true; video.muted = this.player.muted;
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    const R = 4.5;
    const w = 2 * Math.tan((raw.hfov || 30) * deg / 2) * R;
    const h = w * (res.height || lvl.height || 9) / (res.width || lvl.width || 16);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.renderOrder = 9000;
    mesh.position.copy(dirFromYawPitch(raw.yaw || 0, raw.pitch || 0, R));
    mesh.lookAt(0, 0, 0);
    // botón de cerrar
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#000'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(40, 40); g.lineTo(88, 88); g.moveTo(88, 40); g.lineTo(40, 88); g.stroke();
    const ctex = new THREE.CanvasTexture(c);
    const close = new THREE.Mesh(new THREE.PlaneGeometry(h * 0.14 + 0.1, h * 0.14 + 0.1), new THREE.MeshBasicMaterial({ map: ctex, transparent: true, depthTest: false }));
    close.renderOrder = 9001;
    close.position.set(w / 2, h / 2 + h * 0.1, 0.01);
    mesh.add(close);
    this.viewer.world.add(mesh);
    if (stopAudios) this.player.pauseGlobalAudios();
    const t0 = performance.now(), show = raw.showDuration || 500;
    const popupObj = {
      tick: now => { const k = Math.min(1, (now - t0) / show); mat.opacity = k; this.viewer.dirty = true; },
      close: () => {
        video.pause(); video.removeAttribute('src'); video.load();
        mesh.removeFromParent(); mesh.geometry.dispose(); mat.dispose(); tex.dispose(); ctex.dispose();
        this.viewer.overlays3D = this.viewer.overlays3D.filter(o => o.pickable !== mesh && o.pickable !== close);
        this.popups = this.popups.filter(p => p !== popupObj);
        if (stopAudios) this.player.resumeGlobalAudios();
        this.viewer.dirty = true;
      }
    };
    mesh.userData.onClick = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
    close.userData.onClick = () => popupObj.close();
    video.addEventListener('ended', () => popupObj.close());
    this.viewer.overlays3D.push({ pickable: close }, { pickable: mesh, tick: popupObj.tick });
    this.popups.push(popupObj);
    if (raw.autoplay !== false) video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  }
}

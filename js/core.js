// Núcleo: modelo de objetos compatible con las definiciones de 3DVista.
// Cada definición (panorama, hotspot, contenedor...) se envuelve en un TObj con get/set/bind/trigger,
// y las acciones (cadenas JS como "this.setPlayListSelectedIndex(this.mainPlayList, 3)")
// se ejecutan con `this` apuntando a un contexto que expone esos objetos y las funciones de script.

const REF = /^this\.([A-Za-z_$][\w$]*)$/;

// Constantes que las acciones de 3DVista referencian directamente (p.ej. TDV.Player.DEFAULT_PANORAMA_HFOV)
window.TDV = window.TDV || { Player: { DEFAULT_PANORAMA_HFOV: 110 } };

export class Emitter {
  constructor() { this._h = {}; }
  bind(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  unbind(ev, fn) { const l = this._h[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  emit(ev, ...a) { const l = this._h[ev]; if (l) for (const fn of [...l]) fn(...a); }
}

export class TObj extends Emitter {
  constructor(raw, tour) {
    super();
    this.raw = raw;
    this.tour = tour;
  }
  get id() { return this.raw.id; }
  get cls() { return this.raw.class; }
  get(k) {
    const g = this.tour.getters[this.raw.class + '.' + k] || this.tour.getters['*.' + k];
    if (g) { const r = g(this); if (r !== undefined) return r; }
    if (k === 'data') return (this.raw.data ||= {});
    return this.tour.resolve(this.raw[k]);
  }
  set(k, v) {
    const old = this.raw[k];
    this.raw[k] = v instanceof TObj ? v.raw : v;
    this.emit('change:' + k, v, old);
    this.emit('change', k, v, old);
  }
  // Ejecuta el código del evento (p.ej. 'click') y luego los listeners registrados.
  trigger(ev, ...args) {
    const code = this.raw[ev];
    if (typeof code === 'string' && code.trim()) this.tour.run(code, this);
    this.emit(ev, ...args);
  }
}

export class Tour extends Emitter {
  constructor(data) {
    super();
    this.data = data;
    this.locale = data.locale || {};
    this.registry = new Map();
    this.wraps = new WeakMap();
    this.getters = {};
    this.flags = {};
    this._fnCache = new Map();
    this.byClass = new Map();
    const seen = new Set();
    const index = o => {
      if (Array.isArray(o)) { o.forEach(index); return; }
      if (o && typeof o === 'object') {
        if (seen.has(o)) return;
        seen.add(o);
        if (o.class) { if (!this.byClass.has(o.class)) this.byClass.set(o.class, []); this.byClass.get(o.class).push(o); }
        if (o.id && o.class && !this.registry.has(o.id)) this.registry.set(o.id, o);
        for (const k in o) if (k !== 'locale') index(o[k]);
      }
    };
    index(data);
    this.root = this.wrap(data);
    this.scripts = {};
    const tour = this;
    this.ctx = new Proxy(this.scripts, {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === 'string') {
          const raw = tour.registry.get(k);
          if (raw) return tour.wrap(raw);
          if (k in tour.root.raw) return tour.root.get(k);
        }
        return undefined;
      },
      has() { return true; }
    });
  }
  wrap(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    let w = this.wraps.get(raw);
    if (!w) { w = new TObj(raw, this); this.wraps.set(raw, w); }
    return w;
  }
  byId(id) { const r = this.registry.get(id); return r ? this.wrap(r) : null; }
  all(cls) { return (this.byClass.get(cls) || []).map(r => this.wrap(r)); }
  resolve(v) {
    if (typeof v === 'string') {
      const m = REF.exec(v);
      if (m) { const raw = this.registry.get(m[1]); return raw ? this.wrap(raw) : undefined; }
      return v;
    }
    if (Array.isArray(v)) return v.map(x => this.resolve(x));
    if (v && typeof v === 'object' && v.class) return this.wrap(v);
    return v;
  }
  rawOf(v) { return v instanceof TObj ? v.raw : (typeof v === 'string' ? (this.resolve(v)?.raw) : v); }
  translate(key) { return this.locale[key] !== undefined ? this.locale[key] : key; }
  run(code, source) {
    let fn = this._fnCache.get(code);
    if (!fn) {
      try { fn = new Function(code); }
      catch (e) { console.warn('[tour] acción inválida', code, e); fn = () => {}; }
      this._fnCache.set(code, fn);
    }
    try { return fn.call(this.ctx); }
    catch (e) { console.warn('[tour] error ejecutando acción', e, code.slice(0, 200), source?.id); }
  }
}

// Utilidades compartidas
export const deg = Math.PI / 180;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function cssColor(colors, ratios, opacity = 1, direction = 'vertical') {
  if (!colors || !colors.length) return null;
  const rgba = c => {
    const h = c.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
  };
  if (colors.length === 1) return rgba(colors[0]);
  const dir = direction === 'horizontal' ? 'to right' : 'to bottom';
  const stops = colors.map((c, i) => `${rgba(c)} ${Math.round((ratios?.[i] ?? i / (colors.length - 1)) * 100)}%`);
  return `linear-gradient(${dir}, ${stops.join(',')})`;
}

// Elige el nivel de imagen más adecuado de un ImageResource
export function bestLevel(res, maxSize = 2048) {
  const raw = res?.raw || res;
  const levels = (raw?.levels || []).map(l => (typeof l === 'string' ? null : l)).filter(Boolean);
  if (!levels.length) return null;
  const sorted = [...levels].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted.find(l => (l.width || 0) <= maxSize) || sorted[sorted.length - 1];
}

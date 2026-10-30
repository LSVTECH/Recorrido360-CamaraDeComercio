// Interfaz: reproduce los componentes de 3DVista (Container, Image, IconButton, TabPanel, Window...)
// con su mismo sistema de posicionamiento (left/top/right/bottom/width/height en px o %).
import { cssColor, bestLevel } from './core.js';

const px = v => (typeof v === 'number' ? v + 'px' : v);
const H_ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end' };
const V_ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
const POS_X = { left: '0%', center: '50%', right: '100%' };
const POS_Y = { top: '0%', middle: '50%', bottom: '100%' };

export class UI {
  constructor(tour, rootEl) {
    this.tour = tour;
    this.rootEl = rootEl;
    this.els = new Map();          // id -> elemento
    this.toggles = new Map();      // IconButton id -> función que devuelve el estado
    this.onRender = new Set();
  }

  build() {
    const root = this.tour.root;
    this.rootEl.style.background = cssColor(root.raw.backgroundColor, root.raw.backgroundColorRatios) || '#fff';
    for (const c of root.get('children') || []) {
      const el = this.create(c, 'absolute');
      if (el) this.rootEl.appendChild(el);
    }
  }

  create(obj, parentLayout) {
    if (!obj?.raw) return null;
    const raw = obj.raw;
    let el;
    switch (raw.class) {
      case 'ViewerArea': el = this.viewerArea(obj); break;
      case 'Container': case 'TabPanelPage': el = this.container(obj); break;
      case 'Image': el = this.image(obj); break;
      case 'IconButton': el = this.iconButton(obj); break;
      case 'TabPanel': el = this.tabPanel(obj); break;
      case 'UIComponent': el = document.createElement('div'); break;
      case 'ZoomImage': el = document.createElement('div'); el.className = 'zoom-image'; break;
      case 'CloseButton': el = this.closeButton(obj); break;
      case 'Label': el = this.label(obj); break;
      case 'WebFrame': el = document.createElement('iframe'); el.src = raw.url || ''; el.style.border = '0'; break;
      default: el = document.createElement('div');
    }
    el.classList.add('tdv', 'tdv-' + raw.class);
    el.dataset.id = raw.id || '';
    if (raw.data?.name) el.dataset.name = raw.data.name;
    obj.el = el;
    if (raw.id) this.els.set(raw.id, el);
    this.applyBox(el, raw, parentLayout);
    this.applyBackground(el, raw);
    this.applyClick(el, obj);
    this.applyVisibility(el, obj);
    return el;
  }

  applyBox(el, raw, parentLayout) {
    const s = el.style;
    if (parentLayout === 'absolute') {
      s.position = 'absolute';
      for (const k of ['left', 'top', 'right', 'bottom']) if (raw[k] !== undefined && raw[k] !== null) s[k] = px(raw[k]);
    } else {
      s.position = 'relative';
      s.flex = '0 0 auto';
    }
    if (raw.width !== undefined) s.width = px(raw.width);
    if (raw.height !== undefined) s.height = px(raw.height);
    if (raw.minWidth) s.minWidth = px(raw.minWidth);
    if (raw.minHeight) s.minHeight = px(raw.minHeight);
    if (raw.maxWidth !== undefined) s.maxWidth = px(raw.maxWidth);
    if (raw.maxHeight !== undefined) s.maxHeight = px(raw.maxHeight);
    if (raw.borderRadius) s.borderRadius = px(raw.borderRadius);
    if (raw.borderSize) { s.borderStyle = 'solid'; s.borderWidth = px(raw.borderSize); s.borderColor = raw.borderColor || '#000'; s.boxSizing = 'border-box'; }
    if (raw.opacity !== undefined) s.opacity = raw.opacity;
    for (const k of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) if (raw[k]) s[k] = px(raw[k]);
    if (raw.shadow) s.boxShadow = `${raw.shadowHorizontalLength || 0}px ${raw.shadowVerticalLength || 0}px ${raw.shadowBlurRadius || 0}px ${raw.shadowSpread || 0}px ${raw.shadowColor || '#000'}`;
  }

  applyBackground(el, raw) {
    const s = el.style;
    const layers = [];
    if (raw.backgroundImageUrl) { layers.push(`url("${raw.backgroundImageUrl}")`); }
    const op = raw.backgroundOpacity ?? 1;
    const col = raw.backgroundColor?.length && op > 0 ? cssColor(raw.backgroundColor, raw.backgroundColorRatios, op, raw.backgroundColorDirection) : null;
    if (layers.length) {
      s.backgroundImage = layers.join(',');
      s.backgroundSize = '100% 100%';
      s.backgroundRepeat = 'no-repeat';
    }
    if (col) {
      if (col.startsWith('linear')) s.backgroundImage = [s.backgroundImage, col].filter(x => x && x !== 'none').join(',');
      else s.backgroundColor = col;
    }
    // Un contenedor sin fondo deja pasar el ratón al panorama (como en 3DVista)
    if (!raw.backgroundImageUrl && !col && (raw.class === 'Container' || raw.class === 'TabPanelPage') && !raw.click) el.classList.add('passthrough');
  }

  applyClick(el, obj) {
    const raw = obj.raw;
    const handler = e => {
      if (raw.propagateClick === false) e?.stopPropagation?.();
      el.dispatchEvent(new CustomEvent('tdv-click', { bubbles: false }));
      obj.trigger('click');
      this.tour.emit('uiclick', obj);
    };
    el._tdvClick = raw.click || raw.class === 'IconButton' ? handler : null;
    if (raw.click || raw.class === 'IconButton') {
      el.addEventListener('click', handler);
      if (raw.cursor === 'hand' || raw.class === 'IconButton' || raw.click) el.style.cursor = 'pointer';
    } else if (raw.propagateClick === false) {
      el.addEventListener('click', e => e.stopPropagation());
    }
    if (raw.cursor === 'hand') el.style.cursor = 'pointer';
  }

  applyVisibility(el, obj) {
    const raw = obj.raw;
    if (raw.visible === false) el.style.display = 'none';
    obj.bind('change:visible', v => this.setVisible(obj, v));
  }

  // Muestra/oculta con el efecto configurado (FadeIn / FadeOut)
  setVisible(obj, visible) {
    const el = obj.el;
    if (!el) return;
    const effRaw = this.tour.rawOf(obj.raw[visible ? 'showEffect' : 'hideEffect']);
    const dur = effRaw?.duration || 0;
    clearTimeout(el._visTimer);
    if (visible) {
      el.style.display = '';
      if (dur) {
        el.style.transition = 'none';
        el.style.opacity = '0';
        void el.offsetWidth;
        el.style.transition = `opacity ${dur}ms ease`;
        el.style.opacity = obj.raw.opacity ?? 1;
      } else { el.style.transition = ''; el.style.opacity = obj.raw.opacity ?? ''; }
    } else {
      if (dur && el.style.display !== 'none') {
        el.style.transition = `opacity ${dur}ms ease`;
        el.style.opacity = '0';
        el._visTimer = setTimeout(() => { el.style.display = 'none'; el.style.opacity = ''; el.style.transition = ''; }, dur);
      } else el.style.display = 'none';
    }
    for (const fn of this.onRender) fn(obj, visible);
  }

  layoutChildren(el, obj) {
    const raw = obj.raw;
    const layout = raw.layout || 'absolute';
    const s = el.style;
    if (layout === 'vertical' || layout === 'horizontal') {
      s.display = 'flex';
      s.flexDirection = layout === 'vertical' ? 'column' : 'row';
      s.gap = px(raw.gap ?? 10);
      const h = H_ALIGN[raw.horizontalAlign || 'left'], v = V_ALIGN[raw.verticalAlign || 'top'];
      if (layout === 'vertical') { s.alignItems = h; s.justifyContent = v; }
      else { s.justifyContent = h; s.alignItems = v; }
    }
    if (raw.overflow === 'scroll' && layout !== 'absolute') s.overflow = 'auto';
    else s.overflow = raw.overflow === 'visible' ? 'visible' : 'hidden';
    for (const c of obj.get('children') || []) {
      const ce = this.create(c, layout);
      if (ce) el.appendChild(ce);
    }
    return layout;
  }

  container(obj) {
    const el = document.createElement('div');
    obj.el = el;
    this.layoutChildren(el, obj);
    return el;
  }

  viewerArea(obj) {
    const el = document.createElement('div');
    el.className = 'viewer-area';
    return el;
  }

  // Image: la imagen se ajusta dentro de su caja según scaleMode y alineación
  image(obj) {
    const raw = obj.raw;
    const el = document.createElement('div');
    const url = raw.url || bestLevel(this.tour.rawOf(raw.image))?.url;
    if (url) {
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundRepeat = 'no-repeat';
      const mode = raw.scaleMode || 'fit_inside';
      el.style.backgroundSize = mode === 'fit_inside' ? 'contain' : mode === 'fit_outside' ? 'cover' : mode === 'stretch' ? '100% 100%' : 'auto';
      el.style.backgroundPosition = `${POS_X[raw.horizontalAlign || 'center']} ${POS_Y[raw.verticalAlign || 'middle']}`;
    }
    return el;
  }

  // IconButton: icono normal / rollover / pressed; modo "toggle" conserva el estado presionado
  iconButton(obj) {
    const raw = obj.raw;
    const el = document.createElement('div');
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.style.backgroundPosition = `${POS_X[raw.horizontalAlign || 'center']} ${POS_Y[raw.verticalAlign || 'middle']}`;
    el.appendChild(icon);
    el.setAttribute('role', 'button');
    if (raw.data?.name) el.setAttribute('aria-label', raw.data.name.replace(/^IconButton\s*/, ''));
    let hover = false, pressed = false;
    obj.toggled = false;
    const paint = () => {
      const on = this.toggles.has(raw.id) ? this.toggles.get(raw.id)() : obj.toggled;
      let url = raw.iconURL;
      if (on && raw.pressedIconURL) url = (hover && raw.pressedRollOverIconURL) || raw.pressedIconURL;
      else if (pressed && raw.pressedIconURL && raw.mode !== 'toggle') url = raw.pressedIconURL;
      else if (hover && raw.rollOverIconURL) url = raw.rollOverIconURL;
      icon.style.backgroundImage = url ? `url("${url}")` : 'none';
    };
    obj.paint = paint;
    el.addEventListener('pointerenter', () => { hover = true; paint(); });
    el.addEventListener('pointerleave', () => { hover = false; pressed = false; paint(); });
    el.addEventListener('pointerdown', () => { pressed = true; paint(); });
    el.addEventListener('pointerup', () => { pressed = false; paint(); });
    if (raw.mode === 'toggle') el.addEventListener('click', () => { if (!this.toggles.has(raw.id)) obj.toggled = !obj.toggled; setTimeout(paint); });
    // precarga de los iconos alternativos para que el cambio sea instantáneo
    for (const u of [raw.rollOverIconURL, raw.pressedIconURL]) if (u) { const i = new Image(); i.src = u; }
    paint();
    return el;
  }

  closeButton(obj) {
    const raw = obj.raw;
    const el = document.createElement('div');
    el.className = 'close-btn';
    el.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9"/></svg>';
    el.style.color = raw.iconColor || '#000';
    el.style.width = px(raw.iconWidth ? raw.iconWidth + 10 : 30);
    el.style.height = px(raw.iconHeight ? raw.iconHeight + 10 : 30);
    return el;
  }

  label(obj) {
    const raw = obj.raw;
    const el = document.createElement('div');
    el.textContent = raw.text || '';
    el.style.color = raw.fontColor || '#000';
    el.style.fontFamily = raw.fontFamily || 'Arial';
    el.style.fontSize = px(raw.fontSize || 14);
    el.style.fontWeight = raw.fontWeight || 'normal';
    el.style.textAlign = raw.textAlign || 'left';
    return el;
  }

  // TabPanel: barra de pestañas + páginas
  tabPanel(obj) {
    const raw = obj.raw;
    const el = document.createElement('div');
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.overflow = 'hidden';
    const bar = document.createElement('div');
    bar.className = 'tab-bar';
    bar.style.height = px(raw.tabsSize ?? 32);
    bar.style.fontFamily = raw.tabsFontFamily || 'Arial';
    bar.style.fontSize = px(raw.tabsFontSize ?? 12);
    const body = document.createElement('div');
    body.className = 'tab-body';
    body.style.position = 'relative';
    body.style.flex = '1 1 auto';
    body.style.padding = `${px(raw.pagePaddingTop || 0)} ${px(raw.pagePaddingRight || 0)} ${px(raw.pagePaddingBottom || 0)} ${px(raw.pagePaddingLeft || 0)}`;
    el.append(bar, body);
    const pages = obj.get('pages') || [];
    const tabs = [];
    const tabBg = (sel, hov) => {
      if (sel) return cssColor(raw.selectedTabBackgroundColor, raw.selectedTabBackgroundColorRatios, 1);
      if (hov) return cssColor(raw.tabsRollOverBackgroundColor, raw.tabsRollOverBackgroundColorRatios, raw.tabsRollOverBackgroundOpacity ?? 1);
      return cssColor(raw.tabsBackgroundColor, raw.tabsBackgroundColorRatios, raw.tabsBackgroundOpacity ?? 1);
    };
    const select = i => {
      obj.raw.selectedIndex = i;
      pages.forEach((p, j) => {
        const pe = p.el; if (pe) pe.style.display = j === i ? '' : 'none';
        const t = tabs[j];
        t.classList.toggle('selected', j === i);
        t.style.background = tabBg(j === i, false);
        t.style.color = j === i ? (raw.selectedTabFontColor || '#fff') : (raw.tabsFontColor || '#ccc');
        t.style.fontWeight = j === i ? (raw.selectedTabFontWeight || 'bold') : 'normal';
      });
      for (const fn of this.onRender) fn(obj, true);
    };
    pages.forEach((p, i) => {
      const t = document.createElement('div');
      t.className = 'tab';
      t.textContent = p.raw.label || '';
      t.addEventListener('pointerenter', () => { if (!t.classList.contains('selected')) { t.style.background = tabBg(false, true); t.style.color = raw.tabsRollOverFontColor || '#fff'; } });
      t.addEventListener('pointerleave', () => { if (!t.classList.contains('selected')) { t.style.background = tabBg(false, false); t.style.color = raw.tabsFontColor || '#ccc'; } });
      t.addEventListener('click', e => { e.stopPropagation(); select(i); });
      t._tdvClick = () => select(i);
      bar.appendChild(t);
      tabs.push(t);
      const pe = this.create(p, 'absolute');
      pe.style.left = '0'; pe.style.top = '0';
      body.appendChild(pe);
    });
    if (pages.length) select(0);
    obj.selectTab = select;
    obj.bind('change:selectedIndex', i => select(i));
    return el;
  }

  // ---------- Ventana emergente con video (showPopupMedia) ----------
  showWindowMedia(win, media, opts) {
    const raw = win.raw;
    const veil = document.createElement('div');
    veil.className = 'tdv-veil';
    veil.style.background = cssColor(raw.veilColor, raw.veilColorRatios, raw.veilOpacity ?? 0.4) || 'rgba(0,0,0,.4)';
    const box = document.createElement('div');
    box.className = 'tdv-window';
    box.style.width = opts.width || '95%';
    box.style.height = opts.height || '95%';
    if (raw.borderRadius) box.style.borderRadius = px(raw.borderRadius);
    if (raw.shadow) box.style.boxShadow = `${raw.shadowHorizontalLength || 0}px ${raw.shadowVerticalLength || 0}px ${raw.shadowBlurRadius || 6}px ${raw.shadowSpread || 0}px rgba(0,0,0,${raw.shadowOpacity ?? .5})`;
    const bodyBg = cssColor(raw.bodyBackgroundColor, raw.bodyBackgroundColorRatios, raw.bodyBackgroundOpacity ?? 1);
    if (bodyBg && (raw.bodyBackgroundOpacity ?? 1) > 0) box.style.background = bodyBg;
    const close = document.createElement('div');
    close.className = 'tdv-window-close';
    close.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9"/></svg>';
    close.style.width = px(raw.closeButtonIconWidth ? raw.closeButtonIconWidth + 14 : 34);
    close.style.height = close.style.width;
    close.style.color = raw.closeButtonIconColor || '#000';
    const cbg = cssColor(raw.closeButtonBackgroundColor, raw.closeButtonBackgroundColorRatios, raw.closeButtonBackgroundOpacity ?? 1);
    if (cbg && (raw.closeButtonBackgroundOpacity ?? 1) > 0) close.style.background = cbg;
    if (raw.closeButtonBorderRadius) close.style.borderRadius = px(raw.closeButtonBorderRadius);
    if (raw.closeButtonIconLineWidth) close.style.setProperty('--line', raw.closeButtonIconLineWidth);
    close.addEventListener('mouseenter', () => { if (raw.closeButtonRollOverIconColor) close.style.color = raw.closeButtonRollOverIconColor; });
    close.addEventListener('mouseleave', () => { close.style.color = raw.closeButtonIconColor || '#000'; });
    const content = document.createElement('div');
    content.className = 'tdv-window-body';
    box.append(content, close);
    veil.appendChild(box);
    const dur = this.tour.rawOf(raw.showEffect)?.duration ?? 500;
    veil.style.opacity = '0';
    veil.style.transition = `opacity ${dur}ms ease`;
    this.rootEl.appendChild(veil);
    requestAnimationFrame(() => { veil.style.opacity = '1'; });
    const api = {
      content,
      close: () => {
        if (api.closed) return;
        api.closed = true;
        const hd = this.tour.rawOf(raw.hideEffect)?.duration ?? 500;
        veil.style.transition = `opacity ${hd}ms ease`;
        veil.style.opacity = '0';
        setTimeout(() => veil.remove(), hd);
        opts.onClose?.();
      }
    };
    close.addEventListener('click', e => { e.stopPropagation(); api.close(); });
    if (raw.modal !== false) veil.addEventListener('click', e => { if (e.target === veil) api.close(); });
    return api;
  }
}

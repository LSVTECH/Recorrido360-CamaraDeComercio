// Reproductor: listas de reproducción, panoramas, video, audio y la API de acciones de 3DVista.
import { TObj, isMobile } from './core.js';

export class Player {
  constructor(tour, ui, viewer) {
    this.tour = tour;
    this.ui = ui;
    this.viewer = viewer;
    this.vr = null;                    // se asigna desde main.js
    this.endMap = new Map();           // playlist id -> {from: to}
    this.nextCamera = new WeakMap();   // item -> {yaw,pitch,hfov}
    this.globalAudios = new Set();
    this.panoAudios = [];
    this.pausedByMedia = new Set();
    this.muted = false;
    this.history = []; this.historyPos = -1;
    this.current = null;               // item actual en mainPlayList
    this.video = null;                 // video activo en el visor principal
    tour.flags.gyroscopeAvailable = isMobile && 'DeviceOrientationEvent' in window;
    tour.flags.fullscreenAvailable = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    this._installGetters();
    this._installScripts();
    this._installToggles();
    // primera interacción: desbloquear audio en navegadores con autoplay restringido
    const unlock = () => {
      for (const a of this.globalAudios) if (a._wantPlay && a.paused) a.play().catch(() => {});
      for (const a of this.panoAudios) if (a._wantPlay && a.paused) a.play().catch(() => {});
      if (this.video && this.video._wantPlay && this.video.paused) this.video.play().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  _installGetters() {
    const g = this.tour.getters;
    g['Player.fullscreenAvailable'] = () => this.tour.flags.fullscreenAvailable;
    g['PlayList.selectedIndex'] = pl => pl.raw.selectedIndex ?? -1;
    g['PanoramaPlayer.hotspotsEnabled'] = () => this.viewer.hotspotsEnabled;
    g['PanoramaPlayer.yaw'] = () => this.viewer.yaw;
    g['PanoramaPlayer.pitch'] = () => this.viewer.pitch;
    g['PanoramaPlayer.hfov'] = () => this.viewer.hfov;
    g['*.visible'] = o => o.raw.visible !== false;
  }

  _installToggles() {
    const root = this.tour.root;
    const viewer = this.viewer;
    const fsEl = document.documentElement;
    const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
    const toggleFs = () => {
      if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl).catch?.(() => {});
    };
    const bindToggle = (refs, getState, onClick) => {
      for (const b of [].concat(refs || []).map(r => this.tour.resolve(r)).filter(Boolean)) {
        this.ui.toggles.set(b.id, getState);
        b.el?.addEventListener('click', () => { onClick(); setTimeout(() => b.paint?.(), 50); });
        this._repaint = this._repaint || [];
        this._repaint.push(b);
      }
    };
    bindToggle(root.raw.buttonToggleFullscreen, isFs, toggleFs);
    bindToggle(root.raw.buttonToggleMute, () => this.muted, () => this.setMuted(!this.muted));
    const pp = this.tour.byId('MainViewerPanoramaPlayer');
    bindToggle(pp?.raw.buttonToggleGyroscope, () => !!viewer.gyro?.enabled, () => viewer.enableGyro(!viewer.gyro?.enabled));
    document.addEventListener('fullscreenchange', () => this._repaint?.forEach(b => b.paint?.()));
    document.addEventListener('webkitfullscreenchange', () => this._repaint?.forEach(b => b.paint?.()));
    if (pp) pp.bind('change:hotspotsEnabled', v => viewer.setHotspotsEnabled(v !== false));
  }

  setMuted(m) {
    this.muted = m;
    document.querySelectorAll('audio,video').forEach(a => { a.muted = m; });
    for (const a of this.globalAudios) a.muted = m;
    for (const a of this.panoAudios) a.muted = m;
    this._repaint?.forEach(b => b.paint?.());
  }

  // ---------- Audio ----------
  _audioEl(audioObj) {
    if (!audioObj) return null;
    if (audioObj._el) return audioObj._el;
    const res = this.tour.rawOf(audioObj.raw.audio);
    const url = res?.url || (res?.mp3Url) || '';
    if (!url) return null;
    const a = new Audio(url);
    a.preload = 'auto';
    a.muted = this.muted;
    audioObj._el = a;
    return a;
  }
  playAudio(a, loop) {
    if (!a) return;
    a.loop = !!loop;
    a._wantPlay = true;
    a.muted = this.muted;
    a.play().catch(() => {});
  }
  pauseGlobalAudios() {
    for (const a of this.globalAudios) if (!a.paused) { a.pause(); this.pausedByMedia.add(a); }
    for (const a of this.panoAudios) if (!a.paused) { a.pause(); this.pausedByMedia.add(a); }
  }
  resumeGlobalAudios() {
    for (const a of this.pausedByMedia) if (a._wantPlay) a.play().catch(() => {});
    this.pausedByMedia.clear();
  }

  // ---------- Listas de reproducción ----------
  select(pl, index) {
    if (!(pl instanceof TObj)) return;
    const items = pl.get('items') || [];
    const item = items[index];
    if (!item) return;
    const prevIdx = pl.raw.selectedIndex;
    pl.raw.selectedIndex = index;
    pl.emit('change:selectedIndex', index, prevIdx);
    const player = item.get('player');
    item.trigger('begin');
    if (item.raw.class === 'PanoramaPlayListItem') this._playPano(pl, item, index);
    else if (item.raw.class === 'VideoPlayListItem') this._playVideo(pl, item, index, player);
    item.trigger('start');
    if (pl.id === 'mainPlayList') {
      this.current = item;
      if (!this._navHistory) { this.history.splice(this.historyPos + 1); this.history.push(index); this.historyPos = this.history.length - 1; }
      this._navHistory = false;
      this.tour.emit('mediachange', item, index);
    }
  }

  async _playPano(pl, item, index) {
    this._stopMainVideo();
    const pano = item.get('media');
    const camObj = item.get('camera');
    const init = camObj?.raw.initialPosition || {};
    const spot = this.nextCamera.get(item.raw);
    this.nextCamera.delete(item.raw);
    const cam = {
      yaw: spot?.yaw ?? init.yaw ?? 0,
      pitch: spot?.pitch ?? init.pitch ?? 0,
      hfov: (spot && Number.isFinite(spot.hfov) ? spot.hfov : null) ?? init.hfov ?? 110
    };
    // audio del panorama
    for (const a of this.panoAudios) { a.pause(); a._wantPlay = false; }
    this.panoAudios = [];
    for (const au of pano.get('audios') || []) {
      const a = this._audioEl(au);
      if (a && au.raw.autoplay !== false) { this.panoAudios.push(a); a.currentTime = 0; this.playAudio(a, au.raw.loop !== false); }
    }
    const ok = await this.viewer.load(pano, cam);
    if (ok) {
      this.tour.emit('panoloaded', pano, item);
      document.title = this.tour.data.title || document.title;
    }
  }

  _videoUrl(media) {
    const res = this.tour.rawOf(media.raw.video);
    const levels = (res?.levels || []).map(l => this.tour.rawOf(l)).filter(l => l?.url);
    levels.sort((a, b) => (b.width || 0) - (a.width || 0));
    // en móvil evitar 4K si hay alternativa
    const pick = isMobile ? (levels.find(l => (l.width || 0) <= 1920) || levels[levels.length - 1]) : levels[0];
    return { url: pick?.url, poster: pick?.posterURL || media.raw.thumbnailUrl };
  }

  _playVideo(pl, item, index, player) {
    const media = item.get('media');
    if (player?.id === 'MainViewerVideoPlayer') {
      this._stopMainVideo();
      const { url, poster } = this._videoUrl(media);
      const holder = this.tour.byId('MainViewer')?.el;
      const v = document.createElement('video');
      v.className = 'main-video';
      v.src = url; v.poster = poster || '';
      v.playsInline = true; v.controls = true; v.muted = this.muted;
      v._wantPlay = true;
      holder?.appendChild(v);
      this.video = v;
      v.play().catch(() => {});
      v.addEventListener('ended', () => this._onItemEnd(pl, index));
      return;
    }
    // videos de las ventanas emergentes se gestionan en showPopupMedia
  }
  _stopMainVideo() {
    if (this.video) { this.video.pause(); this.video.remove(); this.video = null; this.resumeGlobalAudios(); }
  }
  _onItemEnd(pl, index) {
    const m = this.endMap.get(pl.id);
    if (m && m[index] !== undefined) this.select(pl, m[index]);
    pl.emit('end', index);
  }

  // ---------- API de acciones (lo que llaman los hotspots y botones) ----------
  _installScripts() {
    const P = this, T = this.tour, S = this.tour.scripts;
    Object.assign(S, {
      init() { const h = location.hash.match(/media(?:-index)?=(\d+)/); if (h) P._startIndex = +h[1]; },
      get(k) { return k in T.flags ? T.flags[k] : T.root.get(k); },
      set(k, v) { T.root.set(k, v); },
      translate: key => T.translate(key),
      isCardboardViewMode: () => !!P.vr?.active,
      isPanorama: m => m?.raw?.class === 'Panorama',
      getMainViewer: () => T.byId('MainViewer'),
      getComponentByName: name => T.all('Container').concat(T.all('Image'), T.all('IconButton')).find(o => o.raw.data?.name === name) || null,
      getMediaByName: name => T.all('Panorama').concat(T.all('Video')).find(m => m.raw.data?.label === name || m.raw.label === name) || null,
      getPanoramaOverlayByName(pano, name) { return (pano.get('overlays') || []).find(o => o?.raw.data?.label === name) || null; },
      getOverlays: pano => pano?.get('overlays') || [],
      getPlayListItems: (pl) => pl?.get('items') || [],
      getPlayListItemByMedia(pl, media) { return (pl.get('items') || []).find(i => i.raw.media === 'this.' + media.id) || null; },
      getPlayListItemIndexByMedia(pl, media) { return (pl.get('items') || []).findIndex(i => i.raw.media === 'this.' + media.id); },
      getActivePlayerWithViewer: () => T.byId('MainViewerPanoramaPlayer'),
      setPlayListSelectedIndex(pl, i) { P.select(pl, i); },
      setMainMediaByIndex(i) { P.select(T.byId('mainPlayList'), i); },
      setMainMediaByName(name) { const m = S.getMediaByName(name); if (m) { const pl = T.byId('mainPlayList'); P.select(pl, S.getPlayListItemIndexByMedia(pl, m)); } },
      setEndToItemIndex(pl, from, to) { if (!pl) return; const m = P.endMap.get(pl.id) || {}; m[from] = to; P.endMap.set(pl.id, m); },
      setPanoramaCameraWithSpot(pl, item, yaw, pitch, hfov) { if (item) P.nextCamera.set(item.raw, { yaw, pitch, hfov }); },
      setPanoramaCameraWithCurrentSpot(item) { if (item) P.nextCamera.set(item.raw, { yaw: P.viewer.yaw, pitch: P.viewer.pitch, hfov: P.viewer.hfov }); },
      setCameraSameSpotAsMedia() {},
      fixTogglePlayPauseButton() {},
      changeBackgroundWhilePlay() {},
      changeOpacityWhilePlay() {},
      pauseGlobalAudiosWhilePlayItem(pl, idx) {
        const item = (pl?.get('items') || [])[idx];
        if (!item) return;
        if ((pl.raw.selectedIndex === idx)) P.pauseGlobalAudios();
        const onEnd = (i) => { if (i === idx) { P.resumeGlobalAudios(); pl.unbind('end', onEnd); } };
        pl.bind('end', onEnd);
      },
      playAudioList(list, loop) {
        for (const au of [].concat(list || [])) {
          const a = P._audioEl(au);
          if (a) { P.globalAudios.add(a); P.playAudio(a, loop !== false); }
        }
      },
      playGlobalAudio(au, loop) { S.playAudioList([au], loop); },
      playGlobalAudioWhilePlay(pl, idx, au) { S.playAudioList([au], true); },
      pauseGlobalAudio(au) { au?._el?.pause(); },
      stopGlobalAudio(au) { if (au?._el) { au._el.pause(); au._el.currentTime = 0; au._el._wantPlay = false; } },
      pauseGlobalAudios: () => P.pauseGlobalAudios(),
      resumeGlobalAudios: () => P.resumeGlobalAudios(),
      stopGlobalAudios() { for (const a of P.globalAudios) { a.pause(); a._wantPlay = false; } },
      visibleComponentsIfPlayerFlagEnabled(comps, flag) { for (const c of [].concat(comps || [])) c?.set('visible', !!T.flags[flag]); },
      isComponentVisible(c) { return !!c && c.raw.visible !== false; },
      setComponentVisibility(c, visible, applyAt, effect, propEffect, ignoreClearTimeout) {
        if (!c) return;
        if (effect && propEffect) c.raw[propEffect] = effect instanceof TObj ? effect.raw : effect;
        else if (propEffect) delete c.raw[propEffect];
        const go = () => c.set('visible', !!visible);
        if (applyAt > 0) setTimeout(go, applyAt * 1000); else go();
      },
      setObjectsVisibility(objs, v) { for (const o of [].concat(objs || [])) o?.set(o.raw.class === 'HotspotPanoramaOverlay' ? 'enabled' : 'visible', v); },
      setOverlaysVisibility(objs, v) { for (const o of [].concat(objs || [])) { if (o) { o.raw.enabled = v; } } P.viewer.refreshHotspots(); },
      triggerOverlay(ov, ev) { (ov?.get('areas') || []).forEach(a => a.trigger(ev || 'click')); },
      openLink(url, target) {
        if (!url) return;
        if (target === '_self' || target === '_top') location.href = url;
        else window.open(url, target || '_blank', 'noopener');
      },
      shareSocial(net, url) {
        const u = encodeURIComponent(url || location.href);
        const map = {
          facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
          twitter: `https://twitter.com/intent/tweet?url=${u}`,
          linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
          whatsapp: `https://wa.me/?text=${u}`,
          email: `mailto:?body=${u}`
        };
        if (map[net]) window.open(map[net], '_blank', 'noopener');
      },
      copyToClipboard(t) { navigator.clipboard?.writeText(t); },
      enableVR() { P.vr?.enter(); },
      disableVR() { P.vr?.exit(); },
      toggleVR() { P.vr?.active ? P.vr.exit() : P.vr?.enter(); },
      historyGoBack() { if (P.historyPos > 0) { P.historyPos--; P._navHistory = true; P.select(T.byId('mainPlayList'), P.history[P.historyPos]); } },
      historyGoForward() { if (P.historyPos < P.history.length - 1) { P.historyPos++; P._navHistory = true; P.select(T.byId('mainPlayList'), P.history[P.historyPos]); } },
      showPopupMedia(win, media, pl, w, h, autoClose) {
        if (!win || !media) return;
        const { url, poster } = P._videoUrl(media);
        const idx = (pl?.get('items') || []).findIndex(i => i.raw.media === 'this.' + media.id);
        const item = idx >= 0 ? pl.get('items')[idx] : null;
        let v;
        const api = P.ui.showWindowMedia(win, media, {
          width: w, height: h,
          onClose: () => { v.pause(); v.removeAttribute('src'); v.load(); if (pl) { pl.raw.selectedIndex = -1; pl.emit('end', idx); } P.resumeGlobalAudios(); }
        });
        v = document.createElement('video');
        v.src = url; v.poster = poster || '';
        v.controls = true; v.playsInline = true; v.autoplay = true; v.muted = P.muted;
        api.content.appendChild(v);
        if (item) { pl.raw.selectedIndex = idx; item.trigger('begin'); item.trigger('start'); }
        v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
        if (autoClose) v.addEventListener('ended', () => api.close());
      },
      showPopupPanoramaVideoOverlay(popup, closeProps, stopAudios) {
        P.vr?.showPopupVideo(popup, stopAudios !== false);
      },
      showPopupImage(image, toggleImage, customWidth, customHeight) {
        const lvl = image?.raw?.levels?.[0] || T.rawOf(image)?.levels?.[0];
        const url = lvl?.url;
        if (!url) return;
        const win = { raw: { veilOpacity: 0.55, veilColor: ['#000000'], modal: true } };
        const api = P.ui.showWindowMedia(win, null, { width: customWidth || '90%', height: customHeight || '90%' });
        const im = document.createElement('div');
        im.className = 'popup-image';
        im.style.backgroundImage = `url("${url}")`;
        api.content.appendChild(im);
      },
      showWindow(win) { win?.set('visible', true); },
      executeJS(code) { try { (0, eval)(code); } catch (e) { console.warn(e); } },
      setValue(obj, prop, v) { obj?.set(prop, v); },
      updateDeepLink() {}, updateMediaLabelFromPlayList() {}, syncPlaylists() {}, registerKey() {}, unregisterKey() {}, existsKey: () => false, getKey: () => undefined,
      sendAnalyticsData() {}, initAnalytics() {}, autotriggerAtStart() {}, keepCompVisible() {}, setOverlayBehaviour() {},
      pauseCurrentPlayers() { P.video?.pause(); }, resumePlayers() { P.video?.play().catch(() => {}); },
      setLocale() {}, textToSpeech() {}, stopTextToSpeech() {}
    });
  }
}

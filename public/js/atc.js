// atc.js — live ATC audio for the facility an overhead/hovered aircraft is working.
//
// ONE audible stream at a time. Everything routes through a single <audio> element,
// arbitrated by a priority resolver so the operator never hears overlapping voices:
//   manual (hovered tower / focused plane's tower)  >  kept (a ticked tower)  >  follow
//   (the facility nearest whatever flight is closest to the zenith, hands-free).
// (Previously each ticked tower spawned its OWN Audio element and the auto-follow ran on
// a second element with no coordination — so several voices played at once.)
//
// A WebAudio analyser on that single stream detects voice activity ("someone is
// transmitting right now"); for a plane-derived feed it reports WHICH flight is on-air so
// the dome/scope can highlight it. Feeds are proxied same-origin via /api/atc, so the
// analyser is not CORS-tainted. Honest caveat: LiveATC streams a tower FREQUENCY, not a
// specific cockpit — we follow the facility working the flight, not the exact speaker.

const COVERAGE_KM = 280; // only claim a feed when a verified facility is this close
const RETUNE_MS = 6000;  // debounce the auto-follow slot so overhead churn can't thrash it
const VAD_RMS = 0.018;   // voice-activity RMS threshold (open-channel hiss sits below this)
const VAD_HANG = 10;     // frames to hold "talking" after the level drops (debounce squelch)

export class AtcAudio {
  constructor() {
    this.feeds = [];
    this._feedById = new Map();
    this.enabled = false;

    // intent slots (priority: manual > kept > follow); each setter just re-resolves
    this.manual = null;    // {id,label,kind:'tower'|'plane',callsign?,entryId?,distKm?}
    this.kept = new Map();  // id -> {id,label} ticked towers (audible = most-recently ticked)
    this.follow = null;    // {id,label,kind:'plane',callsign,entryId,distKm}
    this._followAt = 0;
    this._winner = null;

    this.currentId = null;      // feed id currently playing
    this.currentEntryId = null; // plane id whose feed is playing (null for a tower feed)

    this.audio = new Audio();
    this.audio.preload = 'none';
    this.audio.volume = 0.8;

    this.chip = document.getElementById('atc-chip');
    this.nameEl = document.getElementById('atc-name');
    document.getElementById('atc-vol')?.addEventListener('input', (e) => { this.audio.volume = parseFloat(e.target.value); });
    document.getElementById('atc-stop')?.addEventListener('click', () => this.stop());
    this.audio.addEventListener('playing', () => { this._chip(true, false); clearTimeout(this._retryT); });
    this.audio.addEventListener('error', () => this._fail());

    // voice-activity graph (created lazily on first play; resumed on any user gesture)
    this.ctx = null; this.srcNode = null; this.analyser = null; this._vbuf = null;
    this._talking = false; this._hang = 0; this._onVoice = null;
    this._muted = false;   // sticky Stop: suppresses playback (incl. auto-follow) until the user acts again
    this._retryT = 0;
    // Build the analysis graph ONLY inside a real user gesture. A MediaElementSource makes the
    // (autoplay-suspended) AudioContext the element's ONLY output path — which is silent on a
    // no-interaction kiosk. Until the first gesture the plain <audio> plays directly and VAD is
    // simply off; after it, the running context enables the "on air" indicator.
    document.addEventListener('pointerdown', () => { if (!this.ctx) this._initGraph(); this.ctx?.resume?.(); });

    this._feedsCb = null;
    fetch('/api/atc').then((r) => r.json()).then((d) => {
      this.feeds = d.feeds || [];
      for (const f of this.feeds) this._feedById.set(f.id, f);
      if (this._feedsCb) this._feedsCb(this.feeds);
    }).catch(() => {});
  }

  onFeeds(cb) { this._feedsCb = cb; if (this.feeds.length) cb(this.feeds); }
  onVoice(cb) { this._onVoice = cb; }   // cb(entryId|null) when transmission starts/stops

  setEnabled(on) { this.enabled = on; if (!on) this.stop(); else { this._muted = false; this._resolve(); } }

  // ---- intent setters (mutate a slot, then re-resolve) --------------------------
  // Hovered TOWER: highest priority, transient.
  tuneFeed(feed) { this._muted = false; this.manual = feed ? { id: feed.id, label: feed.label, kind: 'tower' } : null; this._resolve(); }
  // Focused / hovered PLANE: follow its facility at manual priority.
  tune(entry) { this._muted = false; this.manual = this._planeFeed(entry); this._resolve(); }
  clearManual() { if (this.manual) { this.manual = null; this._resolve(); } }

  // Persistent "kept" towers (the options-panel checkboxes). Now membership in a set,
  // NOT a second audio element — only the most-recently ticked is ever audible.
  isListening(id) { return this.kept.has(id); }
  listen(feed) { this._muted = false; this.kept.set(feed.id, { id: feed.id, label: feed.label }); this._resolve(); }
  unlisten(id) { if (this.kept.delete(id)) this._resolve(); }

  // Auto hands-free: nearest facility to the zenith-most flight (lowest priority, debounced).
  followOverhead(entry) {
    const f = this._planeFeed(entry);
    if (!f) { if (this.follow) { this.follow = null; this._resolve(); } return; }
    if (this.follow && f.id === this.follow.id) { this.follow = f; if (this.currentId === f.id) this._refreshLabel(); return; }
    const now = performance.now();
    if (this.follow && now - this._followAt < RETUNE_MS) return;  // debounce ONLY the follow slot
    this.follow = f; this._followAt = now; this._resolve();
  }

  // Back-compat: tune the facility nearest a raw position (kept for any external callers).
  tuneForAircraft(lat, lon, callsign = '') {
    const n = this._nearestFeed(lat, lon);
    this.follow = n ? { id: n.feed.id, label: n.feed.label, kind: 'plane', callsign, entryId: null, distKm: n.distKm } : null;
    this._resolve();
  }

  stop() {
    this._muted = true; clearTimeout(this._retryT);   // sticky: auto-follow won't silently undo Stop
    this.manual = null; this.follow = null; this._winner = null;
    this.audio.pause();
    this.currentId = null; this.currentEntryId = null;
    this._setTalking(false);
    this._chip(false);
  }

  // ---- resolver: the ONLY place that sets audio.src / play / pause ---------------
  _resolve() {
    if (!this.enabled || this._muted) { this.audio.pause(); this.currentId = null; this._setTalking(false); return; }

    let win = this.manual;
    if (!win && this.kept.size) win = { ...[...this.kept.values()].pop(), kind: 'tower' };
    if (!win) win = this.follow;

    if (!win) {   // nothing to play — be honest if we had a live channel, else hide the chip
      this._winner = null; this.currentEntryId = null;
      if (this.currentId && this.currentId !== '_none') { this.audio.pause(); this.currentId = '_none'; }
      if (this.currentId === '_none') { this.nameEl.textContent = 'no ATC feed in range'; this._chip(true, false); }
      this._setTalking(false);
      return;
    }

    this._winner = win;
    this.currentEntryId = win.kind === 'plane' ? win.entryId : null;
    if (win.id === this.currentId) { this._refreshLabel(); return; }  // already playing it

    this.currentId = win.id;
    this._refreshLabel();
    this._chip(true, true);                 // show immediately in a "tuning…" state
    this.audio.src = `/api/atc/${win.id}`;
    this.audio.play().catch(() => this._fail());
    this.ctx?.resume?.();
  }

  _refreshLabel() {
    const w = this._winner; if (!w || !this.nameEl) return;
    let t = w.label;
    if (w.kind === 'plane') { if (w.distKm != null) t += ` · ${Math.round(w.distKm)} km`; if (w.callsign) t += ` · ${w.callsign}`; }
    this.nameEl.textContent = t;
  }

  // ---- feed lookup --------------------------------------------------------------
  _planeFeed(entry) {
    const cur = entry?.cur || entry?.render;
    if (!cur) return null;
    const n = this._nearestFeed(cur.lat, cur.lon);
    if (!n) return null;
    return { id: n.feed.id, label: n.feed.label, kind: 'plane', callsign: (entry?.state?.callsign || '').trim(), entryId: entry.id, distKm: n.distKm };
  }
  _nearestFeed(lat, lon) {
    if (lat == null || lon == null || !this.feeds.length) return null;
    let best = null, bestD = Infinity;
    for (const f of this.feeds) { const d = haversine(lat, lon, f.lat, f.lon); if (d < bestD) { bestD = d; best = f; } }
    if (!best || bestD > COVERAGE_KM) return null;
    return { feed: best, distKm: bestD };
  }

  // ---- voice-activity detection (single stream, same-origin, so not CORS-tainted) --
  _initGraph() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.srcNode = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.5;
      this.srcNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);   // MUST route to destination or audio goes silent
      this._vbuf = new Float32Array(this.analyser.fftSize);
    } catch { this.ctx = null; }   // once created, a MediaElementSource sticks to this element
  }

  // Call each animation frame. Returns true while the channel has voice on it.
  sampleVoice() {
    if (!this.analyser || this.audio.paused || !this.currentId || this.currentId === '_none') { this._setTalking(false); return false; }
    this.analyser.getFloatTimeDomainData(this._vbuf);
    let sum = 0;
    for (let i = 0; i < this._vbuf.length; i++) { const v = this._vbuf[i]; sum += v * v; }
    const rms = Math.sqrt(sum / this._vbuf.length);
    if (rms > VAD_RMS) this._hang = VAD_HANG; else if (this._hang > 0) this._hang--;
    this._setTalking(this._hang > 0);
    return this._talking;
  }

  _setTalking(on) {
    if (on === this._talking) return;
    this._talking = on;
    this.chip?.classList.toggle('talking', on);
    if (this._onVoice) this._onVoice(on ? this.currentEntryId : null);
  }

  _chip(show, tuning = false) {
    if (!this.chip) return;
    this.chip.hidden = !show;
    this.chip.classList.toggle('tuning', tuning);
  }

  _fail() {
    if (!this.currentId || this.currentId === '_none') return;
    if (this.nameEl) this.nameEl.textContent = 'feed offline';
    this.chip?.classList.remove('tuning');
    // Clear the id so the resolver doesn't treat the dead stream as "already playing" (a media
    // error is terminal for the src); retry shortly so a transient upstream 5xx self-heals.
    this.currentId = null; this.currentEntryId = null;
    this._setTalking(false);
    clearTimeout(this._retryT);
    this._retryT = setTimeout(() => this._resolve(), 5000);
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

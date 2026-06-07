// atc.js — live ATC audio for the facility an overhead/hovered aircraft is working.
//
// Honest caveat: per-aircraft *cockpit* audio is not public anywhere, and no free
// source exposes a specific plane's "last transmission". The realistic, free
// stand-in is the ATC frequency that aircraft is actually talking on, streamed
// live by LiveATC.net — that feed carries the plane's real radio calls. We tune
// the nearest verified major tower TO THE PLANE (not the observer) and proxy it
// through our server (see /api/atc). It runs hands-free: when a flight is near
// the zenith it auto-tunes its facility; hovering/focusing a plane overrides it.

const COVERAGE_KM = 280; // only claim a feed when a verified facility is this close
const RETUNE_MS = 6000;  // debounce: don't switch the overhead feed faster than this

export class AtcAudio {
  constructor() {
    this.feeds = [];        // [{id,label,lat,lon}]
    this.enabled = false;
    this.currentId = null;  // feed currently tuned
    this.currentCall = '';  // callsign of the aircraft we're following (for the chip)
    this._lastTuneAt = 0;   // when we last switched the overhead feed (debounce)
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.audio.volume = 0.8;

    this.chip = document.getElementById('atc-chip');
    this.nameEl = document.getElementById('atc-name');
    const vol = document.getElementById('atc-vol');
    const stop = document.getElementById('atc-stop');
    vol?.addEventListener('input', () => {
      const v = parseFloat(vol.value);
      this.audio.volume = v;
      for (const a of this.listeners.values()) a.volume = v;
    });
    stop?.addEventListener('click', () => this.stop());

    this.audio.addEventListener('playing', () => this._chip(true));
    this.audio.addEventListener('error', () => this._fail());

    this.listeners = new Map(); // id -> Audio, persistent multi-tower listening
    this._feedsCb = null;

    // load the verified feed list once
    fetch('/api/atc').then((r) => r.json()).then((d) => {
      this.feeds = d.feeds || [];
      if (this._feedsCb) this._feedsCb(this.feeds);
    }).catch(() => {});
  }

  // notify when the verified feed list is loaded (for tower markers + options)
  onFeeds(cb) { this._feedsCb = cb; if (this.feeds.length) cb(this.feeds); }

  // Tower hover: play a SPECIFIC facility on the shared hover channel (independent
  // of the plane-hover toggle). Re-uses the same chip + audio element.
  tuneFeed(feed) {
    if (!feed || this.currentId === feed.id) return;
    this.currentId = feed.id;
    this.currentCall = '';
    this._lastTuneAt = performance.now();
    this.nameEl.textContent = feed.label;
    this._chip(true, true);
    this.audio.src = `/api/atc/${feed.id}`;
    this.audio.play().catch(() => this._fail());
  }

  // Persistent multi-tower listening (driven by the options checkboxes).
  isListening(id) { return this.listeners.has(id); }
  listen(feed) {
    if (this.listeners.has(feed.id)) return;
    const a = new Audio(`/api/atc/${feed.id}`);
    a.volume = this.audio.volume;
    a.play().catch(() => {});
    this.listeners.set(feed.id, a);
  }
  unlisten(id) {
    const a = this.listeners.get(id);
    if (!a) return;
    a.pause(); a.removeAttribute('src'); a.load();
    this.listeners.delete(id);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop();
  }

  // Tune the nearest verified facility to this aircraft (only re-tunes on change).
  // Note: there is no free source for a *specific aircraft's* past transmissions,
  // so when no facility is in range we say so honestly rather than fake audio.
  // `entry.cur` is the plane's live ground position; `entry.state.callsign` (if
  // known) is shown in the chip so it's clear which flight we're listening for.
  tune(entry) {
    const cur = entry?.cur;
    if (!cur) return;
    const callsign = (entry?.state?.callsign || '').trim();
    this.tuneForAircraft(cur.lat, cur.lon, callsign);
  }

  // Auto-play the live ATC feed for the facility nearest a given aircraft position.
  // Picks by great-circle distance to the *plane* (not the observer) — that's the
  // facility most likely working it. Debounced so a churn of overhead planes can't
  // thrash the stream, and it won't restart a feed that's already playing.
  tuneForAircraft(lat, lon, callsign = '') {
    if (!this.enabled || !this.feeds.length) return;
    if (lat == null || lon == null) return;

    let best = null, bestD = Infinity;
    for (const f of this.feeds) {
      const d = haversine(lat, lon, f.lat, f.lon);
      if (d < bestD) { bestD = d; best = f; }
    }

    // Out of range of every verified facility: say so honestly (no faked audio).
    if (!best || bestD > COVERAGE_KM) {
      if (this.currentId !== '_none') {
        this.currentId = '_none';
        this.currentCall = '';
        this.audio.pause();
        this.nameEl.textContent = 'no ATC feed in range';
        this._chip(true, false);
      }
      return;
    }

    // Already on this feed: just keep the callsign label fresh, don't restart.
    if (best.id === this.currentId) {
      if (callsign && callsign !== this.currentCall) {
        this.currentCall = callsign;
        this.nameEl.textContent = this._label(best, bestD, callsign);
      }
      return;
    }

    // Debounce: a different feed wants the channel. Only switch if the previous
    // switch is older than RETUNE_MS, so transient overhead churn can't thrash it.
    // We don't queue the candidate — our callers re-tune on a tick, so the next
    // call past the window simply recomputes the (now stable) nearest facility.
    const now = performance.now();
    if (this.currentId && this.currentId !== '_none' && now - this._lastTuneAt < RETUNE_MS) {
      return;
    }

    this._switchTo(best, bestD, callsign);
  }

  _switchTo(feed, distKm, callsign) {
    this.currentId = feed.id;
    this.currentCall = callsign || '';
    this._lastTuneAt = performance.now();
    this.nameEl.textContent = this._label(feed, distKm, callsign);
    this._chip(true, true); // show immediately in a "tuning…" state
    this.audio.src = `/api/atc/${feed.id}`;
    this.audio.play().catch(() => this._fail());
  }

  // Chip text: facility + how far it is from the plane, and the flight we're
  // following so it's obvious whose ATC this is (e.g. "KLAX Tower · 12 km · UAL1").
  _label(feed, distKm, callsign) {
    const base = `${feed.label} · ${Math.round(distKm)} km`;
    return callsign ? `${base} · ${callsign}` : base;
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.currentId = null;
    this.currentCall = '';
    this._chip(false);
  }

  _chip(show, tuning = false) {
    if (!this.chip) return;
    this.chip.hidden = !show;
    this.chip.classList.toggle('tuning', tuning);
  }

  _fail() {
    if (!this.currentId || this.currentId === '_none') return;
    this.nameEl.textContent = 'feed offline';
    this.chip.classList.remove('tuning');
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

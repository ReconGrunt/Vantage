// atc.js — live ATC audio for the facility a hovered aircraft is working.
//
// Honest caveat: per-aircraft *cockpit* audio is not public anywhere. The free,
// realistic stand-in is the ATC frequency that aircraft is actually talking on,
// streamed by LiveATC.net. We tune the nearest verified major tower to the
// hovered plane and proxy it through our server (see /api/atc). Off by default.

const COVERAGE_KM = 280; // only claim a feed when a verified facility is this close

export class AtcAudio {
  constructor() {
    this.feeds = [];        // [{id,label,lat,lon}]
    this.enabled = false;
    this.currentId = null;  // feed currently tuned
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
  tune(entry) {
    if (!this.enabled || !this.feeds.length) return;
    const cur = entry?.cur;
    if (!cur) return;
    let best = null, bestD = Infinity;
    for (const f of this.feeds) {
      const d = haversine(cur.lat, cur.lon, f.lat, f.lon);
      if (d < bestD) { bestD = d; best = f; }
    }
    // Only tune a facility the aircraft could plausibly be working with.
    if (!best || bestD > COVERAGE_KM) {
      if (this.currentId !== '_none') {
        this.currentId = '_none';
        this.audio.pause();
        this.nameEl.textContent = 'no ATC feed in range';
        this._chip(true, false);
      }
      return;
    }
    if (best.id === this.currentId) return;
    this.currentId = best.id;
    this.nameEl.textContent = `${best.label} · ${Math.round(bestD)} km`;
    this._chip(true, true); // show immediately in a "tuning…" state
    this.audio.src = `/api/atc/${best.id}`;
    this.audio.play().catch(() => this._fail());
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.currentId = null;
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

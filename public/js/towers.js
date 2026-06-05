// towers.js — local ATC facilities drawn as markers on the horizon at their true
// bearing from the observer. Hovering one tunes its LiveATC feed; the options
// panel lets you keep one or several playing. Only verified feeds within range
// are shown (see server /api/atc).

import * as THREE from 'three';
import { lookAngles, domePosition } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';

const TOWER_ELEV_DEG = 3;     // sit just above the horizon
const DEFAULT_MAX_KM = 450;   // "local" radius for showing a facility

export class TowerLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'towers';
    this.feeds = [];
    this.markers = [];          // { id, label, distKm, sprite }
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }
  setFeeds(feeds) { this.feeds = feeds || []; }

  // Rebuild the in-range markers for a given observer; returns the marker list
  // (sorted nearest-first) so the UI can build its options checkboxes.
  setObserver(observer, maxKm = DEFAULT_MAX_KM) {
    for (const m of this.markers) {
      this.group.remove(m.sprite);
      m.sprite.material.map?.dispose();
      m.sprite.material.dispose();
    }
    this.markers = [];
    if (!observer) return this.markers;

    for (const f of this.feeds) {
      if (f.lat == null || f.lon == null) continue;
      const look = lookAngles(observer, { lat: f.lat, lon: f.lon, alt: 0 });
      const distKm = look.range / 1000;
      if (distKm > maxKm) continue;
      const sprite = makeTextSprite(`🗼 ${f.label}\n${Math.round(distKm)} km`, 0x8fd0ff, 20);
      sprite.position.copy(domePosition(look.azimuth, TOWER_ELEV_DEG, SHELLS.aircraft));
      sprite.userData = { kind: 'tower', id: f.id, label: f.label };
      sprite.renderOrder = 7;
      this.group.add(sprite);
      this.markers.push({ id: f.id, label: f.label, distKm, sprite });
    }
    this.markers.sort((a, b) => a.distKm - b.distKm);
    return this.markers;
  }

  pickables() {
    return this.group.visible ? this.markers.map((m) => m.sprite) : [];
  }
}

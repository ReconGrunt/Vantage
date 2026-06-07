// clouds.js — a procedural cloud deck whose STRUCTURE matches the real weather at
// the observer's location (Open-Meteo). It renders three decks separately, each
// driven by its own live coverage figure so the sky looks like what's actually up
// there:
//   · LOW  (0–2 km)  cumulus / stratus — fat, opaque, soft-shaded puffs
//   · MID  (2–7 km)  altocumulus — smaller, lighter dapples
//   · HIGH (7–12 km) cirrus / cirrostratus — a thin, streaky, translucent veil
// So a sky that's reported as 100 % high cloud renders as a faint cirrus haze (not
// fat cumulus blobs), and a low overcast renders as a solid grey deck. Clouds
// drift with the reported wind, are lit by the real Sun (white by day, grey/orange
// at dusk, dark at night), and thin out toward the horizon.

import * as THREE from 'three';
import { SHELLS } from './sky.js';

export class CloudLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    // eased per-deck coverage (0..1) so transitions are smooth
    this.cov = { low: 0, mid: 0, high: 0 };
    this.target = { low: 0, mid: 0, high: 0 };

    // upper-hemisphere shell, just inside the stars so clouds occlude them
    const geo = new THREE.SphereGeometry(SHELLS.stars - 80, 64, 32, 0, Math.PI * 2, 0, Math.PI * 0.52);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCovLow: { value: 0 },
        uCovMid: { value: 0 },
        uCovHigh: { value: 0 },
        uWind: { value: new THREE.Vector2(0.01, 0.0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunAlt: { value: -90 },
        uOpacity: { value: 0.95 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        varying vec3 vDir;
        uniform float uTime, uCovLow, uCovMid, uCovHigh, uSunAlt, uOpacity;
        uniform vec2 uWind; uniform vec3 uSunDir;

        float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
        float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
          float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
          return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
        float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5;} return v; }

        // one cloud deck: noise field -> coverage-driven density, faded at horizon.
        // soft = edge softness (cirrus is broad/feathery, cumulus is crisper).
        float deck(vec2 p, float cover, float soft, float horizon) {
          if (cover <= 0.001) return 0.0;
          float n = fbm(p) * 0.6 + fbm(p * 2.7 + 7.3) * 0.4;
          // map coverage 0..1 to a threshold; at full cover the deck is near-gapless
          float thresh = mix(1.02, 0.02, cover);
          float dens = smoothstep(thresh, thresh + soft, n);
          return dens * horizon;
        }

        void main() {
          float alt = vDir.y;
          if (alt < 0.02) discard;
          float horizon = smoothstep(0.02, 0.12, alt) * (0.6 + 0.4 * smoothstep(0.0, 0.55, alt));

          // sky direction projected onto a flat deck (perspective spread to horizon)
          vec2 pc = vDir.xz / max(alt, 0.10);
          vec2 drift = uWind * uTime;

          // LOW cumulus — fat crisp puffs (large blobs), opaque
          float dLow  = deck(pc * 1.25 + drift,               uCovLow,  0.20, horizon);
          // MID altocumulus — finer dapples
          float dMid  = deck(pc * 2.6  + drift * 1.3 + 19.0,  uCovMid,  0.26, horizon);
          // HIGH cirrus — streaked along one axis, broad & feathery, translucent
          vec2 ph = vec2(pc.x * 0.40, pc.y * 2.1) * 1.5 + drift * 0.6 + 41.0;
          float dHigh = deck(ph,                               uCovHigh, 0.42, horizon);

          // lighting: day bright, dusk warm, night dark
          float day = smoothstep(-6.0, 8.0, uSunAlt);
          float civil = smoothstep(-12.0, 0.0, uSunAlt);
          float sd = max(dot(vDir, normalize(uSunDir)), 0.0);
          vec3 dusk = vec3(1.0, 0.55, 0.30);
          vec3 nightCol = vec3(0.05, 0.06, 0.09);

          // low/mid decks: grey-shaded undersides (we look up at their base)
          vec3 lowLit = mix(vec3(0.66, 0.68, 0.73), vec3(0.86, 0.88, 0.91), day);
          lowLit = mix(lowLit, dusk, pow(sd, 4.0) * civil * (1.0 - day) * 0.8);
          vec3 lowCol = mix(nightCol, lowLit, max(day, civil * 0.5));
          // high cirrus: bright, slightly cool, catches sun longer
          vec3 highLit = mix(vec3(0.82, 0.85, 0.92), vec3(0.97, 0.98, 1.0), day);
          highLit = mix(highLit, dusk, pow(sd, 3.0) * civil * (1.0 - day) * 0.9);
          vec3 highCol = mix(nightCol, highLit, max(day, civil * 0.6));

          // per-deck opacity: cirrus is thin, cumulus is solid
          float aHigh = dHigh * 0.42;
          float aMid  = dMid  * 0.72;
          float aLow  = dLow  * 0.94;

          // composite far(high) -> near(low) with premultiplied alpha
          vec3 pc3 = highCol * aHigh; float pa = aHigh;          // high deck
          pc3 = lowCol * aMid + pc3 * (1.0 - aMid); pa = aMid + pa * (1.0 - aMid); // mid
          pc3 = lowCol * aLow + pc3 * (1.0 - aLow); pa = aLow + pa * (1.0 - aLow); // low

          float a = pa * uOpacity;
          if (a < 0.004) discard;
          vec3 col = pc3 / max(pa, 0.001);   // un-premultiply for straight-alpha blend
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }

  // weather: { cloudCover, cloudLow, cloudMid, cloudHigh (%), windDir (deg), windSpeed (km/h) }
  setWeather(w) {
    if (!w) return;
    const total = clamp01((w.cloudCover ?? 0) / 100);
    // Prefer the real per-deck split; if the API omitted it, fall back to putting
    // the total on the low deck so we still show *something* sensible.
    const has = (w.cloudLow != null || w.cloudMid != null || w.cloudHigh != null);
    this.target.low  = clamp01((has ? (w.cloudLow  ?? 0) : (w.cloudCover ?? 0)) / 100);
    this.target.mid  = clamp01((w.cloudMid  ?? 0) / 100);
    this.target.high = clamp01((w.cloudHigh ?? 0) / 100);
    if (!has) { this.target.mid = 0; this.target.high = 0; this.target.low = total; }

    const dir = (w.windDir ?? 0) * Math.PI / 180;
    const spd = 0.004 + (w.windSpeed ?? 0) / 8000; // gentle drift
    this.material.uniforms.uWind.value.set(Math.sin(dir) * spd, Math.cos(dir) * spd);
  }

  // overall sky obscuration (0..1) so the star layer can dim to match. Low/mid
  // decks block far more light than a thin cirrus veil, so weight accordingly.
  get currentCoverage() {
    const { low, mid, high } = this.cov;
    return clamp01(1 - (1 - low) * (1 - mid * 0.85) * (1 - high * 0.35));
  }

  update(tSec, sunDir, sunAltDeg) {
    if (!this.group.visible) return;
    // ease each deck toward its live target
    for (const k of ['low', 'mid', 'high']) this.cov[k] += (this.target[k] - this.cov[k]) * 0.02;
    const u = this.material.uniforms;
    u.uTime.value = tSec;
    u.uCovLow.value = this.cov.low;
    u.uCovMid.value = this.cov.mid;
    u.uCovHigh.value = this.cov.high;
    u.uSunDir.value.copy(sunDir);
    u.uSunAlt.value = sunAltDeg;
  }
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

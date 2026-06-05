// clouds.js — a procedural cloud deck whose coverage matches the real weather
// at the observer's location (from Open-Meteo). Clouds drift with the reported
// wind, are lit by the real Sun (white by day, grey/orange at dusk, dark at
// night), and thin out toward the horizon. When it's overcast the deck also dims
// the stars (handled by the star layer).

import * as THREE from 'three';
import { SHELLS } from './sky.js';

export class CloudLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'clouds';
    this.coverage = 0;
    this.target = 0;

    // upper-hemisphere shell, just inside the stars so clouds occlude them
    const geo = new THREE.SphereGeometry(SHELLS.stars - 80, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.52);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCoverage: { value: 0 },
        uWind: { value: new THREE.Vector2(0.01, 0.0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunAlt: { value: -90 },
        uOpacity: { value: 0.92 },
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
        uniform float uTime, uCoverage, uSunAlt, uOpacity;
        uniform vec2 uWind; uniform vec3 uSunDir;

        float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
        float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
          float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
          return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
        float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5;} return v; }

        void main() {
          float alt = vDir.y;
          if (alt < 0.02) discard;
          // project sky direction onto a cloud-deck plane (perspective spread to horizon)
          vec2 pc = vDir.xz / max(alt, 0.10) * 1.4 + uWind * uTime;
          float n = fbm(pc) * 0.6 + fbm(pc * 2.7 + 7.3) * 0.4;

          float thresh = mix(0.92, 0.06, uCoverage);     // more coverage -> lower threshold
          float dens = smoothstep(thresh, thresh + 0.22, n);

          // thin out toward the horizon and fade in just above it
          float horizon = smoothstep(0.02, 0.12, alt);
          dens *= horizon * (0.65 + 0.35 * smoothstep(0.0, 0.6, alt));

          // lighting: day bright, dusk warm, night dark
          float day = smoothstep(-6.0, 8.0, uSunAlt);
          float civil = smoothstep(-12.0, 0.0, uSunAlt);
          vec3 lit = mix(vec3(0.78, 0.80, 0.86), vec3(0.96, 0.97, 1.0), day);
          vec3 dusk = vec3(1.0, 0.55, 0.30);
          float sd = max(dot(vDir, normalize(uSunDir)), 0.0);
          lit = mix(lit, dusk, pow(sd, 4.0) * civil * (1.0 - day) * 0.8);
          vec3 night = vec3(0.06, 0.07, 0.10);
          vec3 col = mix(night, lit, max(day, civil * 0.5));

          float a = dens * uOpacity;
          if (a < 0.004) discard;
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

  // weather: { cloudCover (%), windDir (deg), windSpeed (km/h) }
  setWeather(w) {
    if (!w) return;
    this.target = THREE.MathUtils.clamp((w.cloudCover ?? 0) / 100, 0, 1);
    const dir = (w.windDir ?? 0) * Math.PI / 180;
    const spd = 0.004 + (w.windSpeed ?? 0) / 8000; // gentle drift
    this.material.uniforms.uWind.value.set(Math.sin(dir) * spd, Math.cos(dir) * spd);
  }

  // current eased coverage (so the star layer can dim to match)
  get currentCoverage() { return this.coverage; }

  update(tSec, sunDir, sunAltDeg) {
    if (!this.group.visible) return;
    this.coverage += (this.target - this.coverage) * 0.02; // ease toward target
    const u = this.material.uniforms;
    u.uTime.value = tSec;
    u.uCoverage.value = this.coverage;
    u.uSunDir.value.copy(sunDir);
    u.uSunAlt.value = sunAltDeg;
  }
}

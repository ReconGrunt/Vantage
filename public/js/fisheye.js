// fisheye.js — a true 180° azimuthal-equidistant "dome master" for projecting
// onto a flat ceiling. We capture the whole surroundings from the observer with
// a CubeCamera, then remap the upper hemisphere onto a circular disc: centre =
// zenith (straight up), disc edge = horizon. Lie under the projector and the sky
// maps to the ceiling correctly. A North-orientation control aligns it to the room.

import * as THREE from 'three';

export class FisheyeDome {
  constructor(res = 768) {
    this.rt = new THREE.WebGLCubeRenderTarget(res, {
      generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(2, 2600, this.rt);
    this.cubeCam.position.set(0, 1, 0); // observer eye, same as the main camera

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uCube: { value: this.rt.texture },
        uAspect: { value: 1 },
        uNorth: { value: 0 },
        uFov: { value: Math.PI },                 // 180° hemisphere
        uScale: { value: 1 },                     // calibration: disc size
        uOffset: { value: new THREE.Vector2(0, 0) }, // calibration: disc centre
        uMirror: { value: 0 },                    // 1 = horizontal flip (mirror bounce)
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform samplerCube uCube; uniform float uAspect, uNorth, uFov, uScale, uMirror;
        uniform vec2 uOffset;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          if (uAspect > 1.0) p.x *= uAspect; else p.y /= uAspect;
          // calibration: recentre, rescale, optional mirror so it lines up on the ceiling
          p = (p - uOffset) / max(uScale, 0.05);
          if (uMirror > 0.5) p.x = -p.x;
          float r = length(p);
          if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          float theta = r * (uFov * 0.5);        // angle from zenith
          float phi = atan(p.x, p.y) + uNorth;   // azimuth around zenith
          float st = sin(theta), ct = cos(theta);
          vec3 dir = vec3(st * sin(phi), ct, -st * cos(phi)); // +Y up, -Z north
          gl_FragColor = textureCube(uCube, dir);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quadScene.add(this.quad);
  }

  setSize(w, h) { this.mat.uniforms.uAspect.value = w / h; }
  setNorth(rad) { this.mat.uniforms.uNorth.value = rad; }
  setFovDeg(deg) { this.mat.uniforms.uFov.value = deg * Math.PI / 180; }
  setCalibration({ scale, offsetX, offsetY, mirror } = {}) {
    const u = this.mat.uniforms;
    if (scale != null) u.uScale.value = scale;
    if (offsetX != null) u.uOffset.value.x = offsetX;
    if (offsetY != null) u.uOffset.value.y = offsetY;
    if (mirror != null) u.uMirror.value = mirror ? 1 : 0;
  }

  render(renderer, scene) {
    const prevBg = scene.background;
    this.cubeCam.update(renderer, scene);
    scene.background = prevBg;
    renderer.render(this.quadScene, this.quadCam);
  }
}

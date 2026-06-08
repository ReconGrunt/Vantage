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

    // Preallocated face lists for the manual cube render (see _renderCube), so the
    // per-frame render loop allocates nothing. FACES_HEMI skips index 3 (-Y, NY),
    // never sampled at FOV <= 180°; FACES_ALL is the rare FOV > 180° calibration path.
    this._facesHemi = [0, 1, 2, 4, 5];
    this._facesAll = [0, 1, 2, 3, 4, 5];

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
          // Feather width — the disc edge fades to black across this thin rim instead of
          // a hard 1-pixel cut, so the dome's circular edge is anti-aliased on a projector.
          const float fw = 0.012;
          // Cheap early-out only well OUTSIDE the rim (nothing to draw, and the sample
          // direction would dip below the horizon for FOV>180 anyway). The feather below
          // handles the visible edge band; this just skips work in the black corners.
          if (r > 1.0 + fw) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          // NOTE: the theta/phi -> dir mapping below is UNCHANGED — no object moves. Only
          // the post-sample colour (feather + rim glow) is new.
          float theta = r * (uFov * 0.5);        // angle from zenith
          float phi = atan(p.x, p.y) + uNorth;   // azimuth around zenith
          float st = sin(theta), ct = cos(theta);
          vec3 dir = vec3(st * sin(phi), ct, -st * cos(phi)); // +Y up, -Z north
          vec3 col = textureCube(uCube, dir).rgb;
          // (a) anti-aliased feather: 1 inside the disc, ramping to 0 across the rim.
          float edge = 1.0 - smoothstep(1.0 - fw, 1.0, r);
          // (b) faint warm horizon glow: a subtle atmospheric rim near r~1.0 so the dome
          // edge reads like a real horizon rather than a void. Brightens toward the rim
          // and is gated by the edge factor so it fades out cleanly past the disc.
          vec3 glow = vec3(0.10, 0.07, 0.05) * smoothstep(0.86, 1.0, r) * edge;
          // Background stays opaque black, so fading the sampled colour by the edge factor
          // blends the disc smoothly into the surrounding black; the glow is added on top.
          gl_FragColor = vec4(col * edge + glow, 1.0);
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
    // Render the cube faces (only the ones the disc actually samples — see
    // _renderCube) then remap them onto the disc. scene.background is restored
    // exactly as before; the cube render itself may consume it as a clear/skybox.
    this._renderCube(renderer, scene);
    scene.background = prevBg;
    renderer.render(this.quadScene, this.quadCam);
  }

  // Render the CubeCamera faces manually so we can SKIP the down-facing (-Y) face
  // when it is never sampled. For a 180° upper-hemisphere disc the sampled
  // direction is dir = vec3(st*sin(phi), ct, -st*cos(phi)) with ct = cos(theta) >= 0
  // for theta <= 90°, so dir.y >= 0 everywhere on the disc — the -Y cube face (index
  // 3 = NY) is never read. Skipping it cuts the whole-scene re-render from 6 faces to
  // 5 (~17% of the dominant GPU cost on the default projector path) with ZERO change
  // to any sampled pixel. We render all 6 only for the rare FOV > 180° calibration,
  // where the disc edge dips just below the horizon and could touch the -Y face.
  //
  // This is a faithful reimplementation of three r160 `CubeCamera.update()` (verified
  // against the pinned 0.160.0 source): same lazy coordinate-system setup, same
  // renderTarget/active-face/mip save-restore, same xr.enabled force-off, same
  // generateMipmaps handling (off for all but the last rendered face), same
  // needsPMREMUpdate flag. The ONLY difference is the set of faces rendered.
  //
  // FALLBACK: if this ever misbehaves, revert `render()` to call
  // `this.cubeCam.update(renderer, scene)` — a correct slower path. (Reversible.)
  _renderCube(renderer, scene) {
    const cam = this.cubeCam;
    const rt = this.rt;

    // The cubeCam lives in the scene graph; renderer.render refreshes world
    // matrices, but update it up front to be safe (matches update()'s intent).
    cam.updateMatrixWorld();

    // Lazy coordinate-system setup: the six face cameras get their up/lookAt
    // orientations ONLY inside updateCoordinateSystem(), which the stock update()
    // calls the first time the coordinate system differs. We MUST reproduce this
    // guard or the face cameras would never be oriented (they'd all look down +Z).
    if (cam.coordinateSystem !== renderer.coordinateSystem) {
      cam.coordinateSystem = renderer.coordinateSystem;
      cam.updateCoordinateSystem();
    }

    // Face cameras in fixed order [PX, NX, PY, NY, PZ, NZ] = indices 0..5.
    // NY (index 3) is straight down (-Y).
    const faceCams = cam.children;

    // FOV <= 180° (the default 180° dome): the -Y face is never sampled, so skip it.
    // FOV > 180° (rare calibration up to 220°): render all six. Both lists are the
    // preallocated instance arrays so this hot path allocates nothing per frame.
    const fovDeg = this.mat.uniforms.uFov.value * 180 / Math.PI;
    const faces = (fovDeg <= 180.0 + 1e-3) ? this._facesHemi : this._facesAll;

    // --- save renderer state exactly as CubeCamera.update() does ---
    const prevRenderTarget = renderer.getRenderTarget();
    const prevActiveCubeFace = renderer.getActiveCubeFace();
    const prevActiveMipmapLevel = renderer.getActiveMipmapLevel();
    const prevXrEnabled = renderer.xr.enabled;
    const mip = cam.activeMipmapLevel;

    renderer.xr.enabled = false;

    // Mipmaps (if any) are generated on the LAST render() call into the target, once
    // all faces are defined. Our RT is created generateMipmaps:false so this is a
    // no-op in practice, but we mirror the stock behaviour faithfully: off for every
    // face except the last in our list, restored to its saved value just before it.
    const generateMipmaps = rt.texture.generateMipmaps;
    rt.texture.generateMipmaps = false;

    const last = faces.length - 1;
    for (let i = 0; i <= last; i++) {
      if (i === last) rt.texture.generateMipmaps = generateMipmaps;
      const face = faces[i];
      renderer.setRenderTarget(rt, face, mip);
      renderer.render(scene, faceCams[face]);
    }

    // --- restore renderer state ---
    renderer.setRenderTarget(prevRenderTarget, prevActiveCubeFace, prevActiveMipmapLevel);
    renderer.xr.enabled = prevXrEnabled;
    rt.texture.needsPMREMUpdate = true;
  }
}

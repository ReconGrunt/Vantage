// assets.js — loads the self-hosted glTF models (aircraft + satellites) and
// normalizes each one to a common convention so the rest of the app can treat
// them uniformly: centered at the origin, longest dimension == 1 unit, and the
// NOSE pointing toward -Z (so Object3D.lookAt aims it along travel).
//
// Models: Poly Pizza (CC-BY 3.0) + low-poly ISS. See README credits.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FILES = {
  airliner: 'models/airliner.glb',
  jumbo: 'models/jumbo.glb',
  // NOTE: models/bizjet.glb shipped as a low-poly SEAGULL (wrong asset), so bizjets
  // rendered as a "bird". Interim: point the bizjet bucket at the real airliner mesh
  // (it keeps its own 18 m LEN_M size, so a Gulfstream still reads smaller than a
  // narrowbody). TODO: drop a real free CC-BY business-jet glb in as models/bizjet.glb
  // and revert this + recalibrate ORIENT.bizjet via model-view.html.
  bizjet: 'models/airliner.glb',
  cessna: 'models/cessna.glb',
  heli: 'models/heli.glb',
  fighter: 'models/fighter.glb',
  iss: 'models/iss.glb',
  satellite: 'models/satellite.glb',
};

// Per-model rotation (radians, XYZ euler) applied BEFORE centering, to bring the
// nose to -Z and the top to +Y. Calibrated by inspection (model-view.html).
const ORIENT = {
  airliner: [0, 0, 0],
  jumbo: [0, -0.82, 0],          // nose was up-left
  bizjet: [0, 0, 0],             // uses the airliner mesh (already nose -Z) until a real bizjet lands
  cessna: [0, 0, 0],
  heli: [0, Math.PI / 2, 0],     // nose was to the right (+X)
  fighter: [0, 0, 0],
  iss: [0, 0, 0],
  satellite: [0, 0, 0],
};

export async function loadModels() {
  const loader = new GLTFLoader();
  const out = {};
  await Promise.all(Object.entries(FILES).map(async ([key, url]) => {
    try {
      const gltf = await loader.loadAsync(url);
      out[key] = normalize(gltf.scene, ORIENT[key] || [0, 0, 0]);
    } catch (e) {
      console.warn('[assets] failed to load', key, e);
    }
  }));
  return out;
}

// Returns a Group (scale 1) whose content is centered, max-dimension 1, nose -Z.
// The unit scaling is baked into an INNER group so callers can freely set the
// wrapper's scale per-frame (true angular size) without undoing normalization.
function normalize(scene, orient) {
  scene.rotation.set(orient[0], orient[1], orient[2]);
  scene.traverse((o) => {
    if (o.isMesh) { o.frustumCulled = false; o.castShadow = o.receiveShadow = false; }
  });

  const inner = new THREE.Group();
  inner.add(scene);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const s = 1 / (Math.max(size.x, size.y, size.z) || 1);
  inner.scale.setScalar(s);
  inner.position.copy(center).multiplyScalar(-s); // centre after scaling

  const wrapper = new THREE.Group();
  wrapper.add(inner);
  wrapper.userData.normalized = true;
  return wrapper;
}

// Deep clone that also clones materials, so per-instance tweaks (emissive at
// night, etc.) don't leak across aircraft.
export function instantiate(template) {
  const obj = template.clone(true);
  obj.traverse((o) => { if (o.isMesh && o.material) o.material = o.material.clone(); });
  return obj;
}

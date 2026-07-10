// three-shim.mjs — a MINIMAL stand-in for the parts of three that coords.js uses,
// so the REAL public/js/coords.js can be imported and exercised under plain `node`
// (the app pulls three from a CDN importmap, so it is NOT in node_modules).
//
// coords.js only ever does: `new THREE.Vector3(x,y,z)` then `.multiplyScalar(s)`
// and reads `.x/.y/.z`. This Vector3 reproduces three's documented semantics for
// exactly those operations (verified against three r160 Vector3 source). It does
// NOT change any numbers coords.js computes — the az/el→world trig is plain math
// in coords.js; Vector3 is just the carrier. Used only by the projection test
// via `node --import ./scripts/three-loader.mjs`.

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
}

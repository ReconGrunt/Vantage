// three-loader.mjs — an ESM resolve hook that maps the bare specifier `three`
// (which the app resolves via a browser importmap to a CDN URL, and which is NOT
// installed in node_modules) to the local minimal shim, so the REAL coords.js can
// be imported under node for the projection-correctness test. Test-only; no effect
// on the running app. Registered by projection-test.mjs via module.register().

const SHIM = new URL('./three-shim.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: SHIM, shortCircuit: true };
  return nextResolve(specifier, context);
}

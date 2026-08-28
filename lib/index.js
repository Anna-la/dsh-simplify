// dsh-simplify — node half.
// This plugin is client-only (browser DOM cleanup); the node side exists so the
// Cordis loader can mount the entry, which is what makes the client-modules scan
// pick the package up into window.__DSH_BOOT__ and serve /plugins/dsh-simplify/client.js.
export const name = 'dsh-simplify'

export function apply() {
  // Intentionally a no-op on the host. All behaviour lives in the client bundle
  // (client/client.js), which runs in the browser via the DSH module table.
}
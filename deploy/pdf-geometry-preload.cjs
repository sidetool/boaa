// PDF inspection reads structure/metadata; it does not render a server-side canvas.
// Keep the supplier's standalone JavaScript geometry polyfill, without native Skia.
const geometry = require('./geometry.cjs');
globalThis.DOMMatrix ??= geometry.DOMMatrix;

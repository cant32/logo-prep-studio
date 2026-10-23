// Where the app's own files come from. Served from a folder, they load by
// relative URL. In the single-file build (Logo Prep Studio.html) they are
// embedded in the page and registered on globalThis.__ASSETS as blob URLs,
// so the tool works when the file is simply double-clicked.

export function assetUrl(path) {
  const embedded = globalThis.__ASSETS && globalThis.__ASSETS[path];
  return embedded || new URL('../' + path, import.meta.url).href;
}

export const embeddedModel = path => globalThis.__MODELS && globalThis.__MODELS[path];

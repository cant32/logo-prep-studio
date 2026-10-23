// AI upscaling in the browser (tf.js). Real-CUGAN "conservative" scored best
// on logos in our tests; Real-ESRGAN anime is the quick option.
// tf.js and WebUpscaler are loaded as globals by index.html.

import { assetUrl, embeddedModel } from './assets.js';

const MODELS = {
  best: scale => ({ modelType: 'realcugan', scale, denoise: 'conservative' }),
  fast: () => ({ modelType: 'realesrgan', model: 'anime_fast' }),
};
const cache = new Map();

// Single-file build: models are embedded, so load them from memory instead
// of fetching model.json and its weight file.
function useEmbedded(up) {
  const load = up.loadModel.bind(up);
  up.loadModel = (url, cacheName) => {
    const m = embeddedModel(url.replace(/^.*?models\//, ''));
    if (!m) return load(url, cacheName);
    const bytes = Uint8Array.from(atob(m.bin), c => c.charCodeAt(0));
    return tf.loadGraphModel(tf.io.fromMemory({
      modelTopology: m.json.modelTopology, format: m.json.format, generatedBy: m.json.generatedBy,
      convertedBy: m.json.convertedBy, signature: m.json.signature, userDefinedMetadata: m.json.userDefinedMetadata,
      modelInitializer: m.json.modelInitializer,
      weightSpecs: m.json.weightsManifest.flatMap(g => g.weights), weightData: bytes.buffer,
    }));
  };
  return up;
}

// Pick a scale so the working image lands around 1000-2000px on its long side.
export function autoScale(w, h) {
  const long = Math.max(w, h);
  if (long <= 500) return 4;
  if (long <= 1000) return 2;
  return 1;
}

export async function upscale(imageData, { scale = 4, quality = 'best', onProgress, signal } = {}) {
  if (scale <= 1) return imageData;
  const opts = MODELS[quality](scale);
  const key = JSON.stringify(opts);
  if (!cache.has(key)) {
    const backend = (await tf.setBackend('webgl').catch(() => false)) ? 'webgl' : 'cpu';
    cache.set(key, useEmbedded(new WebUpscaler({ ...opts, backend, modelBaseUrl: assetUrl('vendor/upscaler/models') })));
  }
  const up = cache.get(key);
  await up.warmup();
  let out = await up.upscaleImageData(imageData, { onProgress, signal });
  // the fast model is fixed at 4x; scale down if 2x was asked for
  if (out.width !== imageData.width * scale) out = resize(out, imageData.width * scale, imageData.height * scale);
  return out;
}

export function resize(imageData, w, h) {
  const src = new OffscreenCanvas(imageData.width, imageData.height);
  src.getContext('2d').putImageData(imageData, 0, 0);
  const dst = new OffscreenCanvas(w, h), x = dst.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
}

export const gpuName = () => tf.getBackend() === 'webgl' ? 'graphics card' : 'processor (slower)';

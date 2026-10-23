// @plotdb/upscaler - tile-based image upscaler on top of tf.js graph models.
//
// Expects two globals, provided by the host:
//  - tf          : @tensorflow/tfjs ( or @tensorflow/tfjs-node, see src/node.js )
//  - ImageData   : the browser builtin, or the `canvas` package's on node
//
// Both are looked up at call time, so the host may install them after this
// file is loaded.
(function() {
  'use strict';

  var CACHE_PREFIX = 'plotdb-v1';

  var MODEL_TYPES = ['realcugan', 'realesrgan'];
  var DENOISES = ['conservative', 'no-denoise', 'denoise1x', 'denoise2x', 'denoise3x'];
  // plus models are not shipped in models/ but can be converted locally,
  // see models/README.md -- accept them so a local conversion is usable.
  var ESRGAN_MODELS = ['anime_fast', 'general_fast', 'anime_plus', 'general_plus'];
  // bilibili only released 2x weights for denoise1x / denoise2x
  var CUGAN_DENOISES = {
    2: ['conservative', 'no-denoise', 'denoise1x', 'denoise2x', 'denoise3x'],
    4: ['conservative', 'no-denoise', 'denoise3x']
  };
  var FORMATS = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };

  var SHARPEN_KERNEL = [[0, -1, 0], [-1, 5, -1], [0, -1, 0]];


  // --- small helpers ---------------------------------------------------------

  function abortError() {
    if (typeof DOMException === 'function') {
      try { return new DOMException('Aborted', 'AbortError'); } catch (e) {}
    }
    var err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  }

  function oneOf(name, value, list) {
    if (list.indexOf(value) < 0) {
      throw new Error(
        'WebUpscaler: invalid ' + name + ' "' + value + '", expected one of: ' + list.join(', ')
      );
    }
    return value;
  }

  function positiveInt(name, value) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0 || value % 1 !== 0) {
      throw new Error('WebUpscaler: ' + name + ' must be a positive integer, got ' + value);
    }
    return value;
  }

  // tile start offsets along one axis. advances by `tile - overlap`; the last
  // tile is pulled back to sit flush against the far edge, so the whole axis
  // is covered and every pair of neighbours overlaps by at least `overlap`.
  function tileStarts(len, tile, overlap) {
    var step = Math.max(1, tile - overlap);
    var starts = [];
    var p = 0;
    while (true) {
      if (p + tile >= len) {
        var last = len - tile;
        if (!starts.length || starts[starts.length - 1] !== last) starts.push(last);
        return starts;
      }
      starts.push(p);
      p += step;
    }
  }

  // per-axis blend weights in output pixels. `fadeLow` / `fadeHigh` are false on
  // the side where this tile sits on the image border -- no fade there, the tile
  // owns those pixels outright.
  function blendWeights(len, feather, margin, fadeLow, fadeHigh) {
    var w = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      var v = 1;
      if (fadeLow) v = Math.min(v, edgeWeight(i, feather, margin));
      if (fadeHigh) v = Math.min(v, edgeWeight(len - 1 - i, feather, margin));
      w[i] = v;
    }
    return w;
  }

  function edgeWeight(d, feather, margin) {
    if (d < margin) return 0;
    if (feather <= 0) return 1;
    if (d < margin + feather) return (d - margin + 0.5) / feather;
    return 1;
  }

  // edge-replicate padding for a [1,H,W,C] tensor. always returns a new tensor.
  function padEdge(t, top, bottom, left, right) {
    if (!top && !bottom && !left && !right) return t.clone();
    return tf.tidy(function() {
      var out = t;
      var s;
      if (top || bottom) {
        s = out.shape;
        var rows = [];
        if (top) rows.push(tf.tile(tf.slice(out, [0, 0, 0, 0], [s[0], 1, s[2], s[3]]), [1, top, 1, 1]));
        rows.push(out);
        if (bottom) rows.push(tf.tile(tf.slice(out, [0, s[1] - 1, 0, 0], [s[0], 1, s[2], s[3]]), [1, bottom, 1, 1]));
        out = tf.concat(rows, 1);
      }
      if (left || right) {
        s = out.shape;
        var cols = [];
        if (left) cols.push(tf.tile(tf.slice(out, [0, 0, 0, 0], [s[0], s[1], 1, s[3]]), [1, 1, left, 1]));
        cols.push(out);
        if (right) cols.push(tf.tile(tf.slice(out, [0, 0, s[2] - 1, 0], [s[0], s[1], 1, s[3]]), [1, 1, right, 1]));
        out = tf.concat(cols, 2);
      }
      return out;
    });
  }


  // --- WebUpscaler -----------------------------------------------------------

  function WebUpscaler(options) {
    var o = options || {};

    this.modelType = oneOf('modelType', o.modelType === undefined ? 'realcugan' : o.modelType, MODEL_TYPES);
    this.backend = o.backend === undefined ? 'webgl' : o.backend;
    this.modelBaseUrl = o.modelBaseUrl === undefined ? '/models' : o.modelBaseUrl;
    this.tileSize = positiveInt('tileSize', o.tileSize === undefined ? 64 : o.tileSize);
    this.overlap = o.overlap === undefined ? 12 : o.overlap;
    this.margin = o.margin === undefined ? 0 : o.margin;
    this.sharpen = o.sharpen === undefined ? 0 : o.sharpen;
    this.debug = !!o.debug;

    if (this.modelType === 'realesrgan') {
      this.model = oneOf('model', o.model === undefined ? 'anime_fast' : o.model, ESRGAN_MODELS);
      this.scale = o.scale === undefined ? 4 : o.scale;
      this.denoise = o.denoise;
    } else {
      this.scale = oneOf('scale', o.scale === undefined ? 4 : o.scale, [2, 4]);
      this.denoise = oneOf('denoise', o.denoise === undefined ? 'conservative' : o.denoise, DENOISES);
      oneOf('denoise for realcugan ' + this.scale + 'x', this.denoise, CUGAN_DENOISES[this.scale]);
      this.model = o.model;
    }

    if (typeof this.overlap !== 'number' || this.overlap < 0 || this.overlap >= this.tileSize) {
      throw new Error('WebUpscaler: overlap must be between 0 and tileSize - 1, got ' + this.overlap);
    }
    if (typeof this.margin !== 'number' || this.margin < 0 || this.margin * 2 > this.overlap) {
      throw new Error('WebUpscaler: margin must be between 0 and overlap / 2, got ' + this.margin);
    }
    if (typeof this.sharpen !== 'number' || this.sharpen < 0 || this.sharpen > 1) {
      throw new Error('WebUpscaler: sharpen must be between 0 and 1, got ' + this.sharpen);
    }

    // set on warmup()
    this.net = null;
    this.modelScale = null;
    this.modelTile = null;
    this._loading = null;
  }

  WebUpscaler.CACHE_PREFIX = CACHE_PREFIX;

  WebUpscaler.prototype.log = function() {
    if (!this.debug) return;
    console.log.apply(console, ['[upscaler]'].concat(Array.prototype.slice.call(arguments)));
  };

  WebUpscaler.prototype.warn = function() {
    if (!this.debug) return;
    console.warn.apply(console, ['[upscaler]'].concat(Array.prototype.slice.call(arguments)));
  };

  // `<type>-<name>-<tileSize>`, the identity of one model file.
  WebUpscaler.prototype.modelName = function() {
    return this.modelType === 'realesrgan' ? this.model : this.scale + 'x-' + this.denoise;
  };

  WebUpscaler.prototype.modelUrl = function() {
    return this.modelBaseUrl + '/' + this.modelType + '/' + this.modelName() + '-' + this.tileSize + '/model.json';
  };

  WebUpscaler.prototype.cacheName = function() {
    return CACHE_PREFIX + '-' + this.modelType + '-' + this.modelName() + '-' + this.tileSize;
  };


  // --- overridable hooks -----------------------------------------------------
  //
  // src/node.js overrides these three to swap Blob/canvas/IndexedDB for
  // Buffer/node-canvas/the filesystem. They are the documented extension
  // points; everything else is internal.

  // decode(input) -> Promise<ImageData>
  WebUpscaler.prototype.decode = function(blob) {
    if (typeof document !== 'undefined') {
      return new Promise(function(resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
        };
        img.onerror = function() {
          URL.revokeObjectURL(url);
          reject(new Error('WebUpscaler: failed to decode input image'));
        };
        img.src = url;
      });
    }
    // worker: no document, no Image
    return createImageBitmap(blob).then(function(bitmap) {
      var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    });
  };

  // encode(imageData, format, quality) -> Promise<Blob>
  WebUpscaler.prototype.encode = function(imageData, format, quality) {
    var mime = FORMATS[format] || FORMATS.png;
    if (typeof document !== 'undefined') {
      var canvas = document.createElement('canvas');
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      canvas.getContext('2d').putImageData(imageData, 0, 0);
      return new Promise(function(resolve, reject) {
        canvas.toBlob(function(blob) {
          if (blob) resolve(blob);
          else reject(new Error('WebUpscaler: failed to encode output image'));
        }, mime, quality);
      });
    }
    var off = new OffscreenCanvas(imageData.width, imageData.height);
    off.getContext('2d').putImageData(imageData, 0, 0);
    return off.convertToBlob({ type: mime, quality: quality });
  };

  // loadModel(url, cacheName) -> Promise<GraphModel>
  // browser: IndexedDB first, network second, and write back what we fetched.
  WebUpscaler.prototype.loadModel = function(url, cacheName) {
    var self = this;
    var key = 'indexeddb://' + cacheName;

    // drop pre-0.0.5 unprefixed entries, which hold the old GPL conversion
    var legacy = 'indexeddb://' + cacheName.slice(CACHE_PREFIX.length + 1);
    var cleaned = Promise.resolve()
      .then(function() { return tf.io.removeModel(legacy); })
      .then(function() { self.log('removed legacy cache', legacy); })
      .catch(function() {});

    return cleaned
      .then(function() { return tf.loadGraphModel(key); })
      .then(function(model) {
        self.log('loaded from cache', key);
        return model;
      })
      .catch(function() {
        self.log('loading from network', url);
        return tf.loadGraphModel(url).then(function(model) {
          return model.save(key).then(function() {
            self.log('cached', key);
            return model;
          }).catch(function(e) {
            self.warn('failed to cache model:', e && e.message);
            return model;
          });
        });
      });
  };


  // --- lifecycle -------------------------------------------------------------

  WebUpscaler.prototype.setupBackend = function() {
    var self = this;
    if (!this.backend || typeof tf.setBackend !== 'function') return Promise.resolve();
    if (tf.getBackend && tf.getBackend() === this.backend) return Promise.resolve();
    return Promise.resolve(tf.setBackend(this.backend)).then(function(ok) {
      if (ok === false) self.warn('backend "' + self.backend + '" unavailable, using ' + tf.getBackend());
      return tf.ready();
    }).catch(function(e) {
      self.warn('failed to select backend "' + self.backend + '":', e && e.message);
      return tf.ready();
    });
  };

  // Concurrent callers share one load; usable again after dispose().
  WebUpscaler.prototype.warmup = function() {
    var self = this;
    if (this.net) return Promise.resolve();
    if (this._loading) return this._loading;
    this._loading = this.setupBackend()
      .then(function() { return self.loadModel(self.modelUrl(), self.cacheName()); })
      .then(function(net) {
        self.net = net;
        self.readGeometry();
        self._loading = null;
      })
      .catch(function(e) {
        self._loading = null;
        throw e;
      });
    return this._loading;
  };

  // The model is the authority on tile size and scale factor; the matching
  // options only pick which file to load.
  WebUpscaler.prototype.readGeometry = function() {
    var inShape = this.net.inputs && this.net.inputs[0] && this.net.inputs[0].shape;
    var outShape = this.net.outputs && this.net.outputs[0] && this.net.outputs[0].shape;
    var tile = inShape && inShape[1] > 0 ? inShape[1] : null;
    var scale = tile && outShape && outShape[1] > 0 ? outShape[1] / tile : null;

    if (!tile || !scale || scale % 1 !== 0) {
      // shapes not declared in the signature -- measure with one dummy pass
      var probe = this.probeGeometry(tile || this.tileSize);
      tile = probe.tile;
      scale = probe.scale;
    }

    if (tile !== this.tileSize) {
      this.warn('model tile size is ' + tile + ', not tileSize ' + this.tileSize + '; using ' + tile);
    }
    if (scale !== this.scale) {
      this.warn('model scale is ' + scale + 'x, not scale ' + this.scale + '; using ' + scale + 'x');
    }
    this.modelTile = tile;
    this.modelScale = scale;
    this.log('model ready: tile ' + tile + ', scale ' + scale + 'x, backend ' + tf.getBackend());
  };

  WebUpscaler.prototype.probeGeometry = function(tile) {
    var net = this.net;
    var shape = tf.tidy(function() {
      var out = net.predict(tf.zeros([1, tile, tile, 3]));
      return (Array.isArray(out) ? out[0] : out).shape;
    });
    return { tile: tile, scale: shape[1] / tile };
  };

  WebUpscaler.prototype.dispose = function() {
    if (this.net) this.net.dispose();
    this.net = null;
    this.modelScale = null;
    this.modelTile = null;
    this._loading = null;
  };


  // --- upscaling -------------------------------------------------------------

  WebUpscaler.prototype.upscale = function(input, options) {
    var self = this;
    var o = options || {};
    var format = o.format === undefined ? 'png' : o.format;
    var quality = o.quality === undefined ? 0.92 : o.quality;
    if (!FORMATS[format]) {
      throw new Error('WebUpscaler: invalid format "' + format + '", expected one of: png, jpeg, webp');
    }
    return this.warmup()
      .then(function() { return self.decode(input); })
      .then(function(imageData) { return self.upscaleImageData(imageData, o); })
      .then(function(out) { return self.encode(out, format === 'jpg' ? 'jpeg' : format, quality); });
  };

  // ImageData in, ImageData out. Touches no DOM, so it runs in a worker.
  WebUpscaler.prototype.upscaleImageData = function(imageData, options) {
    var self = this;
    var o = options || {};
    return this.warmup().then(function() { return self.run(imageData, o); });
  };

  WebUpscaler.prototype.run = function(imageData, o) {
    var self = this;
    var signal = o.signal;
    var onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
    var s = this.modelScale;
    var tile = this.modelTile;

    var w = imageData.width;
    var h = imageData.height;
    if (!w || !h) throw new Error('WebUpscaler: input image is empty');
    if (signal && signal.aborted) return Promise.reject(abortError());

    // pad up to at least one tile on each axis, split evenly over both sides
    var padLeft = w < tile ? Math.floor((tile - w) / 2) : 0;
    var padTop = h < tile ? Math.floor((tile - h) / 2) : 0;
    var pw = Math.max(w, tile);
    var ph = Math.max(h, tile);

    var xs = tileStarts(pw, tile, this.overlap);
    var ys = tileStarts(ph, tile, this.overlap);
    var total = xs.length * ys.length;
    this.log('upscaling ' + w + 'x' + h + ' -> ' + (w * s) + 'x' + (h * s) + ' in ' + total + ' tiles');

    // float accumulator + weight plane over the padded output
    var outW = pw * s;
    var outH = ph * s;
    var accum = new Float32Array(outW * outH * 3);
    var wsum = new Float32Array(outW * outH);

    var feather = Math.max(0, Math.min(this.overlap - this.margin * 2, Math.floor(tile / 2) - this.margin)) * s;
    var margin = this.margin * s;
    var span = tile * s;
    var weightCache = {};
    function weights(start, len) {
      var key = (start > 0 ? 1 : 0) + '-' + (start + tile < len ? 1 : 0);
      if (!weightCache[key]) {
        weightCache[key] = blendWeights(span, feather, margin, start > 0, start + tile < len);
      }
      return weightCache[key];
    }

    var img = this.toTensor(imageData, padLeft, padTop, pw, ph);
    var done = 0;
    if (onProgress) onProgress(0);

    function step(i) {
      if (i >= total) return Promise.resolve();
      if (signal && signal.aborted) throw abortError();

      var x0 = xs[i % xs.length];
      var y0 = ys[Math.floor(i / xs.length)];
      var out = tf.tidy(function() {
        var patch = tf.slice(img, [0, y0, x0, 0], [1, tile, tile, 3]);
        var pred = self.net.predict(patch);
        if (Array.isArray(pred)) pred = pred[0];
        return self.sharpen > 0 ? self.applySharpen(pred, self.sharpen) : pred;
      });

      return out.data().then(function(data) {
        out.dispose();
        var wx = weights(x0, pw);
        var wy = weights(y0, ph);
        var ox = x0 * s;
        var oy = y0 * s;
        for (var ty = 0; ty < span; ty++) {
          var wyv = wy[ty];
          if (wyv === 0) continue;
          var row = (oy + ty) * outW + ox;
          var src = ty * span * 3;
          for (var tx = 0; tx < span; tx++) {
            var wv = wyv * wx[tx];
            if (wv === 0) continue;
            var si = src + tx * 3;
            var di = (row + tx) * 3;
            accum[di] += data[si] * wv;
            accum[di + 1] += data[si + 1] * wv;
            accum[di + 2] += data[si + 2] * wv;
            wsum[row + tx] += wv;
          }
        }
        done++;
        if (onProgress) onProgress(done / total * 100);
        if (signal && signal.aborted) throw abortError();
        return step(i + 1);
      }, function(e) {
        out.dispose();
        throw e;
      });
    }

    return Promise.resolve()
      .then(function() { return step(0); })
      .then(function() {
        var out = self.compose(accum, wsum, outW, padLeft * s, padTop * s, w * s, h * s);
        self.fillAlpha(imageData, out, s);
        return out;
      })
      .then(function(out) { img.dispose(); return out; }, function(e) { img.dispose(); throw e; });
  };

  // RGB of the ( edge-replicate padded ) input as a single [1,ph,pw,3] float
  // tensor in 0~1. Alpha is carried separately; RGB is taken as-is, not
  // premultiplied.
  WebUpscaler.prototype.toTensor = function(imageData, padLeft, padTop, pw, ph) {
    var w = imageData.width;
    var h = imageData.height;
    var src = imageData.data;
    var rgb = new Float32Array(w * h * 3);
    for (var i = 0, j = 0, n = w * h; i < n; i++) {
      var p = i * 4;
      rgb[j++] = src[p] / 255;
      rgb[j++] = src[p + 1] / 255;
      rgb[j++] = src[p + 2] / 255;
    }
    return tf.tidy(function() {
      var t = tf.tensor4d(rgb, [1, h, w, 3]);
      return padEdge(t, padTop, ph - h - padTop, padLeft, pw - w - padLeft);
    });
  };

  // 3x3 sharpen on one tile's model output, edge-replicated at the borders,
  // clamped, then mixed back into the original by `strength`.
  WebUpscaler.prototype.applySharpen = function(t, strength) {
    return tf.tidy(function() {
      var vals = [];
      for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
          for (var c = 0; c < 3; c++) vals.push(SHARPEN_KERNEL[i][j]);
        }
      }
      var kernel = tf.tensor4d(vals, [3, 3, 3, 1]);
      var sharp = tf.depthwiseConv2d(padEdge(t, 1, 1, 1, 1), kernel, 1, 'valid').clipByValue(0, 1);
      return tf.add(tf.mul(t, 1 - strength), tf.mul(sharp, strength));
    });
  };

  // divide out the accumulated weights, round, clamp, crop back to w x h
  WebUpscaler.prototype.compose = function(accum, wsum, stride, x0, y0, w, h) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = (y0 + y) * stride + x0 + x;
        var inv = wsum[p] > 0 ? 1 / wsum[p] : 0;
        var si = p * 3;
        var di = (y * w + x) * 4;
        out[di] = Math.round(accum[si] * inv * 255);
        out[di + 1] = Math.round(accum[si + 1] * inv * 255);
        out[di + 2] = Math.round(accum[si + 2] * inv * 255);
        out[di + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  };

  // The model is RGB-only, so alpha rides along as a bilinear resize. Fully
  // opaque input stays fully opaque, and costs nothing. Half-pixel centres,
  // i.e. output pixel d samples input coordinate ( d + 0.5 ) / s - 0.5.
  WebUpscaler.prototype.fillAlpha = function(imageData, out, s) {
    var src = imageData.data;
    var w = imageData.width;
    var h = imageData.height;
    var n = w * h;
    var i;
    for (i = 0; i < n; i++) {
      if (src[i * 4 + 3] !== 255) break;
    }
    if (i === n) return out;

    var ow = w * s;
    var oh = h * s;
    for (var y = 0; y < oh; y++) {
      var fy = (y + 0.5) / s - 0.5;
      var y0 = Math.floor(fy);
      var dy = fy - y0;
      if (y0 < 0) { y0 = 0; dy = 0; }
      if (y0 >= h - 1) { y0 = h - 1; dy = 0; }
      var y1 = Math.min(y0 + 1, h - 1);
      for (var x = 0; x < ow; x++) {
        var fx = (x + 0.5) / s - 0.5;
        var x0 = Math.floor(fx);
        var dx = fx - x0;
        if (x0 < 0) { x0 = 0; dx = 0; }
        if (x0 >= w - 1) { x0 = w - 1; dx = 0; }
        var x1 = Math.min(x0 + 1, w - 1);
        var a00 = src[(y0 * w + x0) * 4 + 3];
        var a01 = src[(y0 * w + x1) * 4 + 3];
        var a10 = src[(y1 * w + x0) * 4 + 3];
        var a11 = src[(y1 * w + x1) * 4 + 3];
        var top = a00 + (a01 - a00) * dx;
        var bot = a10 + (a11 - a10) * dx;
        out.data[(y * ow + x) * 4 + 3] = Math.round(top + (bot - top) * dy);
      }
    }
    return out;
  };


  // --- export ----------------------------------------------------------------

  if (typeof module !== 'undefined' && module.exports) module.exports = WebUpscaler;
  var root = typeof globalThis !== 'undefined' ? globalThis
    : typeof self !== 'undefined' ? self
    : typeof window !== 'undefined' ? window : null;
  if (root) root.WebUpscaler = WebUpscaler;
})();

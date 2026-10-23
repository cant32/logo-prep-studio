# Third-party components

All bundled components allow internal commercial use.

| Component | Use | Licence |
|---|---|---|
| [Real-CUGAN](https://github.com/bilibili/ailab/tree/main/Real-CUGAN) model weights (bilibili) | AI upscaling ("Best") | MIT, see `vendor/upscaler/models/realcugan/LICENSE` |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) animevideo-v3 weights (Xintao Wang) | AI upscaling ("Faster") | BSD-3-Clause, see `vendor/upscaler/models/realesrgan/LICENSE` |
| [@plotdb/upscaler](https://www.npmjs.com/package/@plotdb/upscaler) 0.0.5 | tf.js tiling wrapper and converted models | ISC |
| [TensorFlow.js](https://github.com/tensorflow/tfjs) 4.22 | runs the AI models in the browser | Apache-2.0 |
| [VTracer](https://github.com/visioncortex/vtracer) via [vtracer-wasm](https://github.com/jsscheller/vtracer-wasm) | tracing | MIT, see `vendor/vtracer/LICENSE` |
| [Fabric.js](https://github.com/fabricjs/fabric.js) 6.9 | design canvas | MIT |
| [opentype.js](https://github.com/opentypejs/opentype.js) 1.3 | text to outlines | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js) 3.11 (Mozilla) | reading PDF and AI files | Apache-2.0, see `vendor/pdfjs/LICENSE` |
| [jsPDF](https://github.com/parallax/jsPDF) 2.5 + [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) 2.2 | PDF export | MIT |
| Fonts via [Fontsource](https://fontsource.org): Inter, Montserrat, Oswald, Bebas Neue, Anton, Playfair Display, Pacifico, Lobster, M PLUS Rounded 1c | Text tool and interface | SIL Open Font License 1.1 |
| Fonts via Fontsource: Roboto Slab, Permanent Marker | Text tool | Apache-2.0 |

The colour clean-up (`js/palette.js`) and layer separation (`js/trace.js`) are written for this tool.

The stacked group logo in the header is company brand artwork, used for this internal tool only.

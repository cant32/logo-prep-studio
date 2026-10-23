# Logo Prep Studio

An internal tool for the merch team. It turns client logos into print-ready files, even when the client sends a tiny, blurry JPEG.

**Privacy:** the tool runs entirely in the web browser on your own computer. Logos are never uploaded, stored or sent anywhere. Closing the tab clears everything.

## Starting it

**Easiest:** double-click **`Logo Prep Studio.html`**. That single file is the whole tool, with nothing to install and no server. It opens in your browser and downloads save normally. You can copy it to anyone's computer or a shared drive.

The folder version (`index.html` plus `js/`, `vendor/` etc.) is the editable source. It has to be served by a web server, because browsers block a page opened from disk from loading separate script files:

- **For the whole team (a link):** host this repo as a static site. Logos still never leave each person's computer; the host only serves the tool's files. Because this repo is private:
  - **Railway**: New Project → Deploy from GitHub repo → `logo-prep-studio`, then Settings → Networking → Generate Domain. Every push to `main` redeploys. Railway builds the included `Dockerfile`, a small Caddy web server that only serves the tool's files.
  - **Cloudflare Pages** (free, works with private repos): Workers & Pages → Create → Pages → connect GitHub → pick this repo, framework "None", build command empty, output directory `/`. Add **Cloudflare Access** (free up to 50 people) to require a company email login.
  - **Netlify** (free, works with private repos): Add new site → import from GitHub → this repo, no build command, publish directory `/`.
  - **GitHub Pages** needs a paid GitHub plan for private repos, and the site is public.
  - Or any internal web server (IIS, nginx, Apache).
- **Locally:** `Start Logo Prep Studio (Windows).bat` or `Start Logo Prep Studio (Mac).command` (needs Python).

After changing the source, rebuild the single file with `python3 tools/build-single.py`.

Use Chrome or Edge. A computer with a graphics card makes the AI upscaling fast (a few seconds). Without one it still works, just slower.

## How it works

1. **Load logo**: drop, choose or paste (Ctrl+V) a PNG, JPG, WebP, SVG, **PDF or AI** file.
   - **Is it actually vector?** Every file gets a check. True vector SVG, PDF and AI files go straight to editing with their original shapes. A "vector" file that is really a picture pasted inside (common with client PDFs) is flagged, and the picture is pulled out at full resolution and traced.
   - **PDF / AI choices:** use the vector artwork, use an embedded picture, or trace the whole page. Multi-page PDFs get a page picker. A white page-sized background behind the logo is removed automatically.
   - **Crop** to keep just part of an image (e.g. a logo on a letterhead).
2. **Enhance & vectorise** (runs automatically). **Quick presets** set everything in one click: *Screen print · 2 colours*, *Screen print · all colours*, *Full colour · DTG / DTF*, *One colour · engrave / vinyl*.
   - **AI upscale**: Real-CUGAN rebuilds sharp edges from small or JPEG-damaged images. "Auto" upscales 4× for images under 500 px and 2× under 1000 px.
   - **Colour clean-up**: finds the logo's flat inks, removes JPEG haze, blurred edges and specks, and snaps every pixel to an exact ink.
   - **Remove background**: clears the background colour around the logo, but keeps the same colour inside it (for example white lettering on a badge).
   - **Trace**: each ink becomes its own vector layer, with no hidden overlaps.
   - Adjust **Colours**, **Detail** and **Corners** and the logo re-traces automatically.
3. **Colours**: click a swatch to change an ink. Untick an ink to knock it out, so the garment shows through. **Make one colour** sets everything to a single ink. **Erase shapes** deletes stray bits, and **Paint shapes** recolours individual shapes (useful for fixing specks or breaks in thin lines).
4. **Text**: added text is built from the font's letter outlines, so it prints exactly as shown and never depends on the printer having the font. Includes curve (arc up or down), letter spacing and logo-colour quick picks. **Use your own font file** loads a .ttf, .otf or .woff file, such as the licensed brand font Gotham Rounded, for the current session.
5. **Print-ready export**: choose the print method and the print width in mm. Every file is produced at that real size.

| Method | Files | Checks |
|---|---|---|
| Screen print | Vector SVG (one group per ink), vector PDF, **separations PDF** (one black film page per ink, with registration marks), EPS, mock-up PNG | lines < 0.3 mm, gaps < 0.3 mm, more than 6 inks |
| Digital (DTG) / DTF | 300 dpi transparent PNG (DPI written into the file), PDF, SVG, EPS | lines < 0.3 / 0.5 mm, gaps |
| Laser engrave | Solid black SVG / PDF / EPS, 600 dpi PNG | lines < 0.15 mm |
| Vinyl / HTV cut | Cut-line SVG / EPS (outlines, one colour per layer), filled SVG, PDF, **mirror option** for heat-transfer vinyl | lines < 1 mm, gaps < 0.8 mm |
| Laser cut | Red hairline cut SVG / PDF / EPS, solid SVG | lines < 0.8 mm, gaps < 0.5 mm |
| Embroidery | Clean SVG / PNG for the digitiser | lines < 1.2 mm |

The checks render the finished design at its real print size and highlight problem areas in red (too thin) and orange (gaps that may fill in). The limits are typical shop guidance; confirm with your printer for unusual materials.

The preview bar shows the design on white, black, navy, grey, red or any custom garment colour.

**Keyboard:** Ctrl+Z undo · Delete removes the selected item · Esc leaves erase/paint mode.

## Limits worth knowing

- Text only a few pixels tall in the original, like a tagline under a 120 px logo, can't be recovered by any tool. Retype it with the Text tool.
- Photographic logos and gradients are converted to flat colour areas (the screen-print approach). For DTG, use the original image if it's already high resolution.
- EPS files can't be opened in a browser; ask for PDF, AI, SVG or PNG instead. Very old .ai files (saved without "PDF Compatible") can't be opened either.
- Background removal works on solid-colour backgrounds. A logo on a photo needs cropping, or erasing the leftover shapes by hand.
- Embroidery still needs digitising into stitches by your digitiser or embroidery software.

## What's inside

Everything runs from this folder, with no internet needed once it's loaded:

- `js/`: the app (`trace.js` colour clean-up and tracing, `upscale.js` AI upscaling, `pdf.js` PDF/AI reading, `editor.js` canvas, `text.js` outlined text, `export.js` SVG/PDF/EPS/PNG files, `checks.js` print checks)
- `tools/build-single.py`: rebuilds `Logo Prep Studio.html` from the source
- `vendor/`: third-party libraries and AI models (see `LICENSES.md`)
- `fonts/`: open-licence fonts for the Text tool and the interface

## Brand

The interface uses the stacked group palette (Pantone 158C orange `#EE7623`, 426C charcoal `#25282A`, 10C grey `#616365`, 4008C `#F4AF23`, accent `#51BFD2`). The brand typeface, Gotham Rounded, is licensed and isn't bundled; the interface uses M PLUS Rounded 1c, a free rounded geometric stand-in. To use real Gotham Rounded in the interface, add the licensed `.woff2` files to `fonts/` and point the `@font-face` rules at the top of `css/app.css` to them.

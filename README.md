# Logo Prep Studio

An internal tool for the merch team. It turns client logos into print-ready files, even when the client sends a tiny, blurry JPEG.

**Privacy:** the tool runs entirely in the web browser on your own computer. Logos are never uploaded, stored or sent anywhere. Closing the tab clears everything.

## Starting it

**Easiest:** double-click **`Logo Prep Studio.html`**. That single file is the whole tool, with nothing to install and no server. It opens in your browser and downloads save normally. You can copy it to anyone's computer or a shared drive.

The folder version (`index.html` plus `js/`, `vendor/` etc.) is the editable source. It has to be served by a web server, because browsers block a page opened from disk from loading separate script files:

- **For the whole team (a link):** host this repo as a static site. Logos still never leave each person's computer; the host only serves the tool's files. Because this repo is private:
  - **Railway**: New Project → Deploy from GitHub repo → `logo-prep-studio`, then Settings → Networking → Generate Domain. Every push to `main` redeploys. Railway builds the included `Dockerfile`: a small Node server (`server/`, no dependencies) that serves the tool's files and runs the website logo search. It only fetches public websites (internal and private addresses are refused), with size, time and rate limits.
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
   - **Split a PDF into pages:** for supplier templates and brand packs with several pages, pick the pages you want and save each as its own PDF (or the picked pages as one PDF). Pages are copied exactly, still vector, nothing redrawn, and the file never leaves the computer. With a multi-page PDF open, "Download this page as a PDF" next to the page picker does the same for one page.
   - **Find it on their website:** type the client's web address and the tool suggests logos from the site. It also follows the site's press / brand / media-kit pages (or tries the usual addresses such as `/press` and `/brand`) and lists the logo downloads there (AI, EPS, PDF, SVG, SVGZ, zip packs) first, because those are usually the master print artwork. Menus, brochures and other PDFs are left out. Picking a download fetches it through the server and opens it like a dropped file; a zip pack lists the logo files inside it. This runs on the server, because a browser page can't read other websites; the double-click copy uses the live server for it. Sites that draw their logo only with JavaScript may show just their icons.
2. **Enhance & vectorise** (runs automatically). **Quick presets** set everything in one click: *Screen print · 2 colours*, *Screen print · all colours*, *Full colour · DTG / DTF*, *One colour · engrave / vinyl*.
   - **AI upscale**: Real-CUGAN rebuilds sharp edges from small or JPEG-damaged images. "Auto" upscales 4× for images under 500 px and 2× under 1000 px.
   - **Colour clean-up**: finds the logo's flat inks, removes JPEG haze, blurred edges and specks, and snaps every pixel to an exact ink.
   - **Remove background**: clears the background colour around the logo, but keeps the same colour inside it (for example white lettering on a badge).
   - **Trace**: each ink becomes its own vector layer, with no hidden overlaps.
   - Adjust **Colours**, **Detail** and **Corners** and the logo re-traces automatically.
3. **Colours**: click a swatch, or type an exact hex code, to change an ink. Untick an ink to knock it out, so the garment shows through. **Make one colour** sets everything to a single ink. **Erase shapes** deletes stray bits, and **Paint shapes** recolours individual shapes (useful for fixing specks or breaks in thin lines). Artwork with live text (from a client's SVG) shows **Convert text to curves**: it outlines the text in the real font when the app has it (Gotham, Gotham Rounded, the bundled fonts or one you upload) or, in Chrome, one installed on the computer; otherwise it names the missing font.
4. **Text**: added text is built from the font's letter outlines, so it prints exactly as shown and never depends on the printer having the font. Includes curve (arc up or down), letter spacing and logo-colour quick picks. **Use your own font file** loads a .ttf, .otf or .woff file, such as the licensed brand font Gotham Rounded, for the current session.
5. **Print-ready export**: choose the print method and the print width in mm. Every file is produced at that real size. Exports are PDF, EPS and PNG only (no SVG), to match what suppliers accept.

| Method | Files | Checks |
|---|---|---|
| Screen print | Vector PDF (flat colours, one layer per ink), **separations PDF** (one black film page per ink, inks on top knock out the ones below, with registration marks), EPS | lines < 0.3 mm, gaps < 0.3 mm, more than 8 inks |
| Pad print | PDF, separations PDF, EPS | more than 4 inks, logos over about 7 cm, gradients |
| Sublimation / doming | 300 dpi PNG, PDF (doming adds a shape outline) | full colour; gradients allowed |
| Glass / ceramic firing | PDF, separations PDF, EPS | spot colours, no gradients |
| Sandblasting / embossing | Solid black PDF / EPS (stencil or die) | one colour; sandblast up to about 40 cm² |
| Digital (DTG) / DTF | 300 dpi transparent PNG (DPI written into the file), PDF, EPS | lines < 0.3 / 0.5 mm, gaps |
| Laser engrave | Solid black PDF / EPS, 600 dpi PNG | lines < 0.15 mm |
| Vinyl / HTV cut | Cut-line PDF / EPS (outlines, one colour per layer), filled PDF, **mirror option** for heat-transfer vinyl | lines < 1 mm, gaps < 0.8 mm |
| Laser cut | Red hairline cut PDF / EPS, solid black PDF | lines < 0.8 mm, gaps < 0.5 mm |
| Embroidery | Clean PDF / EPS / PNG for the digitiser | lines < 1.2 mm, more than 15 thread colours |

Colour limits and which methods can print gradients follow Stacked's own Printing technologies page (merch.stacked.ie). The checks render the finished design at its real print size and highlight problem areas in red (too thin) and orange (gaps that may fill in). The limits are typical shop guidance; confirm with your printer for unusual materials.

The preview bar shows the design on white, black, navy, grey, red or any custom garment colour.

**Keyboard:** Ctrl+Z undo · Delete removes the selected item · Esc leaves erase/paint mode.

## Limits worth knowing

- Text only a few pixels tall in the original, like a tagline under a 120 px logo, can't be recovered by any tool. Retype it with the Text tool.
- Photographic logos and gradients are converted to flat colour areas (the screen-print approach). For DTG, use the original image if it's already high resolution.
- EPS files (and old PostScript-based .ai files) are converted to PDF inside the browser with Ghostscript, so they open like any PDF and still never leave the computer. The reader is 16 MB and loads the first time an EPS is opened; the double-click copy downloads it from the live server, so it needs the internet for EPS.
- Background removal works on solid-colour backgrounds. A logo on a photo needs cropping, or erasing the leftover shapes by hand.
- Embroidery still needs digitising into stitches by your digitiser or embroidery software.

## What's inside

Everything runs from this folder, with no internet needed once it's loaded:

- `js/`: the app (`trace.js` colour clean-up and tracing, `upscale.js` AI upscaling, `pdf.js` PDF/AI reading, `eps.js` EPS reading, `zip.js` brand packs, `editor.js` canvas, `text.js` outlined text, `export.js` PDF/EPS/PNG files, `checks.js` print checks)
- `tools/build-single.py`: rebuilds `Logo Prep Studio.html` from the source
- `vendor/`: third-party libraries and AI models (see `LICENSES.md`)
- `fonts/`: open-licence fonts for the Text tool and the interface

## Brand

The interface follows the **Stacked AV** look (from the *Stacked AV — Design System Breakdown*): navy `#1B222A` ground with deep navy `#12171D` for the header and toolbar, AV orange `#F37626` used only for small marks (labels, short rules, one word in a headline, buttons), white type and muted `#9AA3AE` captions; small orange tracked capitals with a short orange stub underneath; two-tone headlines; no decorative shapes; the logo top-right. The logo is the 2026 **stacked MERCH** lockup.

It's built on the Stacked design system's own files in `vendor/stacked-ds/` (unchanged): `tokens.css`, `components.css` (the `stk-` buttons and toast), the Gotham Rounded and Gotham fonts and the logos. `css/app.css` sets the AV palette over the system's tokens and lays the tool out.

The Text tool offers Gotham Rounded and Gotham from the same files, so merch text can be set in the house faces.

"""Build 'Logo Prep Studio.html': the whole tool in one file that works when
double-clicked (no server). Scripts, AI models, fonts and the tracer are
embedded. Run from the logo-studio folder:  python3 tools/build-single.py
Needs esbuild (npx esbuild) for bundling the app's modules."""
import base64, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'Logo Prep Studio.html')
ESBUILD = os.environ.get('ESBUILD', 'npx --yes esbuild@0.24.2')

def read(p, mode='r'):
    with open(os.path.join(ROOT, p), mode) as f: return f.read()

def b64(p): return base64.b64encode(read(p, 'rb')).decode()

def script(js): return '<script>' + js.replace('</script', '<\\/script') + '</script>'

bundle = subprocess.run(f'{ESBUILD} js/main.js --bundle --format=iife --minify --external:fs --log-level=error',
                        shell=True, cwd=ROOT, capture_output=True, text=True)
if bundle.returncode: sys.exit(bundle.stderr)

# Fonts for the text tool and the tracer's wasm become blob URLs at startup.
assets = {f'fonts/{f}': ('font/woff', b64(f'fonts/{f}')) for f in sorted(os.listdir(os.path.join(ROOT, 'fonts'))) if f.endswith('.woff')}
assets['vendor/vtracer/vtracer.wasm'] = ('application/wasm', b64('vendor/vtracer/vtracer.wasm'))
assets['vendor/pdfjs/pdf.worker.min.js'] = ('text/javascript', b64('vendor/pdfjs/pdf.worker.min.js'))

models = {}
for kind in ('realcugan', 'realesrgan'):
    base = os.path.join(ROOT, 'vendor/upscaler/models', kind)
    for name in sorted(os.listdir(base)):
        mj = os.path.join(base, name, 'model.json')
        if not os.path.exists(mj): continue
        spec = json.load(open(mj))
        paths = [p for g in spec['weightsManifest'] for p in g['paths']]
        data = b''.join(open(os.path.join(base, name, p), 'rb').read() for p in paths)
        models[f'{kind}/{name}/model.json'] = {'json': spec, 'bin': base64.b64encode(data).decode()}

boot = ('(function(){var a=%s,m={};for(var k in a){var s=atob(a[k][1]),u=new Uint8Array(s.length);'
        'for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);m[k]=URL.createObjectURL(new Blob([u],{type:a[k][0]}));}'
        'm["vendor/upscaler/models"]="embedded://models";globalThis.__ASSETS=m;globalThis.__MODELS=%s;})();'
        % (json.dumps(assets), json.dumps(models, separators=(',', ':'))))

css = read('css/app.css')
css = re.sub(r'url\(\.\./fonts/([^)]+\.woff2)\)', lambda m: f'url(data:font/woff2;base64,{b64("fonts/" + m.group(1))})', css)

html = read('index.html')
html = html.replace('<link rel="stylesheet" href="css/app.css">', '<style>' + css + '</style>')
for src in re.findall(r'<script src="(vendor/[^"]+)"></script>', html):
    html = html.replace(f'<script src="{src}"></script>', script(read(src)))
html = html.replace('<script type="module" src="js/main.js"></script>', '')
# the app script runs after the page markup exists
head, _, tail = html.rpartition('</body>')   # the page's own tag is the last one
html = head + script(boot) + script(bundle.stdout) + '</body>' + tail
open(OUT, 'w').write(html)
print(f'{OUT}: {os.path.getsize(OUT) / 1e6:.1f} MB')

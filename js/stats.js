// The team's running totals shown at the bottom of the screen: logos loaded
// into the tool and files downloaded. Only "one more" is sent, never anything
// about the logo. The double-click copy reports to the live server.

import { LIVE_SERVER } from './config.js';

const base = location.protocol.startsWith('http') ? '' : LIVE_SERVER;
const fmt = n => Number(n || 0).toLocaleString('en-IE');

function show(s) {
  const el = document.querySelector('#stats');
  if (!el || !s || typeof s.loaded !== 'number') return;
  el.querySelector('[data-k=loaded]').textContent = fmt(s.loaded);
  el.querySelector('[data-k=downloaded]').textContent = fmt(s.downloaded);
  el.querySelector('[data-w=loaded]').textContent = s.loaded === 1 ? 'logo loaded' : 'logos loaded';
  el.querySelector('[data-w=downloaded]').textContent = s.downloaded === 1 ? 'file downloaded' : 'files downloaded';
  el.hidden = false;
}

async function call(method, event) {
  try {
    const r = await fetch(`${base}/api/stats${event ? '?e=' + event : ''}`, { method, keepalive: true });
    if (r.ok) show(await r.json());
  } catch { /* offline or no server: the counter just stays hidden */ }
}

export const loadStats = () => call('GET');
export const countLoad = () => call('POST', 'load');
export const countDownload = () => call('POST', 'download');

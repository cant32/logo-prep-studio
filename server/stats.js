// Two running totals for the team: logos loaded into the tool and files
// downloaded from it. Only the numbers are kept, nothing about the logos.
// They live in a small JSON file; on Railway that file sits on a volume
// (mounted at /data) so it survives redeploys.

import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.STATS_FILE || (fs.existsSync('/data') ? '/data/stats.json' : path.resolve('stats.json'));
const counts = { loaded: 0, downloaded: 0, since: new Date().toISOString() };
try { Object.assign(counts, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* first run */ }
console.log(`stats in ${FILE}: ${counts.loaded} loaded, ${counts.downloaded} downloaded`);

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = FILE + '.tmp';
    fs.promises.writeFile(tmp, JSON.stringify(counts)).then(() => fs.promises.rename(tmp, FILE))
      .catch(e => console.log(`stats not saved: ${e.message}`));
  }, 1000);
}

export const getStats = () => ({ loaded: counts.loaded, downloaded: counts.downloaded, since: counts.since });
export function count(event) {
  if (event === 'load') counts.loaded++;
  else if (event === 'download') counts.downloaded++;
  else return false;
  save();
  return true;
}

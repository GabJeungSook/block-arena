// Checks that the ranking rules embedded in public/index.html match src/rank.js exactly,
// and that both give the same answers across a sweep of inputs.
import { readFileSync } from 'node:fs';
import * as server from '../src/rank.js';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const m = html.match(/\/\/ <rank\.js>\n([\s\S]*?)\/\/ <\/rank\.js>/);
if (!m) { console.error('rank block not found in index.html'); process.exit(1); }
const client = new Function(m[1] + '\nreturn { rankOf, rpDelta, applyDelta, TIERS, MASTER_RP };')();
let n = 0, bad = 0;
for (let rp = 0; rp <= 2200; rp += 37) {
  for (const kind of ['cpu', 'arena', 'online']) for (const level of ['easy', 'normal', 'hard', 'expert']) for (const size of [2, 4, 6]) for (let place = 1; place <= size; place++) {
    const r = { kind, level, size, place };
    const a = server.rpDelta(r, rp), b = client.rpDelta(r, rp); n++;
    if (a !== b || server.applyDelta(rp, a) !== client.applyDelta(rp, b)) { bad++; if (bad < 5) console.error('mismatch', r, rp, a, b); }
  }
  if (JSON.stringify(server.rankOf(rp)) !== JSON.stringify(client.rankOf(rp))) { bad++; console.error('rankOf mismatch', rp); }
}
console.log(bad ? `FAIL: ${bad} mismatches out of ${n}` : `OK: ${n} cases match`);
process.exit(bad ? 1 : 0);

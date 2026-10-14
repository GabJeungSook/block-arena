// The game's copy of the shop prices must match the server's (src/shop.js).
import { readFileSync } from 'node:fs';
import { PRICES } from '../src/shop.js';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const m = /\/\/ <shop-prices>\s*const PRICES = (\{[\s\S]*?\});\s*\/\/ <\/shop-prices>/.exec(html);
if (!m) { console.error('shop-prices block not found in index.html'); process.exit(1); }
const client = Function(`return ${m[1]}`)();
const a = JSON.stringify(Object.entries(client).sort()), b = JSON.stringify(Object.entries(PRICES).sort());
if (a !== b) { console.error('Shop prices differ between public/index.html and src/shop.js'); process.exit(1); }
console.log(`OK: ${Object.keys(PRICES).length} shop prices match`);

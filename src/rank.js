// Block Arena ranking rules. This file is the single source of truth: the server imports it,
// and public/index.html carries an identical copy (test/rank-parity.mjs checks they match).
//
// Ranks: Bronze, Silver, Gold, Platinum, Diamond with divisions III → II → I (100 RP each),
// then Master from 1500 RP with no ceiling. You can drop a division but never a whole tier:
// each tier's floor is protected once you reach it.
export const TIERS = [
  { name: 'Bronze', color: '#c98b5a' },
  { name: 'Silver', color: '#cfd6e6' },
  { name: 'Gold', color: '#ffd21a' },
  { name: 'Platinum', color: '#22d3c5' },
  { name: 'Diamond', color: '#22b8ff' },
  { name: 'Master', color: '#a338ff' },
];
export const MASTER_RP = 1500;
const DIFF = { easy: .5, normal: 1, hard: 1.5, expert: 2 };          // how much a CPU win is worth
const LOSS = { easy: 1.2, normal: 1, hard: .8, expert: .6 };          // how much a CPU loss costs
const ARENA_CPU = { 4: [12, 4, -4, -9], 6: [16, 8, 2, -3, -7, -10] };
const ARENA_ONLINE = { 2: [20, -16], 3: [22, 2, -14], 4: [24, 10, -6, -14], 5: [27, 13, 2, -9, -16], 6: [30, 16, 5, -5, -12, -18] };

export function rankOf(rp) {
  rp = Math.max(0, Math.floor(rp || 0));
  if (rp >= MASTER_RP) return { tier: 5, div: 0, name: 'Master', short: 'M', color: TIERS[5].color, into: rp - MASTER_RP, need: 0, floor: MASTER_RP };
  const tier = Math.floor(rp / 300), inTier = rp - tier * 300, step = Math.floor(inTier / 100);
  const div = 3 - step, roman = ['', 'I', 'II', 'III'][div];
  return { tier, div, name: `${TIERS[tier].name} ${roman}`, short: TIERS[tier].name[0] + roman, color: TIERS[tier].color, into: inTier - step * 100, need: 100, floor: tier * 300 };
}

// result: { kind: 'cpu' | 'arena' | 'online', level, size, place (1-based), draw }
export function rpDelta(result, rp) {
  const { kind, level = 'normal', size = 2, place = 1, draw = false } = result || {};
  const f = DIFF[level] ?? 1, lf = LOSS[level] ?? 1;
  let d = 0;
  if (draw) d = 0;
  else if (kind === 'cpu') d = place === 1 ? Math.round(10 * f) : -Math.round(10 * lf);
  else if (kind === 'arena') { const t = ARENA_CPU[size] || ARENA_CPU[4]; const v = t[Math.min(place, t.length) - 1]; d = Math.round(v > 0 ? v * f : v * lf); }
  else if (kind === 'online') { const t = ARENA_ONLINE[Math.min(6, Math.max(2, size))]; d = t[Math.min(place, t.length) - 1]; }
  const r = rankOf(rp);
  if (d < 0 && r.tier === 0) d = Math.round(d / 2);                    // Bronze losses are halved
  return d;
}

export function applyDelta(rp, d) {
  const floor = rankOf(rp).floor;
  return Math.max(d < 0 ? floor : 0, rp + d);
}

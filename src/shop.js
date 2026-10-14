// Shop catalog prices and coin limits. public/index.html carries a copy of PRICES between
// "// <shop-prices>" markers; `npm test` checks the two match.
export const PRICES = {
  'block:classic': 0, 'block:flat': 150, 'block:candy': 300, 'block:pixel': 400, 'block:neon': 600, 'block:gem': 800, 'block:glass': 1000,
  'ghost:outline': 0, 'ghost:dashed': 100, 'ghost:filled': 150, 'ghost:corners': 200, 'ghost:dots': 250, 'ghost:glow': 350,
  'fx:sparks': 0, 'fx:confetti': 200, 'fx:pixels': 300, 'fx:stars': 350, 'fx:bubbles': 400, 'fx:embers': 500,
  'bg:midnight': 0, 'bg:grid': 150, 'bg:blueprint': 250, 'bg:arcade': 400, 'bg:starfield': 450, 'bg:skyline': 600, 'bg:sakura': 750,
};
export const SLOTS = ['block', 'ghost', 'fx', 'bg'];
export const DEFAULTS = { block: 'block:classic', ghost: 'ghost:outline', fx: 'fx:sparks', bg: 'bg:midnight' };
export const MAX_PER_MATCH = 150;      // the most one match can pay out (6P online win with the daily bonus is ~110)
export const MIN_GAP_MS = 15000;       // a match can't end sooner than this after the previous payout
export const DAILY_CAP = 2500;         // coins from matches per UTC day
export const ACH_COINS = 50;           // per newly unlocked achievement

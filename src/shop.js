// Shop catalog prices and coin limits. public/index.html carries a copy of PRICES between
// "// <shop-prices>" markers; `npm test` checks the two match.
export const PRICES = {
  'block:classic': 0, 'block:flat': 150, 'block:candy': 300, 'block:pixel': 400, 'block:neon': 600, 'block:gem': 800, 'block:glass': 1000,
  'block:royal': 2000, 'block:magma': 2500, 'block:prism': 3000, 'block:cosmic': 4000,
  'ghost:outline': 0, 'ghost:dashed': 100, 'ghost:filled': 150, 'ghost:corners': 200, 'ghost:dots': 250, 'ghost:glow': 350,
  'ghost:pulse': 1500, 'ghost:rainbow': 2000, 'ghost:holo': 2500,
  'fx:sparks': 0, 'fx:confetti': 200, 'fx:pixels': 300, 'fx:stars': 350, 'fx:bubbles': 400, 'fx:embers': 500,
  'fx:fireworks': 1500, 'fx:lightning': 2500,
  'boom:classic': 0, 'boom:pixel': 200, 'boom:shockwave': 350, 'boom:firework': 500, 'boom:kaboom': 700, 'boom:nuke': 2500, 'boom:blackhole': 3500,
  'text:classic': 0, 'text:arcade': 250, 'text:neon': 450, 'text:comic': 650, 'text:slam': 1800, 'text:glitch': 2500, 'text:gold': 3500,
  'bg:midnight': 0, 'bg:grid': 150, 'bg:blueprint': 250, 'bg:arcade': 400, 'bg:starfield': 450, 'bg:skyline': 600, 'bg:sakura': 750,
  'bg:deepsea': 2000, 'bg:synthwave': 2500, 'bg:aurora': 3500,
};
export const SLOTS = ['block', 'ghost', 'fx', 'boom', 'text', 'bg'];
export const DEFAULTS = { block: 'block:classic', ghost: 'ghost:outline', fx: 'fx:sparks', boom: 'boom:classic', text: 'text:classic', bg: 'bg:midnight' };
export const MAX_PER_MATCH = 150;      // the most one match can pay out (6P online win with the daily bonus is ~110)
export const MIN_GAP_MS = 15000;       // a match can't end sooner than this after the previous payout
export const DAILY_CAP = 2500;         // coins from matches per UTC day
export const ACH_COINS = 50;           // per newly unlocked achievement

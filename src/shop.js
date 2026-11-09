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
  'block:paper': 250, 'block:wire': 200, 'block:stone': 300, 'block:wood': 350, 'block:brick': 450, 'block:jelly': 550, 'block:steel': 650, 'block:faces': 700, 'block:circuit': 750,
  'block:frost': 1800, 'block:glitch': 2200, 'block:plasma': 2800, 'block:diamond': 3500,
  'ghost:shadow': 120, 'ghost:cross': 150, 'ghost:arrows': 200, 'ghost:checker': 250, 'ghost:stars': 300, 'ghost:fire': 1800, 'ghost:sparkle': 2000, 'ghost:electric': 2200,
  'fx:hearts': 350, 'fx:snow': 400, 'fx:leaves': 400, 'fx:coins': 450, 'fx:notes': 450, 'fx:shards': 500, 'fx:ribbons': 1800, 'fx:galaxy': 2000, 'fx:supernova': 3000,
  'boom:party': 300, 'boom:ink': 400, 'boom:ice': 450, 'boom:portal': 600, 'boom:thunder': 2000, 'boom:supernova': 3000,
  'text:outline': 200, 'text:pixel': 300, 'text:bubble': 400, 'text:retro': 550, 'text:graffiti': 600, 'text:rainbow': 2000, 'text:fire': 2500, 'text:holo': 3000,
  'bg:checker': 200, 'bg:circuit': 400, 'bg:snow': 450, 'bg:dunes': 500, 'bg:rain': 550, 'bg:matrix': 600, 'bg:forest': 650, 'bg:nebula': 2500, 'bg:volcano': 3000, 'bg:warp': 3500,
  'frame:classic': 0, 'frame:wood': 300, 'frame:pixel': 350, 'frame:neon': 400, 'frame:candy': 450, 'frame:chrome': 600, 'frame:gold': 800, 'frame:rainbow': 2000, 'frame:fire': 2500, 'frame:electric': 3000,
};
export const SLOTS = ['block', 'frame', 'ghost', 'fx', 'boom', 'text', 'bg'];
export const DEFAULTS = { block: 'block:classic', frame: 'frame:classic', ghost: 'ghost:outline', fx: 'fx:sparks', boom: 'boom:classic', text: 'text:classic', bg: 'bg:midnight' };
export const MAX_PER_MATCH = 150;      // the most one match can pay out (6P online win with the daily bonus is ~110)
export const MIN_GAP_MS = 15000;       // a match can't end sooner than this after the previous payout
export const DAILY_CAP = 1500;         // coins from matches per UTC day
export const COINS_PER_SEC = 1.25;     // a payout can't exceed this many coins per second since the last one, so coins come at the pace of real play
export const GUEST_IMPORT = 1000;      // most a guest's coins and items can be worth when they move to a new account
export const ACH_COINS = 50;           // per newly unlocked achievement

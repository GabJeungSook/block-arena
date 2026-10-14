# Block Arena

A falling-block battle game: 2-minute versus matches, 4P and 6P arenas, online rooms where empty seats are filled with bots, Classic (endless) and Sprint 40. Ranked play and online rooms with Facebook sign-in, in-game friends with live online status and room invites, a global and friends leaderboard, achievements, and share cards for Facebook.

Everything runs on Cloudflare's free plan:

| Piece | What it does |
|---|---|
| `public/` | The game (one HTML file) and the privacy policy, served as static files |
| `src/worker.js` | Facebook sign-in, sessions, ranked match results, leaderboard, account deletion |
| `src/room.js` | Online rooms (a Durable Object per room, WebSockets) |
| `src/hub.js` | Who's online, room invites and friend requests in real time (one Durable Object, one WebSocket per signed-in player) |
| `src/rank.js` | Ranking rules. `public/index.html` carries a copy; `npm test` checks they match |
| `migrations/` | Database tables (Cloudflare D1) |

## Ranking

- Tiers: **Bronze → Silver → Gold → Platinum → Diamond**, each with divisions III, II, I (100 RP each), then **Master** from 1500 RP.
- You can drop a division but never a whole tier once you've reached it. Bronze losses are halved.
- Ranked modes: 1 vs 1 and arenas against CPUs (harder CPUs give more), and online matches.
- The server computes every rank change. A match must last at least 20 seconds, each match can be reported once, and leaving a ranked match counts as a loss the next time you start one.
- Results are still reported by the player's browser, so a determined cheater could fake them. Server-side match verification is the next step if that becomes a problem.

## Deploy (about 20 minutes, all free)

You need [Node.js 20+](https://nodejs.org), a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a [Meta developer account](https://developers.facebook.com).

### 1. Put the game online

```bash
git clone https://github.com/GabJeungSook/block-arena
cd block-arena
npm install
npx wrangler login                 # opens a browser to sign in to Cloudflare
npx wrangler d1 create block-arena # prints a database_id
```

Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`), then:

```bash
npm run db:init     # creates the tables
npm run deploy      # prints your address, e.g. https://block-arena.<you>.workers.dev
```

The game now works at that address. Everything except Facebook sign-in is live.

### 2. Create the Facebook app

On [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create app**. Meta changes the dashboard wording from time to time, so the labels may differ slightly:

1. Choose the use case for **authenticating users with Facebook Login**.
2. In **Facebook Login → Settings**, add this under **Valid OAuth Redirect URIs**:
   `https://YOUR-ADDRESS/auth/facebook/callback`
3. In **App settings → Basic**:
   - **Privacy policy URL**: `https://YOUR-ADDRESS/privacy`
   - **User data deletion**: choose *Data deletion callback URL* and enter `https://YOUR-ADDRESS/auth/facebook/delete`
   - **App domains**: `YOUR-ADDRESS` (without https://)
4. Copy the **App ID** and **App secret** from the same page.
5. Switch the app from **Development** to **Live** so anyone can sign in. (While it's in Development, only people you add as testers can.) The game only asks for `public_profile`, which doesn't need Meta's App Review.

### 3. Connect them

Put the App ID in `wrangler.toml`:

```toml
[vars]
FB_APP_ID = "1234567890"
```

Store the App secret as a secret (it never goes in the repo):

```bash
npx wrangler secret put FB_APP_SECRET
npm run deploy
```

Open the game, tap **Continue with Facebook**, and you're ranked.

### Deploy automatically on every push (optional)

Cloudflare dashboard → **Workers & Pages → block-arena → Settings → Build** → connect this GitHub repo. Every push to `main` redeploys.

### Your own domain (optional)

Buy a domain (about $10/year), add it to Cloudflare, then **Workers & Pages → block-arena → Settings → Domains & Routes → Add custom domain**. Update the three URLs in your Facebook app to match.

## Friends, sharing and achievements

- **Sign-in rules**: ranked play and online rooms need Facebook sign-in. Guests can still play CPU, Classic, Sprint and local 2P unranked.
- **In-game friends**: every player has a friend code (Friends panel). Add friends by code, with an "add me" link shared on Facebook or Messenger, or with **Add friend** next to players in an online room. Requests are accepted in the Friends panel.
- **Who's online**: the Friends panel and the home-screen chip show which friends are online, in a room or in a match. **Invite to play** creates a room if you're not in one and sends a live invite; **Join** jumps into a friend's room.
- **Facebook friends** (optional): Facebook only shares a player's friend list with the "App friends" permission (`user_friends`), which needs Meta App Review. Once approved, set the variable `FB_FRIENDS=1` in Cloudflare (Workers & Pages → block-arena → Settings → Variables) and Facebook friends who play are added automatically when they sign in. In-game friends work without it.
- **Sharing**: rank, match results and achievements become 1200×630 cards at `/s/<id>`; Facebook shows the card and the link opens the game.
- **Achievements**: 15 medals, saved to the account and synced across devices.

## Run it on your computer

```bash
npm install
printf 'DEV_LOGIN=1\n' > .dev.vars   # enables a fake login for testing; never set this in production
npm run db:init:local
npm run dev
```

Open http://127.0.0.1:8787. To sign in without Facebook, visit http://127.0.0.1:8787/auth/dev?name=Tester.

```bash
npm test   # checks the game's copy of the ranking rules matches the server's
```

## Free plan limits

- **Workers**: 100,000 requests a day.
- **Durable Objects (rooms and the hub)**: 100,000 requests a day. WebSocket messages count 20 to 1, so a full 6-player match is about 360 requests. Each signed-in player keeps one hub connection; it sleeps while idle and only sends a message when their status changes, so staying online costs almost nothing.
- **D1 (accounts, ranks)**: 5 million rows read and 100,000 written a day, 5 GB stored.

If a limit is reached, that feature stops until midnight UTC. Nothing is billed unless you upgrade to the $5/month plan.

## Privacy

`public/privacy.html` explains what's stored: the Facebook ID, name and picture, rank and progress. Players can delete their account from **Settings → Account** in the game, or by removing the app in their Facebook settings, which calls the deletion callback.

# The Daily Dose

Daily history games built from real photographs. The first game, **Snapshot**, is below.

A browser game: study a historical photograph, drop a pin where you think it was taken, and slide to the year. Five rounds per match, up to 10,000 points each.

Static HTML + vanilla JS + Tailwind (CDN) + Leaflet/OpenStreetMap. No build step, no backend, no API keys.

## Pages

- **`/`** (`index.html`) is the games hub: a "Play today" page with one card per game. Each card opens that game's own menu.
- **`/snapshot`** (`snapshot.html`) is the photo game. Its menu has a "‹ All games" link back to the hub.

- **`/pinpoint`** (`pinpoint.html`) is a quick-fire geography game on a 3D globe (see below).
- **`/outline`** (`outline.html`) is the country-silhouette game (see below).
- **`/leaderboard`** (`leaderboard.html`) holds the daily and all-time leaderboards (see below). It's linked from the hub header and from each game's daily results.

Timeline and Older or Newer show on the hub as "Coming soon" cards. To add a game, copy a `.game-card` block in `index.html`, point its `href` at the game's page and give it a colour in `css/hub.css`.

## Accounts

The **Sign in** button (top right of the hub) opens `signin.html`. There you can sign in or create an account with just a **username and password**, no email. Once you're signed in, the button shows your username.

Accounts run on **Cloudflare Pages Functions** (`functions/api/[[route]].js`) with a **Cloudflare D1** database. Until the database is connected, the sign-in page says accounts aren't switched on yet, and every game still works for guests.

### Switching accounts on (one-time, about 5 minutes)

1. **Create the database.** In the Cloudflare dashboard go to **Storage & Databases → D1 SQL Database → Create**. Name it `daily-dose-accounts`.
2. **Connect it to the site.** Open **Workers & Pages → your Pages project → Settings → Bindings → Add → D1 database**:
   - Variable name: `DB` (exactly this, in capitals)
   - D1 database: `daily-dose-accounts`
   - Add it for **Production**, and for **Preview** too if you use preview deployments.
3. **Redeploy.** Go to **Deployments**, open ⋯ on the latest deployment and choose **Retry deployment**. Bindings only apply to new deployments.
4. **Test it.** Click **Sign in → Create account** on your site. The database tables are created automatically the first time.

To see who has signed up, open the database's **Console** tab in Cloudflare and run `SELECT id, username, created_at FROM users;`.

### Synced daily results

Once a player is signed in, their daily challenge results (the archive calendar, plus any game in progress) follow them to any device:

- **When syncing happens:** every page pulls the account's results on load and merges them in. Every round or guess is saved to the account as it happens.
- **Guest progress:** results played as a guest before signing in are uploaded when the player signs in or creates an account.
- **Conflicts:** the first finished result for a day counts, and an unfinished game only moves forward. The server enforces this too, so a second device or a stale tab can't overwrite a real result.
- **Signing out** clears the results from that browser, so a shared computer doesn't show the previous player's calendar.

Stored in the `daily_results` table (one row per user, game and day), via `GET /api/dailies` and `PUT /api/dailies`. The table is created automatically. Client side: `js/daily-archive.js`.

### Leaderboards

`leaderboard.html` has two tabs. Both need accounts switched on; without them the page says so.

- **Daily:** one board per game per day, with arrows to step back through past days. Pinpoint and Snapshot rank by score, and Outline ranks by fewest guesses (a loss ranks last). Ties go to whoever finished first.
- **All-time:** choose a game, then a stat:

| Game | Stats |
| --- | --- |
| Snapshot, Pinpoint | Total points · Average score (3+ dailies) · Best score · Games played · Current streak · Longest streak |
| Outline | Wins · Win rate (5+ dailies) · Avg guesses in a win (3+ wins, lower is better) · Games played · Current streak · Longest streak |
| All games | Dailies played · Current streak · Longest streak (days with at least one daily) |

**What counts.** Only a **daily challenge finished on its day** counts. Practice games and archive replays never do. "On its day" means the result was finished, and reached the server, while that date was still today somewhere on Earth (UTC+14 to UTC−12). Results played as a guest that day are added when the player signs in. Players see the top 50, plus their own rank if they're further down. **Usernames on leaderboards are public.**

**Cheating.** The server re-checks every result before ranking it; anything that fails is still kept as the player's own result but never ranked:

- **Outline:** the last guess must really be that day's answer, and there can be no repeated or unknown countries.
- **Pinpoint:** the five places must be that day's places, with the right multipliers, and the points must add up.
- **Snapshot:** only the range (0–50,000) is checked.

Like any browser game it can't prove a player didn't look the answer up or script their guesses, so treat the boards as friendly competition.

Stored in the `leaderboard_entries` table (one row per user, game and day, created automatically and backfilled from existing synced results). Read via `GET /api/leaderboard?type=daily&game=…&day=YYYY-MM-DD` or `?type=alltime&game=…|all&metric=…`. Client: `js/leaderboard.js`.

### Security

- **Passwords:** never stored, only PBKDF2-SHA256 hashes (100,000 iterations) with a random salt per user.
- **Sessions:** a random token in an HttpOnly, Secure cookie that lasts 30 days. Only a hash of the token is stored.
- **Brute-force protection:** 10 wrong passwords for one username, or 30 from one network, within 15 minutes locks login for 15 minutes. Sign-ups are limited to 5 per network per hour.
- **Cross-site requests:** requests from other websites are refused.
- **No password reset,** because there's no email to send it to. The sign-up form warns about this.

**Test accounts locally** with Cloudflare's dev server, which gives you a local database. Open http://localhost:8788 after running:

```bash
npx wrangler pages dev . --d1 DB
```

## Daily archive

The date at the top right of the hub opens a calendar of every daily challenge since launch (7 November 2026).

- **Dots:** each day shows one dot per daily game (Snapshot, Pinpoint, Outline): filled means played, half means in progress, empty means not played.
- **Choosing a day** lists the three games with your result and a **Play**, **Continue** or **View result** button.
- **Opening a past day:** any game opened with `?date=YYYY-MM-DD` (e.g. `/outline?date=2026-11-20`) plays that day's challenge. Dates before launch, in the future or invalid fall back to today. Each game's start screen links back to the calendar ("Missed a day?"), and `/#archive` opens it directly.
- **Day boundary:** like Wordle, a day is the **player's own local date**, so new challenges unlock at each player's midnight. Everyone on the same date gets the same challenges (a player in Tokyo reaches the next day's puzzles before one in Houston). Results are saved in the browser per game and per day by `js/daily-archive.js`, in `localStorage` key `dailies.<game>`. Results saved before the archive existed are carried over automatically.
- **Adding a daily game:** add it to `GAMES` in `js/daily-archive.js`, read `?date=` with `DailyArchive.requestedDay()`, and save results with `DailyArchive.write(game, day, { done, summary, ... })`.

## Pinpoint

There are five rounds, with 25 seconds each to tap a named place on a blank 3D globe.

- **The globe:** NASA Blue Marble imagery (public domain, in `assets/`), with no borders, labels or city lights. It runs on [globe.gl](https://github.com/vasturiano/globe.gl) 2.46.1 from jsDelivr.
- **Getting harder:** each round draws from a harder pool and is worth more:

| Round | Pool | Multiplier |
|---|---|---|
| 1 | Very easy: megacities | ×1 |
| 2 | Easy: major capitals | ×1.5 |
| 3 | Medium: regional hubs | ×2 |
| 4 | Hard: smaller or remote cities | ×2.5 |
| 5 | Very hard: obscure towns and islands | ×3 |

- **Scoring:** the base score is 0–1,000, from the Haversine distance. A guess within 10 km scores 1,000, decaying to about 520 at 1,000 km. That base is multiplied by the round's multiplier, so a perfect game is 10,000. Running out of time scores 0.
- **Two modes:**
  - **Daily challenge:** everyone gets the same five places on a given date (each player's local date). The date seeds a small random-number generator that picks one place per pool, so no server is needed. There's one attempt per day, saved in the browser. If the page is reloaded mid-round, that round counts as timed out, so a hard round can't be skipped by reloading. The day count starts from Daily #1 on 7 November 2026 (`DAILY_EPOCH`).
  - **Practice:** random places, unlimited.
- **Results:** total, average and closest distance, time-outs, and a per-round breakdown. **Share result** copies something like:

  ```
  Pinpoint Daily #1 · 7 November 2026
  🟩🟨🟩🟩🟩  8,676 / 10,000
  ```

  🟩 is within about 200 km, 🟨 is mid-range, 🟥 is far and ⬛ is timed out.
- **Places:** 2,597 in total, at least 517 per round, from 91–131 countries per round. They live in `js/pinpoint-places.js`, generated from [GeoNames](https://www.geonames.org/) (CC BY 4.0) by `scripts/build-pinpoint-places.js`:

  | Round | Rule |
  |---|---|
  | 1 Very easy | the most populous cities (500k+) |
  | 2 Easy | national capitals, then state and province capitals |
  | 3 Medium | other cities of 100k–1.5M people |
  | 4 Hard | towns of 20k–200k at least 150 km from any city of 100k+ |
  | 5 Very hard | the most isolated settlements, plus small island territories |

  Each round caps how many places one country can contribute (16–32) and keeps places 25–90 km apart, so a round is never one country's suburbs. The 50 hand-picked places in `pinpoint.html` are always included in their rounds, and are the fallback if the places file can't load. To rebuild, or after changing the rules:

  ```bash
  npm install --no-save all-the-cities@3.1.0
  node scripts/build-pinpoint-places.js
  ```
- **Controls:** drag to spin, scroll or pinch to zoom, and tap or click to guess.

## Outline

Outline is at **`/outline`** (`outline.html`). You name the country from its silhouette in six guesses. Each wrong guess shows the distance between the two countries' centre points (Haversine), an arrow pointing from your guess towards the answer, and how close you are as a percentage. The continent is revealed after three guesses. Like Pinpoint, it has a **Daily challenge** (the same country for everyone on a given date, unlocking at local midnight; one attempt, resumable) and unlimited **Practice**.

- **Country data:** `js/outline-countries.js`, 195 countries (the 193 UN members plus Vatican City and Palestine), with `name.common`, `latlng`, `cca2` and the continent.
  - It comes from [mledoze/countries](https://github.com/mledoze/countries) (ODbL), the dataset REST Countries is built on.
  - **Why it isn't fetched live:** REST Countries' v3.1 API has been shut down (it now returns "This API version has been deprecated"), and v5 needs an account API key. The data is bundled instead.
- **Silhouettes:** `assets/outlines/{cca2}.svg`, generated from [Natural Earth](https://www.naturalearthdata.com/) 1:10m (public domain). They're inlined so CSS sets the colour.
  - Each country is drawn in Mercator, centred on itself, so nothing splits at ±180°.
  - Small far-off territories are dropped: France has Corsica but not French Guiana, while the US keeps Alaska.
  - 24 microstates and atoll nations (e.g. Tuvalu, Monaco, the Maldives) are too small or scattered to recognise. They can be guessed but are never the answer, leaving 171 possible answers.
- **Daily answers** follow a fixed shuffled order, so no country repeats for 171 days.
- **Rebuilding:**

  ```bash
  npm install --no-save world-countries@5 world-atlas@2.0.2 topojson-client@3.1.0 d3-geo@3.1.1
  node scripts/build-outline-data.js
  ```

## Game modes

The main menu offers three modes:

- **Play:** five random photographs from the whole catalogue. Photos you've already seen this session are avoided.
- **Daily:** the same five photos for everyone on a given date (the player's local date). They're picked by hashing the date, so no server is needed. Your first score each day is saved in the browser and shown on the menu; replays don't overwrite it.
- **Eras:** pick a period (1900–1919, 1920–1939, …). Eras with fewer than five photos in the catalogue are disabled until a build adds more.

The menu also shows matches played and your best score, both stored in the browser's localStorage.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to Cloudflare Pages

- **Framework preset:** None
- **Build command:** *(leave empty)*
- **Build output directory:** `/`

All asset paths are relative (`./`), and `_headers` sets basic security and cache headers.

**Caching:** `_headers` makes browsers check for a newer copy of CSS, JS and photo data on every visit, so a new deploy never shows new pages with old styles. The `?v=…` on each stylesheet and script link in the HTML pages forces a fresh download after a change. If you edit CSS or JS, bump that value in `index.html`, `signin.html` and `snapshot.html`.

## Scoring

| Part | Max | Rule |
|---|---|---|
| Location | 5,000 | Haversine distance, in 1,000 km bands that lose fewer points per km the further out they are, with a step down at each boundary. 5,000 − 2·km up to 500 km, then 4,500 − km, 3,500 − km/2, 2,500 − km/3 and 1,500 − km/5. Past 4,000 km it loses 1/6, 1/7, … points per km, reaching 0 at about 9,600 km. |
| Date | 5,000 | Exact year 5,000. Within 5 years, −42.857x² − 2.8571x + 4990 (x = years off). Then 3,400 (6–7), 2,500 (8–10), 2,000 (11–15), 1,000 (16–20), 0 (over 20). |

The scoring logic lives in `js/scoring.js` as pure functions you can test with Node.

## Photos

The dataset lives in `js/data.js`. **The bundled `image_url` values are placeholders** (`https://unsplash.com` is a web page, not an image), so every round shows the "couldn't be loaded" card until you replace them with direct image links. You can link to Wikimedia Commons files or add images under `./photos/` and reference them relatively.

### Where the photos come from

The game uses a catalogue of real photographs from **Wikimedia Commons**, each with the **date and place the photo itself was taken**.

1. **`data/photos/`** is the main source: the catalogue split into shards of 200 photos, plus `manifest.js`. The game loads two random shards (about 400 photos) and loads more as you play through them, so thousands of photos never have to be downloaded at once.
2. **Live Wikidata queries** (`js/wikidata-rounds.js`) are **off by default**. They're slow (10–60 s) and use when a *place* was built rather than when the photo was taken. Turn them on with `LIVE_ROUNDS.enabled` in `js/game.js`.
3. **The embedded entries in `js/data.js`** are a last resort.

#### Building or growing the catalogue

```bash
node scripts/build-photos.js --per-year 30
```

For each year from 1900 to 2026, the script searches Commons' "*year* photographs" category tree for photos with coordinates. A photo is kept only if:

- its own date is precise to the year ("1950s" and "circa 1950" are rejected) and matches the category year,
- it's a JPEG or PNG at least 500 px wide,
- it has real coordinates.

It caps how many photos any one photographer or archive can contribute per year, then writes `data/photos.json` (the master list) and the shards.

- **Bigger catalogue:** `--per-year 60`.
- **Only some years:** `--from 1940 --to 1960`.
- **Resuming:** finished years are cached in `data/.build-cache/`, so a run you stop can be picked up again. Use `--refresh` to re-fetch them instead.
- **Run time:** about 1 request per second, roughly 30–60 minutes for the full range.

Commit `data/photos.json` and `data/photos/` to deploy.

#### Curation: keeping only photos of places

`scripts/curate-photos.js` filters the catalogue down to photos of recognisable places: streets, squares, landscapes, buildings, harbours, stations and events. It removes portraits, family snapshots, interiors, close-ups, documents, animals, satellite and survey frames, and grainy low-resolution scans.

```bash
node scripts/curate-photos.js --dry-run   # see what would be removed and why
node scripts/curate-photos.js             # apply it
```

- It reads each photo's Commons categories and size (cached in `data/.build-cache/meta.json`).
- `data/curation.json` holds manual decisions from looking at every photo. Its `reject` and `keep` lists always override the automatic rules.
- Removed photos are listed with a reason in `data/photos-rejected.json`. To bring one back, move its id to `keep` and re-run.
- `build-photos.js` runs the same curation automatically, so new photos are filtered too.

**Credits:** every photo has its own licence, often CC BY or CC BY-SA, which require attribution. The reveal shows the photographer and licence, with a link to the Commons page.

`js/data.js` also has a commented guide to the **Historypin API** (bounding-box queries).

## Files

```
index.html        The Daily Dose hub: one card per game, Sign in top right
signin.html       sign in / create account (username + password)
leaderboard.html  daily and all-time leaderboards (js/leaderboard.js)
outline.html      Outline country-silhouette game
js/outline-countries.js  195 countries for Outline (generated)
assets/outlines/  one SVG silhouette per country (generated)
scripts/build-outline-data.js  builds them
pinpoint.html     Pinpoint globe game
js/pinpoint-places.js  2,597 Pinpoint places (generated)
scripts/build-pinpoint-places.js  builds them from GeoNames
assets/earth-*    NASA Blue Marble texture + relief map for the globe
js/account.js     account client for /api
js/daily-archive.js  shared daily dates, ?date= and per-day results
js/hub-calendar.js   the hub's archive calendar
js/signin.js      sign-in page logic
functions/api/    accounts API (Cloudflare Pages Functions + D1)
snapshot.html     the Snapshot game (its own menu, rounds and results)
css/hub.css       hub styles
css/styles.css    component styles
js/scoring.js     Haversine and scoring (pure functions)
js/data.js        embedded fallback photos and Historypin docs
js/wikidata-rounds.js  Wikidata SPARQL + Commons fetcher
scripts/build-photos.js  builds the photo catalogue from Wikimedia Commons
data/photos.json  master photo catalogue
data/photos/      manifest.js + shard-NNN.js (what the game loads)
js/game.js        game loop, map, photo zoom/pan
assets/           favicon and image placeholder
_headers          Cloudflare Pages headers
```

## Notes

- OpenStreetMap's public tiles fall under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). They're fine for a hobby project. For heavy traffic, swap the URL in `initMap()` (in `js/game.js`) for a provider such as MapTiler or Stadia.
- Controls: scroll/pinch to zoom the photo, drag to pan, double-click to toggle zoom. Press **Enter** to submit or go to the next round, **M** to toggle the map, and **Esc** to collapse it.

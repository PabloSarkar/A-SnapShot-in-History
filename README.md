# A Snapshot in History

A browser game: study a historical photograph, drop a pin where you think it was taken, and slide to the year. Five rounds per match, up to 10,000 points each.

Static HTML + vanilla JS + Tailwind (CDN) + Leaflet/OpenStreetMap. No build step, no backend, no API keys.

## Game modes

The main menu offers three modes:

- **Play:** five random photographs from the whole catalogue. Photos you've already seen this session are avoided.
- **Daily:** the same five photos for everyone on a given day (UTC). They're picked by hashing the date, so no server is needed. Your first score each day is saved (in the browser, or your account) and shown on the menu with your day streak and a countdown to the next puzzle. Replays don't overwrite it.
- **Timeline** and **Older or Newer:** shown on the menu as "coming soon".
- **Eras:** pick a period (1900–1919, 1920–1939, …). Eras with fewer than five photos in the catalogue are disabled until a build adds more.

The menu also shows matches played and your best score.

## Accounts

Players can create an account with just a **username and password** (no email). Their scores, best match and Daily streak are saved to the account and follow them to any device. Playing as a guest still works, with progress kept in the browser. When a guest signs up, that progress is moved into the new account.

Accounts run on **Cloudflare Pages Functions** (`functions/api/[[route]].js`) with a **Cloudflare D1** database. Until the database is connected, the site works as before and "Sign in" says accounts aren't switched on yet.

### Switching accounts on (one-time, about 5 minutes)

1. **Create the database.** In the Cloudflare dashboard go to **Storage & Databases → D1 SQL Database → Create**. Name it `snapshot-accounts`. The default location is fine.
2. **Connect it to the site.** Open **Workers & Pages → your Pages project → Settings → Bindings → Add → D1 database**:
   - Variable name: `DB` (exactly this, in capitals)
   - D1 database: `snapshot-accounts`
   - Add it for **Production**, and for **Preview** too if you use preview deployments.
3. **Redeploy.** Go to **Deployments**, open the menu (⋯) on the latest deployment and choose **Retry deployment**. Bindings only apply to new deployments.
4. **Test it.** Open the site, click **Sign in → Create account**, and make an account. The tables are created automatically the first time anyone uses accounts.

To see your users, open the D1 database's **Console** tab and run `SELECT id, username, created_at FROM users;`. Passwords are never stored, only salted hashes.

### How it works

| Endpoint | What it does |
|---|---|
| `GET /api/me` | Who is signed in |
| `POST /api/signup` | Create an account (and sign in) |
| `POST /api/login` / `POST /api/logout` | Sign in / out |
| `GET`/`PUT /api/progress` | Load / save the player's progress |

- **Passwords:** hashed with PBKDF2-SHA256 (100,000 iterations), with a random salt per user.
- **Sessions:** a random token in an HttpOnly, Secure cookie that lasts 30 days. Only a hash of the token is stored.
- **Brute-force protection:** 10 wrong passwords for one username, or 30 from one network, within 15 minutes locks login for 15 minutes. Sign-ups are limited to 5 per network per hour.
- **Cross-site requests:** requests from other websites are refused.
- **No password reset,** because there's no email to send it to. The sign-up form warns about this.

**Test accounts locally** with Cloudflare's dev server, which gives you a local database:

```bash
npx wrangler pages dev . --d1 DB
```

Then open http://localhost:8788. The plain `python3 -m http.server` preview still works, just without accounts.

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
index.html        layout and screens
css/styles.css    component styles
js/scoring.js     Haversine and scoring (pure functions)
js/account.js     sign-in / sign-up client for /api
functions/api/    accounts API (Cloudflare Pages Functions + D1)
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

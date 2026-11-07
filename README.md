# A Snapshot in History

A browser game: study a historical photograph, drop a pin where you think it was taken, and slide to the year. Five rounds per match, up to 5,000 points each.

Static HTML + vanilla JS + Tailwind (CDN) + Leaflet/OpenStreetMap. No build step, no backend, no API keys.

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
| Location | 2,500 | Haversine distance. Full points within 25 km, 0 beyond 10,000 km, quadratic decay in between. |
| Time | 2,500 | 2,500 − 250 × years off, minimum 0. |

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

For each year from 1900 to 2020, the script searches Commons' "*year* photographs" category tree for photos with coordinates. A photo is kept only if:

- its own date is precise to the year ("1950s" and "circa 1950" are rejected) and matches the category year,
- it's a JPEG or PNG at least 500 px wide,
- it has real coordinates.

It caps how many photos any one photographer or archive can contribute per year, then writes `data/photos.json` (the master list) and the shards.

- **Bigger catalogue:** `--per-year 60`.
- **Only some years:** `--from 1940 --to 1960`.
- **Resuming:** finished years are cached in `data/.build-cache/`, so a run you stop can be picked up again. Use `--refresh` to re-fetch them instead.
- **Run time:** about 1 request per second, roughly 30–60 minutes for the full range.

Commit `data/photos.json` and `data/photos/` to deploy.

**Credits:** every photo has its own licence, often CC BY or CC BY-SA, which require attribution. The reveal shows the photographer and licence, with a link to the Commons page.

`js/data.js` also has a commented guide to the **Historypin API** (bounding-box queries).

## Files

```
index.html        layout and screens
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

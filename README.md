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

1. **`data/photos.json`** is the main source: a pre-built list of real, geolocated, dated photos from Wikidata and Wikimedia Commons. It loads instantly from your own site.
2. **Live Wikidata queries** (`js/wikidata-rounds.js`) are **off by default**. Each query takes about 10–60 s, which is too slow to run at the start of a match. Turn them on with `LIVE_ROUNDS.enabled` in `js/game.js`.
3. **The embedded entries in `js/data.js`** are a last resort. Their image URLs are placeholders.

To refresh or enlarge the photo list:

```bash
node scripts/build-photos.js 20
```

The number is roughly how many photos to keep per place type. The script queries each type, gets direct 1280px image URLs from Commons, checks that every image loads, and writes `data/photos.json`. It takes a few minutes. Commit the new file to deploy it.

`fetchHistoricalRounds(limit, options)` takes these options, in the build script or live:

```js
{ minYear: 1900, maxYear: 1980 }                         // a narrower era
{ country: 'Q142' }                                      // France only
{ bbox: { south: 36, west: -10, north: 60, east: 20 } }  // a map region
{ classes: ['Q12280', 'Q12518'] }                        // bridges and towers
```

Wikimedia only serves resized images at standard widths (250, 330, 500, 960, 1280, 1920). Other widths, such as 1600, return an error, so the module rounds the requested width up to the next of these.

Caveat: the year is when the *place* was built or established, not when the photo was taken. A recent photo of a 1950 stadium still scores against 1950.

`js/data.js` also has a commented guide to the **Historypin API** (bounding-box queries).

## Files

```
index.html        layout and screens
css/styles.css    component styles
js/scoring.js     Haversine and scoring (pure functions)
js/data.js        embedded fallback photos and Historypin docs
js/wikidata-rounds.js  Wikidata SPARQL + Commons fetcher
scripts/build-photos.js  builds data/photos.json
data/photos.json  pre-built photo list (main source)
js/game.js        game loop, map, photo zoom/pan
assets/           favicon and image placeholder
_headers          Cloudflare Pages headers
```

## Notes

- OpenStreetMap's public tiles fall under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). They're fine for a hobby project. For heavy traffic, swap the URL in `initMap()` (in `js/game.js`) for a provider such as MapTiler or Stadia.
- Controls: scroll/pinch to zoom the photo, drag to pan, double-click to toggle zoom. Press **Enter** to submit or go to the next round, **M** to toggle the map, and **Esc** to collapse it.

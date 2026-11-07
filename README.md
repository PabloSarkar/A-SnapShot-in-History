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

### Live photos from Wikidata and Commons

`js/wikidata-rounds.js` fetches fresh rounds each match. It asks the Wikidata Query Service for places that have an image (P18), coordinates (P625) and a year-precise inception (P571) or point in time (P585). It then uses the Wikimedia Commons API to get a direct, resized JPEG or PNG URL for each one. If either service is unreachable, the game falls back to the embedded set.

Adjust it through `LIVE_ROUNDS` at the top of `js/game.js`:

```js
options: { minYear: 1900, maxYear: 1980 }                         // a narrower era
options: { country: 'Q142' }                                      // France only
options: { bbox: { south: 36, west: -10, north: 60, east: 20 } }  // a map region
options: { classes: ['Q12280', 'Q12518'] }                        // bridges and towers
```

The module also works in Node 18+ or a serverless function (`require('./js/wikidata-rounds.js')`), for example to pre-build a static `photos.json`.

Caveat: the year is when the *place* was built or established, not when the photo was taken. A recent photo of a 1930 bridge still scores against 1930.

`js/data.js` also has a commented guide to the **Historypin API** (bounding-box queries).

## Files

```
index.html        layout and screens
css/styles.css    component styles
js/scoring.js     Haversine and scoring (pure functions)
js/data.js        embedded fallback photos and Historypin docs
js/wikidata-rounds.js  live rounds from Wikidata SPARQL and Commons
js/game.js        game loop, map, photo zoom/pan
assets/           favicon and image placeholder
_headers          Cloudflare Pages headers
```

## Notes

- OpenStreetMap's public tiles fall under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). They're fine for a hobby project. For heavy traffic, swap the URL in `initMap()` (in `js/game.js`) for a provider such as MapTiler or Stadia.
- Controls: scroll/pinch to zoom the photo, drag to pan, double-click to toggle zoom. Press **Enter** to submit or go to the next round, **M** to toggle the map, and **Esc** to collapse it.

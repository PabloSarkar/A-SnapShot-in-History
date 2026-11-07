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

That same file has a commented guide to pulling more photos from the **Wikidata SPARQL API** (P18 image, P625 coordinates, P571 inception) and the **Historypin API** (bounding-box queries).

## Files

```
index.html        layout and screens
css/styles.css    component styles
js/scoring.js     Haversine and scoring (pure functions)
js/data.js        photo dataset and API extension docs
js/game.js        game loop, map, photo zoom/pan
assets/           favicon and image placeholder
_headers          Cloudflare Pages headers
```

## Notes

- OpenStreetMap's public tiles fall under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). They're fine for a hobby project. For heavy traffic, swap the URL in `initMap()` (in `js/game.js`) for a provider such as MapTiler or Stadia.
- Controls: scroll/pinch to zoom the photo, drag to pan, double-click to toggle zoom. Press **Enter** to submit or go to the next round, **M** to toggle the map, and **Esc** to collapse it.

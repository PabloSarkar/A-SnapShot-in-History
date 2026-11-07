/* =============================================================================
 * A Snapshot in History — photo dataset
 * -----------------------------------------------------------------------------
 * Each entry:
 *   id           unique number/string
 *   image_url    direct link to an image file (jpg/png/webp). Must be an actual
 *                image, not a web page — if it fails to load, the game shows a
 *                placeholder and the round still plays normally.
 *   lat, lng     where the photo was taken (decimal degrees)
 *   actual_year  year the photo was taken (the slider covers 1900–2026)
 *   description  shown only AFTER the guess is submitted
 *
 * NOTE: the image_url values below are placeholders ("https://unsplash.com" is
 * a web page, not an image), so every round currently shows the "image
 * unavailable" card. Replace them with direct image URLs — e.g. a Wikimedia
 * Commons file link such as
 *   https://upload.wikimedia.org/wikipedia/commons/<a>/<ab>/<File_name>.jpg
 * or a file you add to this repo and reference relatively: "./photos/paris-1944.jpg"
 * ========================================================================== */

window.SNAPSHOT_DATA = [
  {
    id: 1,
    image_url: 'https://unsplash.com',
    lat: 48.8584,
    lng: 2.2945,
    actual_year: 1944,
    description:
      'Allied forces passing the Eiffel Tower in Paris, France shortly after the liberation of the city.'
  },
  {
    id: 2,
    image_url: 'https://unsplash.com',
    lat: 40.758,
    lng: -73.9855,
    actual_year: 1957,
    description:
      'Bright neon signs illuminate Times Square, New York City, captured during the bustling post-war economic boom.'
  },
  {
    id: 3,
    image_url: 'https://unsplash.com',
    lat: 52.5163,
    lng: 13.3777,
    actual_year: 1989,
    description:
      'Crowds gathering atop the Berlin Wall near the Brandenburg Gate in Germany as the borders finally open.'
  },
  {
    id: 4,
    image_url: 'https://unsplash.com',
    lat: 51.5007,
    lng: -0.1246,
    actual_year: 1908,
    description:
      'Horse-drawn carriages and early motor buses crowding the streets outside the Palace of Westminster in London.'
  },
  {
    id: 5,
    image_url: 'https://unsplash.com',
    lat: 35.6895,
    lng: 139.6917,
    actual_year: 1964,
    description:
      'The streets of Tokyo, Japan decorated and heavily modernised in preparation for the 1964 Summer Olympic Games.'
  }
];

/* =============================================================================
 * EXTENDING THE DATASET WITH HISTORICAL APIs
 * =============================================================================
 *
 * The game reads window.SNAPSHOT_DATA when a new match starts. Anything that
 * pushes objects in the shape above into that array (before the player presses
 * "Start") will be used. Both sources below are CORS-friendly enough to call
 * straight from the browser, so no backend is required on Cloudflare Pages.
 * (For heavy traffic, consider pre-fetching into a static ./data/photos.json at
 * build time instead and loading that — it is faster and kinder to the APIs.)
 *
 * -----------------------------------------------------------------------------
 * 1) Wikidata SPARQL API + Wikimedia Commons API  — IMPLEMENTED
 * -----------------------------------------------------------------------------
 * See js/wikidata-rounds.js and scripts/build-photos.js. The game's main
 * photo source is data/photos.json, built by that script. The entries above
 * are only used if that file can't be loaded.
 *
 * -----------------------------------------------------------------------------
 * 2) Historypin API  — https://www.historypin.org
 * -----------------------------------------------------------------------------
 * Historypin pins already carry native lat/lng and a date, which maps 1:1 onto
 * this dataset. Query by geographic bounding box (south-west / north-east
 * corners) and a date range. Check the current Historypin API documentation
 * for the exact endpoint and parameter names before use; the shape is roughly:
 *
 *   async function loadFromHistorypin({ south, west, north, east }) {
 *     const params = new URLSearchParams({
 *       bounds: [south, west, north, east].join(','),  // bounding box
 *       from: '1900-01-01',
 *       to: '2026-12-31',
 *       limit: 100
 *     });
 *     const res = await fetch('https://www.historypin.org/en/api/pin/listing.json?' + params);
 *     if (!res.ok) throw new Error('Historypin ' + res.status);
 *     const json = await res.json();
 *     return (json.results || [])
 *       .filter(pin => pin.location && pin.date && pin.display && pin.display.content)
 *       .map(pin => ({
 *         id: 'hp-' + pin.id,
 *         image_url: pin.display.content,             // image URL
 *         lat: Number(pin.location.lat),
 *         lng: Number(pin.location.lng),
 *         actual_year: parseInt(String(pin.date).slice(0, 4), 10),
 *         description: pin.caption || pin.description || 'Historypin photograph'
 *       }));
 *   }
 *
 * Tip: query several bounding boxes (one per continent) and merge, so a match
 * isn't five photos from the same city.
 *
 * -----------------------------------------------------------------------------
 * Wiring either source in
 * -----------------------------------------------------------------------------
 *   (async () => {
 *     try {
 *       const extra = await loadFromHistorypin({ south: 36, west: -10, north: 60, east: 20 });
 *       window.SNAPSHOT_DATA.push(...extra);
 *     } catch (err) {
 *       console.warn('Extra photos unavailable, using built-in set.', err);
 *     }
 *   })();
 *
 * Always respect each source's licence: show the photographer/credit if you
 * display Commons or Historypin images, and set a descriptive User-Agent /
 * contact where the API asks for one.
 * ========================================================================== */

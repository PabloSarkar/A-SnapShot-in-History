#!/usr/bin/env node
/* =============================================================================
 * Build the data for Outline (outline.html):
 *   js/outline-countries.js     every playable country: name, latlng, cca2, continent
 *   assets/outlines/{cc}.svg    one silhouette per country
 *
 *   npm install --no-save world-countries@5 world-atlas@2.0.2 topojson-client@3.1.0 d3-geo@3.1.1
 *   node scripts/build-outline-data.js
 *
 * Sources
 *   - Country facts: mledoze/countries ("world-countries" on npm, ODbL 1.0),
 *     the dataset REST Countries is built on. Same fields: name.common,
 *     latlng, cca2, ccn3, region/subregion, unMember, area.
 *   - Shapes: Natural Earth 1:10m admin-0 countries (public domain), via
 *     world-atlas, matched to countries by ISO numeric code (ccn3).
 *
 * Countries: the 193 UN members plus the two UN observer states (Vatican City,
 * Palestine) = 195.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

let countries, atlas, topojson, d3;
try {
  countries = require('world-countries');
  atlas = require('world-atlas/countries-10m.json');
  topojson = require('topojson-client');
  d3 = require('d3-geo');
} catch (e) {
  console.error('Missing dependencies. Run:\n  npm install --no-save world-countries@5 world-atlas@2.0.2 topojson-client@3.1.0 d3-geo@3.1.1');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const OUT_JS = path.join(ROOT, 'js', 'outline-countries.js');
const OUT_DIR = path.join(ROOT, 'assets', 'outlines');
const SIZE = 512, PAD = 28;
const OBSERVERS = new Set(['VA', 'PS']);

/* --------------------------------------------------------------- countries */
function continentOf(c) {
  if (c.region === 'Americas') return c.subregion === 'South America' ? 'South America' : 'North America';
  if (c.region === 'Antarctic') return 'Antarctica';
  return c.region; // Africa, Asia, Europe, Oceania
}
// A few common names read better in a guessing game.
const NAME_FIXES = { 'Czechia': 'Czechia', 'DR Congo': 'DR Congo', 'Republic of the Congo': 'Republic of the Congo', 'Vatican City': 'Vatican City' };

const playable = countries
  .filter((c) => c.unMember || OBSERVERS.has(c.cca2))
  .map((c) => ({
    name: NAME_FIXES[c.name.common] || c.name.common,
    cca2: c.cca2, ccn3: c.ccn3,
    lat: c.latlng[0], lng: c.latlng[1],
    continent: continentOf(c),
    area: c.area
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

/* ------------------------------------------------------------------ shapes */
// Some Natural Earth features share an ISO code with their country (e.g. Ashmore and
// Cartier Islands uses Australia's 036); keep the largest valid shape for each code.
const features = new Map();
for (const f of topojson.feature(atlas, atlas.objects.countries).features) {
  if (!f.id) continue;
  const a = d3.geoArea(f);
  if (!(a > 0 && a < 2 * Math.PI)) continue;          // NaN / degenerate / inverted
  const prev = features.get(f.id);
  if (!prev || a > d3.geoArea(prev)) features.set(f.id, f);
}
const R = 6371.0088;
const kmBetween = (a, b) => d3.geoDistance(a, b) * R;
const areaKm2 = (g) => d3.geoArea(g) * R * R;

/** Keep the main landmass plus nearby or substantial parts; drop small far-off territories. */
function mainParts(feature) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const parts = polys.map((coords) => {
    let poly = { type: 'Polygon', coordinates: coords };
    // Natural Earth has a few rings wound the "wrong" way for d3 (they'd mean
    // "the whole globe except this"); flip any polygon larger than a hemisphere.
    if (d3.geoArea(poly) > 2 * Math.PI) {
      coords = coords.map((ring) => ring.slice().reverse());
      poly = { type: 'Polygon', coordinates: coords };
    }
    return { coords, area: areaKm2(poly), centroid: d3.geoCentroid(poly) };
  }).sort((a, b) => b.area - a.area);
  const main = parts[0];
  const radius = Math.max(1000, 1.5 * Math.sqrt(main.area));
  // Far-off parts are kept only if they're substantial: 17% keeps Alaska (17.9% of the
  // contiguous US) but drops French Guiana (15.5% of metropolitan France).
  const kept = parts.filter((p) => p === main || p.area >= 0.17 * main.area || kmBetween(p.centroid, main.centroid) <= radius);
  return { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: kept.map((p) => p.coords) } };
}

/** Douglas–Peucker on a projected ring (pixels). */
function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      // Closed rings start and end on the same point: fall back to distance from that point.
      const d = len < 1e-9
        ? Math.hypot(points[i][0] - x1, points[i][1] - y1)
        : Math.abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}
const ringArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); };

let lastCoverage = 0;
function svgFor(feature) {
  const centre = d3.geoCentroid(feature);
  // Mercator (the shape people know from maps), rotated to the country so it never splits at ±180°.
  const projection = d3.geoMercator().rotate([-centre[0], 0]).precision(0.1)
    .fitExtent([[PAD, PAD], [SIZE - PAD, SIZE - PAD]], feature);
  const rings = [];
  for (const poly of feature.geometry.coordinates) {
    poly.forEach((ring, k) => {
      const pts = [];
      // Densify-free projection of each vertex; Natural Earth 10m is already detailed.
      for (const p of ring) { const xy = projection(p); if (xy) pts.push(xy); }
      const simple = simplify(pts, 0.45);
      if (simple.length < 4) return;
      if (ringArea(simple) < (k === 0 ? 0.8 : 1.5)) return;    // specks smaller than a pixel
      rings.push(simple);
    });
  }
  const d = rings.map((r) => 'M' + r.map(([x, y]) => (Math.round(x * 10) / 10) + ' ' + (Math.round(y * 10) / 10)).join('L') + 'Z').join('');
  // Share of the frame covered by land: atoll nations are just specks.
  lastCoverage = rings.reduce((sum, r, i) => sum + ringArea(r), 0) / (SIZE * SIZE);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + SIZE + ' ' + SIZE + '"><path fill-rule="evenodd" d="' + d + '"/></svg>\n';
}

/* ------------------------------------------------------------------ output */
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) if (f.endsWith('.svg')) fs.unlinkSync(path.join(OUT_DIR, f));

let bytes = 0;
const missing = [];
for (const c of playable) {
  const f = features.get(c.ccn3);
  // No usable shape (Vatican City and the Maldives are degenerate at this scale):
  // still guessable, never an answer.
  if (!f) { missing.push(c.name); c.target = 0; continue; }
  const svg = svgFor(mainParts(f));
  fs.writeFileSync(path.join(OUT_DIR, c.cca2.toLowerCase() + '.svg'), svg);
  bytes += svg.length;
  // Fair as an answer: big enough to recognise, and not a scatter of specks.
  c.target = c.area >= 500 && lastCoverage >= 0.02 ? 1 : 0;
}
if (missing.length) console.log('No outline (guessable, never an answer):', missing.join(', '));

const rows = playable.map((c) => [c.name, c.cca2, Math.round(c.lat * 100) / 100, Math.round(c.lng * 100) / 100, c.continent, c.target]);
fs.writeFileSync(OUT_JS,
  '/* Generated by scripts/build-outline-data.js. Do not edit by hand.\n' +
  ' * Country facts: mledoze/countries (ODbL 1.0), the dataset behind REST Countries.\n' +
  ' * Outlines in assets/outlines/: Natural Earth (public domain).\n' +
  ' * Row format: [name, cca2, lat, lng, continent, canBeAnswer (0/1)].\n' +
  ' * canBeAnswer is 0 for microstates and atoll nations whose outline is too\n' +
  ' * small or scattered to recognise; they can still be guessed. */\n' +
  'window.OUTLINE_COUNTRIES = ' + JSON.stringify(rows) + ';\n');

console.log('not used as answers:', playable.filter((c) => !c.target).map((c) => c.name).join(', '));
console.log(`${playable.length} countries (${playable.filter((c) => c.target).length} possible answers); outlines ${Math.round(bytes / 1024)} KB total (avg ${Math.round(bytes / playable.length / 1024 * 10) / 10} KB)`);
const byCont = {}; playable.forEach((c) => { byCont[c.continent] = (byCont[c.continent] || 0) + 1; });
console.log('by continent:', JSON.stringify(byCont));

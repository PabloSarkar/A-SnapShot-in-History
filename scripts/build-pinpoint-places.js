#!/usr/bin/env node
/* =============================================================================
 * Build the Pinpoint place pools (js/pinpoint-places.js) from GeoNames.
 *
 *   npm install --no-save all-the-cities@3.1.0
 *   node scripts/build-pinpoint-places.js
 *
 * Source: GeoNames "cities1000" (every populated place with ≥ 1,000 people),
 * via the all-the-cities npm package. Licence: CC BY 4.0, credit GeoNames.
 *
 * Tiers (each place appears in exactly one):
 *   1 Very easy   the most populous cities                       ≥ PER_TIER
 *   2 Easy        national capitals, then state/province capitals
 *   3 Medium      other cities of 100k–1.5M people
 *   4 Hard        towns of 20k–200k that are ≥ 150 km from any city of 100k+
 *   5 Very hard   the most isolated settlements, plus small island territories
 *
 * Every tier caps how many places one country can contribute and keeps a
 * minimum distance between places, so pools are spread across the world
 * and never contain a city and its own suburb. The hand-picked prototype
 * places in pinpoint.html are always included in their tiers.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const PER_TIER = 520;               // a little over 500, for headroom
const OUT = path.join(__dirname, '..', 'js', 'pinpoint-places.js');

let cities;
try { cities = require('all-the-cities'); }
catch (e) {
  console.error('Missing dependency. Run:  npm install --no-save all-the-cities@3.1.0');
  process.exit(1);
}

const countryName = (() => {
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const fixes = { 'St. Helena': 'Saint Helena', 'Svalbard & Jan Mayen': 'Svalbard', 'Wallis & Futuna': 'Wallis and Futuna',
    'Heard & McDonald Islands': 'Heard Island', 'St. Pierre & Miquelon': 'Saint Pierre and Miquelon', 'Turks & Caicos Islands': 'Turks and Caicos Islands',
    'Bosnia & Herzegovina': 'Bosnia and Herzegovina', 'Trinidad & Tobago': 'Trinidad and Tobago', 'Antigua & Barbuda': 'Antigua and Barbuda',
    'St. Kitts & Nevis': 'Saint Kitts and Nevis', 'St. Vincent & Grenadines': 'Saint Vincent and the Grenadines', 'St. Lucia': 'Saint Lucia',
    'São Tomé & Príncipe': 'São Tomé and Príncipe', 'Myanmar (Burma)': 'Myanmar', 'Congo - Kinshasa': 'DR Congo', 'Congo - Brazzaville': 'Republic of the Congo',
    'Côte d’Ivoire': 'Ivory Coast', 'Hong Kong SAR China': 'Hong Kong', 'Macao SAR China': 'Macau', 'Palestinian Territories': 'Palestine',
    'St. Barthélemy': 'Saint Barthélemy', 'St. Martin': 'Saint Martin', 'U.S. Virgin Islands': 'US Virgin Islands', 'Micronesia': 'Micronesia' };
  return (code) => { let n; try { n = dn.of(code); } catch (e) { n = code; } return fixes[n] || n; };
})();

// Small island territories / microstates: every settlement there counts as "obscure".
const ISLAND_TERRITORIES = new Set(['PN', 'SH', 'TA', 'TV', 'NR', 'KI', 'MH', 'FM', 'PW', 'CK', 'NU', 'TK', 'WF', 'NF', 'CC', 'CX', 'FK', 'GS',
  'SJ', 'FO', 'TO', 'WS', 'AS', 'VU', 'SB', 'MP', 'GU', 'PF', 'NC', 'IO', 'TF', 'KM', 'ST', 'CV', 'SC', 'MV', 'BM', 'AI', 'MS', 'VG', 'TC', 'PM', 'BL', 'MF']);

// Hand-picked prototype places (from pinpoint.html); always kept in their tier.
const SEEDS = [
  ['Tokyo','Japan',35.6762,139.6503,1],['New York City','United States',40.7128,-74.006,1],['London','United Kingdom',51.5074,-0.1278,1],
  ['Paris','France',48.8566,2.3522,1],['Mumbai','India',19.076,72.8777,1],['São Paulo','Brazil',-23.5505,-46.6333,1],['Cairo','Egypt',30.0444,31.2357,1],
  ['Sydney','Australia',-33.8688,151.2093,1],['Mexico City','Mexico',19.4326,-99.1332,1],['Shanghai','China',31.2304,121.4737,1],
  ['Madrid','Spain',40.4168,-3.7038,2],['Ottawa','Canada',45.4215,-75.6972,2],['Canberra','Australia',-35.2809,149.13,2],['Nairobi','Kenya',-1.2921,36.8219,2],
  ['Buenos Aires','Argentina',-34.6037,-58.3816,2],['Bangkok','Thailand',13.7563,100.5018,2],['Ankara','Türkiye',39.9334,32.8597,2],['Lima','Peru',-12.0464,-77.0428,2],
  ['Oslo','Norway',59.9139,10.7522,2],['Hanoi','Vietnam',21.0278,105.8342,2],
  ['Lyon','France',45.764,4.8357,3],['Chennai','India',13.0827,80.2707,3],['Perth','Australia',-31.9505,115.8605,3],['Denver','United States',39.7392,-104.9903,3],
  ['Casablanca','Morocco',33.5731,-7.5898,3],['Novosibirsk','Russia',55.0084,82.9357,3],['Guadalajara','Mexico',20.6597,-103.3496,3],['Cape Town','South Africa',-33.9249,18.4241,3],
  ['Osaka','Japan',34.6937,135.5023,3],['Manaus','Brazil',-3.119,-60.0217,3],
  ['Ushuaia','Argentina',-54.8019,-68.303,4],['Yellowknife','Canada',62.454,-114.3718,4],['Darwin','Australia',-12.4634,130.8456,4],['Tromsø','Norway',69.6492,18.9553,4],
  ['Timbuktu','Mali',16.7666,-3.0026,4],['Leh','Ladakh, India',34.1526,77.5771,4],['Iquitos','Peru',-3.7437,-73.2516,4],['Yakutsk','Russia',62.0355,129.6755,4],
  ['Nuuk','Greenland',64.1814,-51.6941,4],['Hobart','Tasmania, Australia',-42.8821,147.3272,4],
  ['Edinburgh of the Seven Seas','Tristan da Cunha',-37.0676,-12.3114,5],['Longyearbyen','Svalbard',78.2232,15.6267,5],['Hanga Roa','Easter Island',-27.1497,-109.4282,5],
  ['Adamstown','Pitcairn Islands',-25.0663,-130.1005,5],['Hadibu','Socotra, Yemen',12.651,54.024,5],['Port-aux-Français','Kerguelen Islands',-49.3496,70.2186,5],
  ['Ittoqqortoormiit','Greenland',70.4847,-21.9622,5],['Oymyakon','Yakutia, Russia',63.4641,142.7737,5],['Funafuti','Tuvalu',-8.5243,179.1942,5],['Stanley','Falkland Islands',-51.6977,-57.8517,5]
];

// ----------------------------------------------------------------- geometry
const R = 6371.0088;
const rad = (d) => d * Math.PI / 180;
function km(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Simple 2° grid for nearest-neighbour queries. */
function Grid() { this.cells = new Map(); }
Grid.prototype.key = function (lat, lng) { return Math.floor((lat + 90) / 2) + ':' + Math.floor((((lng + 180) % 360) + 360) % 360 / 2); };
Grid.prototype.add = function (p) { const k = this.key(p.lat, p.lng); if (!this.cells.has(k)) this.cells.set(k, []); this.cells.get(k).push(p); };
/** Distance to the nearest point, searching up to maxKm. */
Grid.prototype.nearest = function (p, maxKm) {
  const ringMax = Math.ceil(maxKm / 111 / 2) + 1;
  const cy = Math.floor((p.lat + 90) / 2), cx = Math.floor((((p.lng + 180) % 360) + 360) % 360 / 2);
  let best = Infinity;
  for (let ring = 0; ring <= ringMax; ring++) {
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dy), Math.abs(dx)) !== ring) continue;
      const y = cy + dy; if (y < 0 || y >= 90) continue;
      const x = ((cx + dx) % 180 + 180) % 180;
      const list = this.cells.get(y + ':' + x); if (!list) continue;
      for (const q of list) { const d = km(p, q); if (d < best) best = d; }
    }
    // Cells shrink towards the poles, so only stop early near the equator band.
    if (best < (ring - 1) * 2 * 111 * Math.cos(rad(Math.min(80, Math.abs(p.lat))))) break;
  }
  return Math.min(best, maxKm);
};

// -------------------------------------------------------------- candidates
const BAD_CODES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH', 'STLMT']);
const all = cities
  .filter((c) => c.population > 0 && !BAD_CODES.has(c.featureCode) && c.loc && Array.isArray(c.loc.coordinates))
  .map((c) => ({
    name: c.name, cc: c.country, code: c.featureCode, pop: c.population,
    lat: Math.round(c.loc.coordinates[1] * 1e4) / 1e4, lng: Math.round(c.loc.coordinates[0] * 1e4) / 1e4
  }))
  .filter((c) => Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180 && c.name && !/\d/.test(c.name));

// Remoteness: distance to the nearest city of 100k+ (excluding itself).
const big = new Grid();
all.filter((c) => c.pop >= 100000).forEach((c) => big.add(c));
function remoteness(c) {
  if (c.pop >= 100000) return 0;
  return big.nearest(c, 4000);
}

// ---------------------------------------------------------------- selection
const chosen = new Grid();          // everything already placed in any tier
const usedNames = new Set();        // "name|cc" to avoid duplicates across tiers
const tiers = [[], [], [], [], []];

function nameKey(name, cc) { return name.toLowerCase() + '|' + (cc || ''); }
function farEnough(c, minKm) { return chosen.nearest(c, minKm) >= minKm; }
function take(tier, c, where) {
  let w = where || countryName(c.cc);
  if (w === c.name) w = '';            // e.g. Hong Kong, Singapore: don't repeat the name
  const entry = { name: c.name.replace(/`/g, '‘'), where: w, lat: c.lat, lng: c.lng, cc: c.cc };
  tiers[tier].push(entry);
  chosen.add(entry);
  usedNames.add(nameKey(c.name, c.cc));
}

// Seeds first, so the hand-picked places keep their tiers.
for (const [name, where, lat, lng, t] of SEEDS) {
  const match = all.find((c) => c.name === name && km(c, { lat, lng }) < 30);
  take(t - 1, { name, cc: match ? match.cc : '', lat, lng }, where);
  if (match) usedNames.add(nameKey(match.name, match.cc));
}

function fill(tier, candidates, { cap, minKm, target = PER_TIER }) {
  const perCountry = new Map();
  tiers[tier].forEach((p) => perCountry.set(p.cc, (perCountry.get(p.cc) || 0) + 1));
  for (const c of candidates) {
    if (tiers[tier].length >= target) break;
    if (usedNames.has(nameKey(c.name, c.cc))) continue;
    if ((perCountry.get(c.cc) || 0) >= cap) continue;
    if (!farEnough(c, minKm)) continue;
    take(tier, c);
    perCountry.set(c.cc, (perCountry.get(c.cc) || 0) + 1);
  }
}

const byPop = (a, b) => b.pop - a.pop;

// 1 · Very easy: biggest cities.
fill(0, all.filter((c) => c.pop >= 500000).sort(byPop), { cap: 32, minKm: 40 });

// 2 · Easy: national capitals (100k+), then first-level admin capitals by size.
fill(1, all.filter((c) => c.code === 'PPLC' && c.pop >= 100000).sort(byPop), { cap: 99, minKm: 25 });
fill(1, all.filter((c) => c.code === 'PPLA' && c.pop >= 50000).sort(byPop), { cap: 22, minKm: 40 });

// 3 · Medium: regional hubs.
fill(2, all.filter((c) => c.pop >= 100000 && c.pop <= 1500000).sort(byPop), { cap: 28, minKm: 40 });

// 4 · Hard: smaller towns away from big cities (bigger and more remote first).
const t4 = all.filter((c) => c.pop >= 20000 && c.pop < 200000)
  .map((c) => Object.assign(c, { remote: remoteness(c) }))
  .filter((c) => c.remote >= 150)
  .sort((a, b) => Math.log(b.pop) * Math.sqrt(b.remote) - Math.log(a.pop) * Math.sqrt(a.remote));
fill(3, t4, { cap: 16, minKm: 90 });

// 5 · Very hard: the most isolated settlements, plus small island territories.
const t5 = all.filter((c) => c.pop < 20000 || ISLAND_TERRITORIES.has(c.cc))
  .map((c) => Object.assign(c, { remote: c.remote != null ? c.remote : remoteness(c) }))
  .map((c) => Object.assign(c, { score: c.remote + (ISLAND_TERRITORIES.has(c.cc) ? 1500 : 0) }))
  .filter((c) => c.score >= 200)
  .sort((a, b) => b.score - a.score);
fill(4, t5, { cap: 18, minKm: 70 });

// ------------------------------------------------------------------ report
tiers.forEach((t, i) => {
  const countries = new Set(t.map((p) => p.cc)).size;
  console.log(`Round ${i + 1}: ${t.length} places, ${countries} countries | e.g. ${t.slice(10, 16).map((p) => p.name + ' (' + p.where + ')').join(', ')}`);
  if (t.length < 500) { console.error(`Round ${i + 1} has fewer than 500 places`); process.exitCode = 1; }
});

// ------------------------------------------------------------------ output
const compact = tiers.map((t) => t.map((p) => [p.name, p.where, p.lat, p.lng]));
const body =
  '/* Generated by scripts/build-pinpoint-places.js. Do not edit by hand.\n' +
  ' * Place data: GeoNames (https://www.geonames.org), CC BY 4.0.\n' +
  ' * Format: rounds[0..4] = [[name, where, lat, lng], ...], easiest to hardest. */\n' +
  'window.PINPOINT_PLACES = ' + JSON.stringify({ source: 'GeoNames cities1000 (CC BY 4.0)', rounds: compact }) + ';\n';
if (!process.exitCode) {
  fs.writeFileSync(OUT, body);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${Math.round(body.length / 1024)} KB)`);
}

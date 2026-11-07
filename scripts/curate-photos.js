#!/usr/bin/env node
/* =============================================================================
 * Curate the photo catalogue: keep photos of PLACES (streets, squares,
 * landscapes, buildings, harbours, stations, events, conferences…) and drop
 * portraits, family snapshots, interiors, objects and low-resolution scans.
 *
 *   node scripts/curate-photos.js            # filter data/photos.json in place, rebuild shards
 *   node scripts/curate-photos.js --dry-run  # report only
 *
 * How it decides
 *   1. Commons metadata for every photo (non-hidden categories + original
 *      size) is fetched once and cached in data/.build-cache/meta.json.
 *   2. classify() applies the rules below to categories + caption.
 *   3. data/curation.json holds manual decisions from looking at the photos
 *      ({ "reject": [ids], "keep": [ids] }). They always win over the rules.
 *   4. No single photographer/collection may exceed MAX_PER_SOURCE photos.
 *   Removed photos go to data/photos-rejected.json with the reason, so any
 *   decision can be reviewed or undone (move the id to "keep").
 *
 * scripts/build-photos.js runs the same curation before writing, so newly
 * harvested photos are filtered too.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const META_FILE = path.join(ROOT, 'data', '.build-cache', 'meta.json');
const MANUAL_FILE = path.join(ROOT, 'data', 'curation.json');
const REJECTED_FILE = path.join(ROOT, 'data', 'photos-rejected.json');
const CATALOGUE = path.join(ROOT, 'data', 'photos.json');

const MIN_LONG_SIDE = 640;   // px; smaller originals are grainy scans (the game never enlarges photos, so 640+ just shows smaller)
const MAX_PER_SOURCE = 250;  // cap per photographer/collection (credit name)

const UA = 'ASnapshotInHistory/1.0 (https://github.com/pablosarkar/a-snapshot-in-history)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ rules
 * Matched against the photo's Commons categories (and, for some, caption).
 * REJECT: the photo is about a person, an object or an indoor space.
 * PLACE: signs the photo shows somewhere recognisable.
 * ---------------------------------------------------------------------- */
const REJECT = [
  [/portrait/i, 'portrait'],
  [/family photographs|\bwith (his |her |their )?family\b|family of /i, 'family photo'],
  [/\bweddings?\b|\bbrides?\b/i, 'wedding'],
  [/fashion|\bdresses\b|\bhats\b|wearing/i, 'fashion / clothing'],
  [/interior|frescos?|ceilings?|\bstained glass\b|altarpiece/i, 'interior'],
  [/sculptures?|statues? photographed|reliefs?\b|busts?\b/i, 'sculpture / object'],
  [/focus stack|macro photographs|close-?ups?/i, 'close-up'],
  [/orthophoto/i, 'orthophoto (map-like aerial)'],
  [/photographs of (men|women|people|children|girls|boys)|black and white photographs of people|\bpeople (sitting|standing|posing)\b|group photographs|selfies?/i, 'people-focused'],
  [/child laborers|\bnudes?\b|\binfants?\b|\bbabies\b/i, 'people-focused'],
  [/Nikola(e|ie)v(na|ich) of Russia|Nicholas II|Alexandra Fyodorovna|Willard D\. Straight/i, 'named person'],
  [/\b(dogs|cats|horses|birds|animals|insects|flowers|plants|food|documents|maps|paintings|drawings|coins|stamps|furniture|toys|dolls|manuscripts|signatures)\b/i, 'object / animal'],
  [/automobile racing|racing cars|\b1000km\b|grand prix/i, 'motorsport close-up'],
  [/\bx-?rays?\b|microscop|scans of/i, 'not a place']
];

const PLACE = /streets?|roads?|\bsquares?\b|plazas?|avenues?|boulevards?|markets?|bridges?|harbou?rs?|\bports?\b|cityscapes?|skylines?|panoram|\bviews? of\b|landscapes?|mountains?|rivers?|lakes?|beach(es)?|coast|villages?|\btowns?\b|downtown|city centre|city center|buildings?|churches|cathedrals?|castles?|towers?|stations?|airports?|aerial|crowds?|parades?|demonstrations?|protests?|marches|events?\b|conferences?|summits?|congress|meetings?|assembl|trams?\b|buses\b|shops|storefronts|houses|architecture|destroyed|ruins|monuments?|palaces?|parks?\b|waterfronts?|canals?|quays?|piers?|lighthouses?|railways?|rail transport|road transport|tram transport|traffic|snow in|night in|winter in|clouds|harbour|ships in|boats in|images of [A-Z]/i;

function classify(photo, meta) {
  const cats = (meta && meta.cats) || [];
  const hay = cats.join(' | ');
  const caption = String(photo.description || '');

  for (const [re, why] of REJECT) {
    if (re.test(hay)) return { keep: false, reason: why };
  }
  const longSide = meta ? Math.max(meta.w || 0, meta.h || 0) : 0;
  if (meta && longSide && longSide < MIN_LONG_SIDE) return { keep: false, reason: `low resolution (${longSide}px)` };
  // Captions that clearly describe a person or posed group rather than a place.
  if (/^(portrait|studio portrait|bildnis|ritratto)\b|\bfamily\b|\bwedding\b|\bposing\b/i.test(caption)) {
    return { keep: false, reason: 'people-focused (caption)' };
  }
  const placeScore = (hay.match(new RegExp(PLACE.source, 'gi')) || []).length +
    (PLACE.test(caption) ? 1 : 0);
  // No place category: could be a street scene with sparse tagging, or an
  // insect close-up. Rejected unless a manual review keeps it.
  if (placeScore === 0) return { keep: false, reason: 'no sign of a place', review: true };
  return { keep: true, reason: '', score: placeScore };
}

/* ------------------------------------------------------------ metadata */
async function api(params) {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let a = 0; a < 10; a++) {
    await sleep(800);
    try {
      const r = await fetch('https://commons.wikimedia.org/w/api.php?' + qs, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (a + 1)); continue; }
      return await r.json();
    } catch (e) { await sleep(3000); }
  }
  throw new Error('Commons API kept failing');
}

/** Fill in Commons categories + size for any photo not in the cache. */
async function ensureMeta(photos) {
  const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf8')) : {};
  const todo = photos.filter((p) => !meta[p.id] && /^c\d+$/.test(p.id)).map((p) => p.id.slice(1));
  if (todo.length) console.log(`Fetching Commons metadata for ${todo.length} photos…`);
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const acc = {};
    let cont = {};
    do {
      const j = await api({ action: 'query', pageids: batch.join('|'), prop: 'categories|imageinfo', clshow: '!hidden', cllimit: 'max', iiprop: 'size', ...cont });
      for (const pg of (j.query && j.query.pages) || []) {
        const m = acc[pg.pageid] || (acc[pg.pageid] = { cats: [], w: 0, h: 0 });
        (pg.categories || []).forEach((c) => m.cats.push(c.title.replace(/^Category:/, '')));
        if (pg.imageinfo && pg.imageinfo[0]) { m.w = pg.imageinfo[0].width; m.h = pg.imageinfo[0].height; }
      }
      cont = j.continue || null;
    } while (cont);
    for (const id of batch) meta['c' + id] = acc[id] || { cats: [], w: 0, h: 0, missing: true };
    fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
    fs.writeFileSync(META_FILE, JSON.stringify(meta));
  }
  return meta;
}

/** Split photos into kept and rejected (with reasons). */
async function curate(photos) {
  const meta = await ensureMeta(photos);
  const manual = fs.existsSync(MANUAL_FILE) ? JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8')) : {};
  const forceReject = new Set(manual.reject || []);
  const forceKeep = new Set(manual.keep || []);

  const kept = [];
  const rejected = [];
  for (const p of photos) {
    if (forceReject.has(p.id)) { rejected.push({ ...p, reason: 'manual review' }); continue; }
    if (forceKeep.has(p.id)) { kept.push({ p, score: 50 }); continue; } // reviewed by eye
    const m = meta[p.id];
    if (m && m.missing) { rejected.push({ ...p, reason: 'deleted from Commons' }); continue; }
    const c = classify(p, m);
    if (c.keep) kept.push({ p, score: c.score });
    else rejected.push({ ...p, reason: c.reason });
  }

  // Cap any one photographer/collection, keeping their most place-like photos.
  const bySource = new Map();
  for (const k of kept) {
    const src = String(k.p.credit || '').split(' · ')[0] || 'unknown';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(k);
  }
  const final = [];
  for (const [src, list] of bySource) {
    list.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
    list.forEach((k, i) => {
      if (i < MAX_PER_SOURCE) final.push(k.p);
      else rejected.push({ ...k.p, reason: `over the ${MAX_PER_SOURCE}-photo cap for ${src}` });
    });
  }
  return { kept: final, rejected };
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  // Re-curate everything, including photos rejected earlier (rules or manual list may have changed).
  const previous = fs.existsSync(REJECTED_FILE) ? JSON.parse(fs.readFileSync(REJECTED_FILE, 'utf8')).photos || [] : [];
  const all = new Map();
  for (const p of previous) { const { reason, ...rest } = p; all.set(p.id, rest); }
  for (const p of catalogue.photos) all.set(p.id, p);

  const { kept, rejected } = await curate([...all.values()]);
  const reasons = {};
  rejected.forEach((r) => { const k = r.reason.replace(/\(\d+px\)/, '').replace(/ for .*/, '').trim(); reasons[k] = (reasons[k] || 0) + 1; });
  console.log(`Kept ${kept.length}, rejected ${rejected.length}`);
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  if (dry) return;

  const { writeOutputs } = require('./build-photos.js');
  const shards = writeOutputs(kept);
  rejected.sort((a, b) => a.actual_year - b.actual_year || a.id.localeCompare(b.id));
  fs.writeFileSync(REJECTED_FILE, JSON.stringify({ count: rejected.length, photos: rejected }) + '\n');
  console.log(`Wrote ${kept.length} photos in ${shards} shards; rejected list in data/photos-rejected.json`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { classify, curate, ensureMeta, REJECT, PLACE };

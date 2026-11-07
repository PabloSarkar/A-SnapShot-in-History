#!/usr/bin/env node
/* =============================================================================
 * Build the photo catalogue from Wikimedia Commons, using the date and place
 * each PHOTO was taken (not when the building in it was built).
 *
 *   node scripts/build-photos.js                    # ~30 photos per year, 1900–2026
 *   node scripts/build-photos.js --per-year 60      # bigger catalogue
 *   node scripts/build-photos.js --from 1940 --to 1960
 *   node scripts/build-photos.js --refresh          # ignore the per-year cache
 *   node scripts/build-photos.js --verify           # also fetch every image to check it loads (slow)
 *
 * Where the photos come from
 *   For each year Y, Commons search finds files in the "Y photographs"
 *   category tree (deepcat:) that carry a {{Location}} / {{Object location}}
 *   template, i.e. have coordinates. For each file the Commons API returns:
 *     - coordinates           (prop=coordinates; camera location if present)
 *     - DateTimeOriginal      (EXIF / {{Information}} date)
 *     - title, description, photographer, licence (extmetadata)
 *     - a direct image URL at 1280 px (a width Wikimedia actually serves)
 *   A photo is kept only if its own date is precise to the year (not "1950s"
 *   or "circa 1950") and agrees with Y. If it has no date field, the
 *   category year is used.
 *
 * Output
 *   data/photos.json             the master catalogue (also used for merging)
 *   data/photos/manifest.js      { count, shards } loaded by the game
 *   data/photos/shard-NNN.js     200 photos each, mixed years; the game loads
 *                                a couple per match instead of everything.
 *   Shards are plain scripts (not JSON) so the game also works when
 *   index.html is opened from disk (file://), where fetch() is blocked.
 *
 * Re-running merges new photos into data/photos.json. Each finished year is
 * cached in data/.build-cache/ (git-ignored), so an interrupted run resumes
 * where it stopped.
 *
 * Needs Node 18+. Behind an HTTPS proxy: NODE_USE_ENV_PROXY=1 (Node 22.21+).
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------- options
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
}
const PER_YEAR = Math.max(1, parseInt(opt('per-year', '30'), 10));
const FROM = parseInt(opt('from', '1900'), 10);
const TO = parseInt(opt('to', '2026'), 10);
const REFRESH = argv.includes('--refresh');
const VERIFY = argv.includes('--verify');
const SHARD_SIZE = 200;
const THUMB_WIDTH = 1280;          // Wikimedia only serves 250/330/500/960/1280/1920
const MIN_WIDTH = 500;             // skip tiny scans
const CANDIDATES_PER_YEAR = PER_YEAR * 3;
const MAX_PAGES_PER_QUERY = 8;     // 50 files per page

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'data', 'photos.json');
const OUT_DIR = path.join(ROOT, 'data', 'photos');
const CACHE_DIR = path.join(ROOT, 'data', '.build-cache');

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'ASnapshotInHistory/1.0 (https://github.com/pablosarkar/a-snapshot-in-history)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- HTTP
let lastRequest = 0;
async function commons(params) {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let attempt = 0; attempt < 8; attempt++) {
    const gap = 1000 - (Date.now() - lastRequest); // ~1 request/second
    if (gap > 0) await sleep(gap);
    lastRequest = Date.now();
    try {
      const res = await fetch(API + '?' + qs, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(60000, 5000 * (attempt + 1));
        process.stdout.write(`    (HTTP ${res.status}, waiting ${wait / 1000}s)\n`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.error.code + ': ' + json.error.info);
      return json;
    } catch (e) {
      if (attempt >= 7) throw e;
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error('Commons API kept failing');
}

// ----------------------------------------------------------------- parsing
function stripHtml(s) {
  return String(s || '')
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, ' ') // hidden QS markers
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Year the photo was taken, from DateTimeOriginal.
 *   returns a number     -> a year-precise date
 *   returns null         -> no usable date field (caller falls back to category year)
 *   returns 'imprecise'  -> decade/century/circa/range: reject the photo
 */
function photoYear(raw) {
  if (!raw) return null;
  const s = String(raw);
  // Commons embeds a machine-readable marker: "date QS:P571,+1950-00-00T00:00:00Z/9"
  // where the trailing number is the precision (9 = year, 10 = month, 11 = day).
  const qs = /QS:P\d+,\+(\d{4})-\d\d-\d\dT[\d:]+Z\/(\d+)/.exec(s);
  if (qs) return parseInt(qs[2], 10) >= 9 ? parseInt(qs[1], 10) : 'imprecise';
  const text = stripHtml(s);
  if (/\b(1[89]|20)\d0s\b|\bcirca\b|\bca?\.\s*\d|\bc\.\s*\d|\bbetween\b|\bbefore\b|\bafter\b|\?/i.test(text)) return 'imprecise';
  const years = text.match(/\b(18|19|20)\d\d\b/g);
  if (!years) return null;
  const unique = [...new Set(years)];
  return unique.length === 1 ? parseInt(unique[0], 10) : 'imprecise'; // "1950–1952" etc.
}

/** Strip archive shelfmarks, ids and other noise from a caption. */
function cleanCaption(s) {
  return String(s || '')
    .replace(/[​-‏﻿]/g, '')                       // zero-width chars
    .replace(/\s*-\s*geograph\.org\.uk\s*-\s*\d+$/i, '')         // "… - geograph.org.uk - 2183759"
    .replace(/\s*geograph-\d+-by-[\w-]+$/i, '')                  // "… geograph-2423641-by-Ben-Brooksbank"
    .replace(/\s*\(\d{6,}\)\s*$/, '')                            // flickr ids
    .replace(/^Fotothek\s+df\s+[\w-]+\s+\d+\s+\d+\s*/i, '')      // Deutsche Fotothek shelfmarks
    .replace(/^(Bundesarchiv\s+)?(Bild|B)\s+[\w-]+,\s*/i, '')    // Bundesarchiv codes
    .replace(/^\d{2}-\d{2}-\d{4}\s+\d{4,6}\s+/, '')              // IISG "01-12-1950 07064 "
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Human-readable caption from the Commons title / description. */
function caption(objectName, imageDescription, title) {
  let s = cleanCaption(stripHtml(objectName) || title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''));
  if (s.replace(/[^a-z]/gi, '').length < 8) {
    const d = stripHtml(imageDescription);
    if (d) s = d;
  }
  if (s.length > 200) s = s.slice(0, 197).replace(/\s+\S*$/, '') + '…';
  return s;
}

function credit(artist, license) {
  let a = stripHtml(artist).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  a = a.replace(/^(.+?)\s+\1$/, '$1'); // "Unknown author Unknown author"
  if (a.length > 80) a = a.slice(0, 77) + '…';
  const l = stripHtml(license);
  return [a || 'Unknown photographer', l].filter(Boolean).join(' · ');
}

/** One Commons page object -> a game photo, or null. */
function toPhoto(page, categoryYear) {
  const info = page.imageinfo && page.imageinfo[0];
  if (!info) return null;
  if (!/^image\/(jpeg|png)$/.test(info.mime)) return null;          // no SVG/TIFF/GIF/video
  if (!(info.width >= MIN_WIDTH && info.height >= 300)) return null;

  const coords = (page.coordinates || []).filter((c) => (c.globe || 'earth') === 'earth');
  const c = coords.find((x) => x.primary) || coords[0];
  if (!c || !isFinite(c.lat) || !isFinite(c.lon) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180) return null;
  if (c.lat === 0 && c.lon === 0) return null;                       // placeholder coords

  const em = info.extmetadata || {};
  const y = photoYear(em.DateTimeOriginal && em.DateTimeOriginal.value);
  if (y === 'imprecise') return null;
  if (y !== null && y !== categoryYear) return null;                 // date and category disagree
  const year = y === null ? categoryYear : y;

  const desc = caption(em.ObjectName && em.ObjectName.value, em.ImageDescription && em.ImageDescription.value, page.title);
  if (!desc) return null;

  const url = String(info.thumburl || info.url || '').split('?')[0];
  if (!/^https:\/\/(thumb|upload)\.wikimedia\.org\//.test(url)) return null;

  return {
    id: 'c' + page.pageid,
    image_url: url,
    lat: Math.round(c.lat * 1e5) / 1e5,
    lng: Math.round(c.lon * 1e5) / 1e5,
    actual_year: year,
    description: desc,
    credit: credit(em.Artist && em.Artist.value, em.LicenseShortName && em.LicenseShortName.value),
    source_url: info.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(page.title))
  };
}

// --------------------------------------------------------------- harvest
async function harvestYear(year) {
  const queries = [
    `deepcat:"${year} photographs" hastemplate:"Location"`,
    `deepcat:"${year} photographs" hastemplate:"Object location"`,
    `deepcat:"${year} photographs by country" hastemplate:"Location"`,
    `deepcat:"${year} black and white photographs" hastemplate:"Location"`
  ];
  const found = new Map();
  for (const q of queries) {
    let cont = {};
    for (let pageNo = 0; pageNo < MAX_PAGES_PER_QUERY && found.size < CANDIDATES_PER_YEAR; pageNo++) {
      let json;
      try {
        json = await commons({
          action: 'query',
          generator: 'search',
          gsrnamespace: '6',
          gsrsearch: q,
          gsrlimit: '50',
          prop: 'imageinfo|coordinates',
          iiprop: 'url|mime|size|extmetadata',
          iiurlwidth: String(THUMB_WIDTH),
          iiextmetadatafilter: 'DateTimeOriginal|ObjectName|ImageDescription|Artist|LicenseShortName',
          iiextmetadatalanguage: 'en',
          coprimary: 'all',
          colimit: 'max',
          ...cont
        });
      } catch (e) {
        console.warn(`    ${q}: ${e.message}`);
        break;
      }
      const pages = (json.query && json.query.pages) || [];
      for (const p of pages) {
        if (found.has(p.pageid)) continue;
        const photo = toPhoto(p, year);
        if (photo) found.set(p.pageid, photo);
      }
      if (!json.continue) break;
      cont = json.continue;
    }
    if (found.size >= CANDIDATES_PER_YEAR) break;
  }
  return [...found.values()];
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pick `n` photos, capping any one photographer/collection so a single archive can't dominate a year. */
function pick(candidates, n) {
  const cap = Math.max(2, Math.ceil(n / 4));
  const perSource = new Map();
  const out = [];
  for (const p of shuffle(candidates.slice())) {
    const key = p.credit.split(' · ')[0];
    const k = perSource.get(key) || 0;
    if (k >= cap) continue;
    perSource.set(key, k + 1);
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

async function imageLoads(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-1023' } });
      if (res.status === 429) { await sleep(4000 * (attempt + 1)); continue; }
      const type = res.headers.get('content-type') || '';
      if (res.body) await res.body.cancel().catch(() => {});
      return (res.ok || res.status === 206) && /^image\/(jpeg|png)/.test(type);
    } catch (e) { await sleep(1000); }
  }
  return false;
}

// ------------------------------------------------------------------ output
function writeOutputs(photos) {
  photos.forEach((p) => {
    p.description = cleanCaption(p.description) || p.description;
    p.credit = String(p.credit || '').replace(/^(.+?)\s+\1(?= · |$)/, '$1');
  });
  photos.sort((a, b) => a.actual_year - b.actual_year || a.id.localeCompare(b.id));
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Wikimedia Commons. Each photo has its own licence: see credit and source_url.',
    count: photos.length,
    photos
  }) + '\n');

  // Shards: ordered by a hash of each id, so years and places are mixed in
  // every shard, but an unchanged catalogue always produces identical files.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hash = (id) => require('crypto').createHash('sha1').update(String(id)).digest('hex');
  const mixed = photos.slice().sort((a, b) => (hash(a.id) < hash(b.id) ? -1 : 1));
  const shards = Math.max(1, Math.ceil(mixed.length / SHARD_SIZE));
  for (let i = 0; i < shards; i++) {
    const chunk = mixed.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
    const name = 'shard-' + String(i).padStart(3, '0') + '.js';
    fs.writeFileSync(path.join(OUT_DIR, name),
      '/* Generated by scripts/build-photos.js. Do not edit by hand. */\n' +
      '(window.SNAPSHOT_SHARDS = window.SNAPSHOT_SHARDS || {})[' + i + '] = ' + JSON.stringify(chunk) + ';\n');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.js'),
    '/* Generated by scripts/build-photos.js. Do not edit by hand. */\n' +
    'window.SNAPSHOT_MANIFEST = ' + JSON.stringify({
      generated: new Date().toISOString(),
      count: photos.length,
      shards,
      path: './data/photos/shard-{n}.js'
    }) + ';\n');
  return shards;
}

// -------------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Start from the existing catalogue (only photo-dated Commons entries).
  const all = new Map();
  if (fs.existsSync(OUT_JSON)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
      (prev.photos || []).filter((p) => p.credit && /^c\d+$/.test(p.id)).forEach((p) => all.set(p.id, p));
      console.log(`Existing catalogue: ${all.size} photos`);
    } catch (e) { console.warn('Existing photos.json unreadable; starting fresh.'); }
  }
  // Photos removed by curation (scripts/curate-photos.js) stay removed.
  const REJECTED = path.join(ROOT, 'data', 'photos-rejected.json');
  const rejectedIds = new Set(fs.existsSync(REJECTED)
    ? (JSON.parse(fs.readFileSync(REJECTED, 'utf8')).photos || []).map((p) => p.id) : []);

  for (let year = FROM; year <= TO; year++) {
    const cacheFile = path.join(CACHE_DIR, year + '.json');
    let chosen;
    if (!REFRESH && fs.existsSync(cacheFile)) {
      chosen = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } else {
      const t = Date.now();
      const candidates = await harvestYear(year);
      chosen = pick(candidates, PER_YEAR);
      if (VERIFY) {
        const ok = [];
        for (const p of chosen) if (await imageLoads(p.image_url)) ok.push(p);
        chosen = ok;
      }
      fs.writeFileSync(cacheFile, JSON.stringify(chosen));
      console.log(`${year}: ${chosen.length} photos (from ${candidates.length} candidates, ${((Date.now() - t) / 1000).toFixed(0)}s)`);
    }
    chosen.forEach((p) => { if (!rejectedIds.has(p.id)) all.set(p.id, p); });
    // Write as we go so a long run always leaves a usable catalogue behind.
    if ((year - FROM) % 10 === 9 || year === TO) {
      const shards = writeOutputs([...all.values()]);
      console.log(`  -> catalogue now ${all.size} photos in ${shards} shards`);
    }
  }
  // Filter the new photos the same way the existing ones were curated.
  console.log('Curating (removing portraits, close-ups, interiors…)');
  const { curate } = require('./curate-photos.js');
  const { kept, rejected } = await curate([...all.values()]);
  writeOutputs(kept);
  const prevRejected = fs.existsSync(REJECTED) ? JSON.parse(fs.readFileSync(REJECTED, 'utf8')).photos || [] : [];
  const byId = new Map(prevRejected.map((p) => [p.id, p]));
  rejected.forEach((p) => byId.set(p.id, p));
  fs.writeFileSync(REJECTED, JSON.stringify({ count: byId.size, photos: [...byId.values()] }) + '\n');
  console.log(`Kept ${kept.length} photos, ${rejected.length} rejected this run.`);
  console.log('Tip: new photos the rules can\'t judge are rejected as "no sign of a place";');
  console.log('add their ids to "keep" in data/curation.json to bring them back.');
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { photoYear, caption, cleanCaption, credit, toPhoto, stripHtml, writeOutputs };

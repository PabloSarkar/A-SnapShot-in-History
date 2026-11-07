/* =============================================================================
 * A Snapshot in History — Wikidata + Wikimedia Commons round fetcher
 * -----------------------------------------------------------------------------
 * Finds real, geolocated, dated photographs of recognisable places and returns
 * them in the game's round format:
 *
 *   {
 *     id:          "Q243",                       // Wikidata QID
 *     image_url:   "https://thumb.wikimedia.org/wikipedia/commons/thumb/…/1280px-….jpg",
 *     lat:         48.8584,
 *     lng:         2.2945,
 *     actual_year: 1889,
 *     description: "Eiffel Tower — tower in Paris, France",
 *     source_url:  "https://commons.wikimedia.org/wiki/File:….jpg"   // optional extra: for photo credit
 *   }
 *
 * How it works
 *   1. Wikidata Query Service (SPARQL)  https://query.wikidata.org/sparql
 *      Finds items with coordinates (P625), an image (P18) and a year-precise
 *      inception (P571) or point in time (P585), restricted to place-like
 *      classes (buildings, monuments, bridges, squares…).
 *   2. Wikimedia Commons API            https://commons.wikimedia.org/w/api.php
 *      Resolves each P18 file name to a direct upload.wikimedia.org URL, sized
 *      down to a sensible thumbnail, and confirms the real MIME type is JPEG
 *      or PNG. If Commons is unreachable, the module falls back to Commons'
 *      Special:FilePath redirect URL, which still works as an <img src>.
 *
 * Runs in:
 *   - the browser: <script src="./js/wikidata-rounds.js"></script>
 *       -> window.WikidataRounds.fetchHistoricalRounds(10)
 *   - Node 18+ or a serverless function (anything with global fetch):
 *       const { fetchHistoricalRounds } = require('./js/wikidata-rounds.js');
 *
 * Both APIs allow anonymous cross-origin GET requests, so no key and no
 * backend are needed.
 *
 * GAME-PLAY CAVEAT: the year is the inception/creation date of the *place*
 * (when the bridge was built), not necessarily the date the photo was taken.
 * Recent photos of old buildings are common. Keeping maxYear low and leaning on
 * classes that change quickly (events, street scenes) helps. See the notes on
 * `classes` below.
 * ========================================================================== */
(function (root) {
  'use strict';

  var SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
  var COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
  var FILEPATH_PREFIX = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

  /* ---------------------------------------------------------------------------
   * Classes of things to look for (matched with wdt:P31, i.e. "instance of").
   *
   * These are direct instance-of matches. Matching subclasses as well
   * (wdt:P31/wdt:P279*) catches far more items but often hits the query
   * service's 60-second timeout. If you need it, use it with a single,
   * narrow class only.
   *
   * Each class is queried separately (several in parallel): one query with
   * every class in a VALUES list took ~48 s or timed out, while single-class
   * queries took 2–12 s when measured. Some classes are much slower: church
   * building (Q16970) took ~45 s and street (Q79007) timed out, so they are
   * left out. For live use, keep this list to fast classes.
   *
   * Pass your own list with options.classes to change what appears, e.g.
   *   classes: ['Q16970']          // church buildings only
   *   classes: ['Q12280','Q12518'] // bridges and towers
   * ------------------------------------------------------------------------- */
  var DEFAULT_CLASSES = [
    'Q35112127', // historic building
    'Q4989906',  // monument
    'Q41176',    // building (broad)
    'Q12280',    // bridge
    'Q12518',    // tower
    'Q483110',   // stadium
    'Q174782',   // square (town square / plaza)
    'Q33506',    // museum (the building, not the artefacts)
    'Q1081138'   // historic site
  ];

  var DEFAULTS = {
    minYear: 1900,          // inclusive. For 1900–1980 pass { minYear: 1900, maxYear: 1980 }.
    maxYear: 2026,          // inclusive. Must stay within the game slider (1900–2026).
    classes: DEFAULT_CLASSES,
    country: null,          // Wikidata QID for a country, e.g. 'Q142' (France), 'Q17' (Japan)
    bbox: null,             // { south, west, north, east } in decimal degrees
    thumbWidth: 1280,       // image width requested from Commons; snapped to a width Wikimedia serves (see STANDARD_WIDTHS)
    parallelClasses: 3,     // how many classes (picked at random) to query at once, one query each
    poolFactor: 4,          // rows fetched per class = limit × poolFactor; rounds are sampled from them
    maxRandomOffset: 400,   // randomise which slice of each class is returned (0 = always the same)
    timeoutMs: 25000,       // timeout for each network request
    language: 'en',
    userAgent: 'ASnapshotInHistory/1.0 (https://github.com/pablosarkar/a-snapshot-in-history)',
    signal: null,           // optional AbortSignal to cancel the whole fetch
    fetch: null             // optional fetch implementation (tests / older runtimes)
  };

  // Only these file types are passed to the game. SVG, TIFF, GIF, WebP, PDF,
  // DjVu, audio and video are all dropped.
  var ALLOWED_EXT = /\.(jpe?g|png)$/i;
  var ALLOWED_MIME = { 'image/jpeg': true, 'image/png': true };

  // Wikimedia only generates thumbnails at these widths; other widths (e.g.
  // 1600) return HTTP 400.
  var STANDARD_WIDTHS = [250, 330, 500, 960, 1280, 1920];
  function snapWidth(w) {
    w = Number(w) || 1280;
    for (var i = 0; i < STANDARD_WIDTHS.length; i++) if (STANDARD_WIDTHS[i] >= w) return STANDARD_WIDTHS[i];
    return STANDARD_WIDTHS[STANDARD_WIDTHS.length - 1];
  }

  var IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

  /* ===========================================================================
   * 1. SPARQL query
   * ======================================================================== */

  function isQid(s) { return /^Q\d+$/.test(String(s)); }

  function num(v, name) {
    var n = Number(v);
    if (!isFinite(n)) throw new Error('wikidata-rounds: ' + name + ' must be a number');
    return n;
  }

  /**
   * Build the SPARQL query string.
   * @param {object} opts  merged options (see DEFAULTS)
   * @param {number} rows  LIMIT
   * @param {number} offset OFFSET
   */
  function buildQuery(opts, rows, offset) {
    var classes = (opts.classes || []).filter(isQid);
    if (!classes.length) throw new Error('wikidata-rounds: options.classes needs at least one QID');
    var minYear = Math.round(num(opts.minYear, 'minYear'));
    var maxYear = Math.round(num(opts.maxYear, 'maxYear'));
    var lang = /^[a-z-]{2,12}$/i.test(opts.language) ? opts.language : 'en';

    /* ---- Geographic filter --------------------------------------------------
     * Option A: country (P17). Cheap, and the most reliable way to target a region.
     *   e.g. country: 'Q30' (USA), 'Q183' (Germany), 'Q145' (UK), 'Q17' (Japan)
     * Option B: bounding box. Uses the query service's geo box search, so only
     *   items inside the box are scanned. cornerWest is the south-west corner
     *   and cornerEast the north-east corner, both as Point(lng lat).
     *   e.g. Western Europe: { south: 36, west: -10, north: 60, east: 20 }
     * ---------------------------------------------------------------------- */
    var coordPattern;
    if (opts.bbox) {
      var b = opts.bbox;
      var sw = 'Point(' + num(b.west, 'bbox.west') + ' ' + num(b.south, 'bbox.south') + ')';
      var ne = 'Point(' + num(b.east, 'bbox.east') + ' ' + num(b.north, 'bbox.north') + ')';
      coordPattern =
        '  SERVICE wikibase:box {\n' +
        '    ?item wdt:P625 ?coord .\n' +
        '    bd:serviceParam wikibase:cornerWest "' + sw + '"^^geo:wktLiteral .\n' +
        '    bd:serviceParam wikibase:cornerEast "' + ne + '"^^geo:wktLiteral .\n' +
        '  }\n';
    } else {
      coordPattern = '  ?item wdt:P625 ?coord .\n';
    }
    var countryPattern = opts.country && isQid(opts.country)
      ? '  ?item wdt:P17 wd:' + opts.country + ' .\n'
      : '';

    return [
      'SELECT ?item ?itemLabel ?itemDescription ?image ?coord ?year WHERE {',
      // Place-like things only, so we get recognisable locations rather than
      // paintings or museum objects.
      '  VALUES ?class { ' + classes.map(function (q) { return 'wd:' + q; }).join(' ') + ' }',
      '  ?item wdt:P31 ?class .',
      coordPattern +                    // P625 coordinate location (+ optional bbox)
      countryPattern +                  // optional P17 country
      '  ?item wdt:P18 ?image .',       // P18 image (JPEG/PNG is checked in JS; a REGEX here slows the query down)
      // Date: inception (P571) OR point in time (P585). We go through the full
      // statement (p:/psv:) to read the date's *precision* and keep only values
      // precise to the year or better (9 = year, 10 = month, 11 = day). Without
      // this, "20th century" (precision 7) reads as 1901 and skews the answer.
      '  {',
      '    ?item p:P571/psv:P571 ?dateNode .',
      '  } UNION {',
      '    ?item p:P585/psv:P585 ?dateNode .',
      '  }',
      '  ?dateNode wikibase:timeValue ?date ;',
      '            wikibase:timePrecision ?precision .',
      '  FILTER(?precision >= 9)',
      // Year as a plain integer.
      '  BIND(YEAR(?date) AS ?year)',
      /* ---- Choosing an era ------------------------------------------------
       * This range decides which century the game draws from. Set it with
       * options.minYear / options.maxYear, e.g.
       *   1900–1980  -> { minYear: 1900, maxYear: 1980 }
       *   1950s only -> { minYear: 1950, maxYear: 1959 }
       * Keep it within 1900–2026 to match the game's year slider.
       * ------------------------------------------------------------------ */
      '  FILTER(?year >= ' + minYear + ' && ?year <= ' + maxYear + ')',
      '  SERVICE wikibase:label { bd:serviceParam wikibase:language "' + lang + '". }',
      '}',
      'LIMIT ' + Math.max(1, Math.round(rows)),
      offset > 0 ? 'OFFSET ' + Math.round(offset) : ''
    ].join('\n').trim();
  }

  /* ===========================================================================
   * 2. Parsing
   * ======================================================================== */

  /**
   * "Point(2.2945 48.8584)" -> { lat: 48.8584, lng: 2.2945 }  (WKT is lng first)
   * Returns null for anything else, including coordinates on other bodies,
   * which WDQS writes as "<http://www.wikidata.org/entity/Q405> Point(…)".
   */
  function parsePoint(wkt) {
    if (typeof wkt !== 'string' || wkt.charAt(0) === '<') return null;
    var m = /^\s*Point\(\s*([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*\)\s*$/.exec(wkt);
    if (!m) return null;
    var lng = parseFloat(m[1]);
    var lat = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: lat, lng: lng };
  }

  /** Parse a year from the ?year binding; null if unusable. */
  function parseYear(binding) {
    if (!binding || binding.value == null) return null;
    var s = String(binding.value).trim();
    if (!/^-?\d{1,4}$/.test(s)) return null;  // rejects "", "1.9e3", "t123…" etc.
    var y = parseInt(s, 10);
    return isFinite(y) ? y : null;
  }

  /**
   * P18 values arrive as
   *   http://commons.wikimedia.org/wiki/Special:FilePath/Some%20File.jpg
   * -> "Some File.jpg"  (decoded, spaces not underscores)
   */
  function fileNameFromP18(url) {
    if (typeof url !== 'string') return null;
    var i = url.indexOf('Special:FilePath/');
    if (i === -1) return null;
    var raw = url.slice(i + 'Special:FilePath/'.length).split(/[?#]/)[0];
    try { raw = decodeURIComponent(raw); } catch (e) { /* keep raw */ }
    raw = raw.replace(/_/g, ' ').trim();
    return raw || null;
  }

  function hasAllowedExtension(fileName) {
    return typeof fileName === 'string' && ALLOWED_EXT.test(fileName);
  }

  /** Special:FilePath URL with a width hint; redirects to the actual image. */
  function filePathUrl(fileName, width) {
    return FILEPATH_PREFIX + encodeURIComponent(fileName.replace(/ /g, '_')) +
      (width ? '?width=' + snapWidth(width) : '');
  }

  function commonsPageUrl(fileName) {
    return 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(fileName.replace(/ /g, '_'));
  }

  /** Build the human-readable reveal text from the label and description. */
  function buildDescription(label, desc, qid) {
    label = label && label !== qid ? label.trim() : '';
    desc = desc ? desc.trim() : '';
    if (label && desc) return label + ' — ' + desc;
    return label || desc || '';
  }

  /**
   * Turn SPARQL JSON bindings into round candidates. One item can come back on
   * several rows (several images, coordinates or dates); the first usable row
   * per QID wins. Anything malformed is skipped, never thrown.
   */
  function parseBindings(json, opts) {
    opts = opts || DEFAULTS;
    var rows = json && json.results && Array.isArray(json.results.bindings) ? json.results.bindings : [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      try {
        var qid = r.item && String(r.item.value).split('/').pop();
        if (!isQid(qid) || seen[qid]) continue;

        var point = parsePoint(r.coord && r.coord.value);
        if (!point) continue;

        var year = parseYear(r.year);
        if (year === null || year < opts.minYear || year > opts.maxYear) continue;

        var fileName = fileNameFromP18(r.image && r.image.value);
        if (!hasAllowedExtension(fileName)) continue;

        var description = buildDescription(
          r.itemLabel && r.itemLabel.value,
          r.itemDescription && r.itemDescription.value,
          qid
        );
        if (!description) continue; // no English text to show on the reveal

        seen[qid] = true;
        out.push({
          id: qid,
          fileName: fileName,
          lat: point.lat,
          lng: point.lng,
          actual_year: year,
          description: description
        });
      } catch (e) {
        // One bad row must not break the batch.
      }
    }
    return out;
  }

  /* ===========================================================================
   * 3. Network
   * ======================================================================== */

  function getFetch(opts) {
    var f = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('wikidata-rounds: no fetch() available (Node 18+ or a browser is required)');
    return f;
  }

  /** fetch + timeout + optional outer AbortSignal, returning parsed JSON. */
  function fetchJson(url, init, opts) {
    var f = getFetch(opts);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var onOuterAbort = null;
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        onOuterAbort = function () { controller.abort(); };
        opts.signal.addEventListener('abort', onOuterAbort);
      }
      init.signal = controller.signal;
    }
    return Promise.resolve(f(url, init))
      .then(function (res) {
        if (!res.ok) {
          var err = new Error('HTTP ' + res.status + ' from ' + url.split('?')[0]);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
        if (onOuterAbort) opts.signal.removeEventListener('abort', onOuterAbort);
      });
  }

  /**
   * Headers. Browsers do not allow setting User-Agent, and a custom
   * Api-User-Agent header would trigger a CORS preflight, so the
   * identifying header is only sent outside the browser, where the
   * Wikimedia User-Agent policy expects one.
   */
  function headers(accept, opts) {
    var h = { Accept: accept };
    if (!IS_BROWSER && opts.userAgent) h['User-Agent'] = opts.userAgent;
    return h;
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** fetchJson with retries on 429 (rate limited) and 5xx, with backoff. */
  function fetchJsonRetry(url, init, opts, retries) {
    return fetchJson(url, init, opts).catch(function (err) {
      var retryable = err && (err.status === 429 || err.status >= 500);
      if (!retryable || retries <= 0 || (opts.signal && opts.signal.aborted)) throw err;
      return wait(err.status === 429 ? 2500 : 1000).then(function () {
        return fetchJsonRetry(url, init, opts, retries - 1);
      });
    });
  }

  function runSparql(query, opts) {
    var url = SPARQL_ENDPOINT + '?format=json&query=' + encodeURIComponent(query);
    return fetchJsonRetry(url, { method: 'GET', headers: headers('application/sparql-results+json', opts) }, opts, 1);
  }

  /**
   * Ask Commons for direct, resized URLs and the real MIME type of up to 50
   * files per request. Returns { "File name.jpg": { url, mime, page } }.
   */
  function resolveCommonsFiles(fileNames, opts) {
    var batches = [];
    for (var i = 0; i < fileNames.length; i += 50) batches.push(fileNames.slice(i, i + 50));

    return Promise.all(batches.map(function (batch) {
      var params = [
        'action=query',
        'format=json',
        'formatversion=2',
        'origin=*',                       // anonymous CORS
        'redirects=1',
        'prop=imageinfo',
        'iiprop=url%7Cmime%7Csize',
        'iiurlwidth=' + snapWidth(opts.thumbWidth),
        'titles=' + encodeURIComponent(batch.map(function (n) { return 'File:' + n; }).join('|'))
      ].join('&');
      return fetchJsonRetry(COMMONS_API + '?' + params, { method: 'GET', headers: headers('application/json', opts) }, opts, 2);
    })).then(function (responses) {
      var out = Object.create(null);
      responses.forEach(function (json) {
        var q = (json && json.query) || {};
        // Map the titles we sent to the titles Commons answers with.
        var alias = Object.create(null);
        (q.normalized || []).concat(q.redirects || []).forEach(function (n) { alias[n.from] = n.to; });
        var byTitle = Object.create(null);
        (q.pages || []).forEach(function (p) { if (p && p.title) byTitle[p.title] = p; });

        fileNames.forEach(function (name) {
          var title = 'File:' + name;
          var t = title;
          for (var hops = 0; alias[t] && hops < 3; hops++) t = alias[t];
          var page = byTitle[t];
          if (!page || page.missing || !page.imageinfo || !page.imageinfo[0]) return;
          var info = page.imageinfo[0];
          out[name] = {
            // thumburl is the resized copy; fall back to the original for small files.
            // Strip Commons' tracking parameters (?utm_source=…).
            url: String(info.thumburl || info.url).split('?')[0],
            mime: info.mime,
            page: info.descriptionurl || commonsPageUrl(name)
          };
        });
      });
      return out;
    });
  }

  /* ===========================================================================
   * 4. Public API
   * ======================================================================== */

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function mergeOptions(options) {
    var o = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    if (options) for (k in options) if (options[k] !== undefined) o[k] = options[k];
    return o;
  }

  /**
   * Fetch `limit` random rounds.
   *
   * @param {number} [limit=10]
   * @param {object} [options]  see DEFAULTS above; for example:
   *   fetchHistoricalRounds(5, { minYear: 1900, maxYear: 1980 })
   *   fetchHistoricalRounds(5, { country: 'Q17' })                          // Japan
   *   fetchHistoricalRounds(5, { bbox: { south: 36, west: -10, north: 60, east: 20 } })
   *   fetchHistoricalRounds(5, { classes: ['Q12280'] })                     // bridges
   * @returns {Promise<Array<{id,image_url,lat,lng,actual_year,description,source_url}>>}
   *   May hold fewer than `limit` items if the filters are very narrow.
   *   Rejects only if the SPARQL request itself fails; a Commons failure falls
   *   back to Special:FilePath URLs.
   */
  function fetchHistoricalRounds(limit, options) {
    limit = Math.max(1, Math.round(limit == null ? 10 : limit));
    var opts = mergeOptions(options);
    if (opts.minYear > opts.maxYear) {
      return Promise.reject(new Error('wikidata-rounds: minYear is after maxYear'));
    }

    var classes = (opts.classes || []).filter(isQid);
    if (!classes.length) return Promise.reject(new Error('wikidata-rounds: options.classes needs at least one QID'));

    // One query per class, for a few randomly chosen classes, in parallel.
    // Each pulls a bigger pool than needed from a random point in that class's
    // results so each match isn't the same handful of buildings.
    var chosen = shuffle(classes.slice()).slice(0, Math.max(1, opts.parallelClasses || 1));
    var perClass = Math.max(limit, Math.ceil((limit * Math.max(1, opts.poolFactor)) / chosen.length));

    function queryClass(cls) {
      var one = mergeOptions(opts);
      one.classes = [cls];
      var offset = opts.maxRandomOffset > 0 ? Math.floor(Math.random() * opts.maxRandomOffset) : 0;
      function run(off) {
        return runSparql(buildQuery(one, perClass, off), one).then(function (json) {
          return parseBindings(json, one);
        });
      }
      return run(offset).then(function (items) {
        // A small class can have fewer results than the random offset; retry from the start.
        return items.length < limit && offset > 0 ? run(0) : items;
      });
    }

    // A slow or failed class doesn't sink the batch; only reject if all fail.
    return Promise.all(chosen.map(function (cls) {
      return queryClass(cls).then(
        function (items) { return { ok: true, items: items }; },
        function (err) { return { ok: false, err: err }; }
      );
    }))
      .then(function (results) {
        var ok = results.filter(function (r) { return r.ok; });
        if (!ok.length) throw results[0].err;
        var seen = Object.create(null);
        var merged = [];
        ok.forEach(function (r) {
          r.items.forEach(function (it) { if (!seen[it.id]) { seen[it.id] = true; merged.push(it); } });
        });
        return merged;
      })
      .then(function (items) {
        var picked = shuffle(items).slice(0, limit);
        if (!picked.length) return [];

        return resolveCommonsFiles(picked.map(function (p) { return p.fileName; }), opts)
          .catch(function (err) {
            // Commons unavailable: still playable via Special:FilePath redirects.
            if (typeof console !== 'undefined') console.warn('wikidata-rounds: Commons lookup failed, using FilePath URLs.', err);
            return null;
          })
          .then(function (resolved) {
            return picked.map(function (p) {
              var info = resolved && resolved[p.fileName];
              if (resolved && !info) return null;                      // file missing on Commons
              if (info && !ALLOWED_MIME[info.mime]) return null;        // e.g. a ".jpg" that is really a TIFF
              var url = info ? info.url : filePathUrl(p.fileName, opts.thumbWidth);
              if (!/^https:\/\//.test(url)) return null;
              return {
                id: p.id,
                image_url: url,
                lat: p.lat,
                lng: p.lng,
                actual_year: p.actual_year,
                description: p.description,
                source_url: info ? info.page : commonsPageUrl(p.fileName)
              };
            }).filter(Boolean);
          });
      });
  }

  var api = {
    fetchHistoricalRounds: fetchHistoricalRounds,
    // Exposed for testing and custom pipelines:
    buildQuery: function (options, rows, offset) { return buildQuery(mergeOptions(options), rows || 60, offset || 0); },
    parseBindings: function (json, options) { return parseBindings(json, mergeOptions(options)); },
    parsePoint: parsePoint,
    fileNameFromP18: fileNameFromP18,
    DEFAULT_CLASSES: DEFAULT_CLASSES.slice(),
    STANDARD_WIDTHS: STANDARD_WIDTHS.slice(),
    snapWidth: snapWidth,
    DEFAULTS: DEFAULTS
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WikidataRounds = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* =============================================================================
 * The Daily Dose — shared photo deck for Timeline and Older or Newer
 * -----------------------------------------------------------------------------
 * Loads the Snapshot photo catalogue (data/photos/manifest.js + shards) and
 * deals photos for a game:
 *   - dailyPool(game, day): one shard chosen by hashing the date, in an order
 *     also chosen by hashing the date, so everyone gets the same photos on the
 *     same day with no server. The leaderboard API (functions/api) repeats
 *     exactly these steps to check results, so keep the two in step.
 *   - randomPool(): photos from a couple of random shards, shuffled (practice).
 *   - pickTimeline(pool) / pickSequence(pool): the photos a game uses.
 * Photos are { id, url, year, description, credit, source }.
 * ========================================================================== */
(function () {
  'use strict';

  var YEAR_MIN = 1900, YEAR_MAX = 2026;

  function hashStr(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** Keep usable photos only (same rule as the API). */
  function clean(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (p) {
      return p && typeof p.id === 'string' && typeof p.image_url === 'string' && p.image_url &&
        isFinite(p.actual_year) && Math.round(p.actual_year) >= YEAR_MIN && Math.round(p.actual_year) <= YEAR_MAX;
    }).map(function (p) {
      return {
        id: p.id,
        url: p.image_url,
        year: Math.round(Number(p.actual_year)),
        description: p.description || 'Untitled photograph',
        credit: p.credit || '',
        source: typeof p.source_url === 'string' && /^https:\/\//.test(p.source_url) ? p.source_url : ''
      };
    });
  }

  var shardLoads = {};
  function manifest() {
    var m = window.SNAPSHOT_MANIFEST;
    return m && m.shards > 0 && m.path ? m : null;
  }
  function loadShard(i) {
    if (!shardLoads[i]) {
      var m = manifest();
      shardLoads[i] = new Promise(function (resolve) {
        var done = function () {
          var data = window.SNAPSHOT_SHARDS && window.SNAPSHOT_SHARDS[i];
          if (!Array.isArray(data)) delete shardLoads[i];
          resolve(clean(data));
        };
        var tag = document.createElement('script');
        tag.src = m.path.replace('{n}', String(i).padStart(3, '0'));
        tag.async = true;
        tag.onload = done;
        tag.onerror = done;
        document.head.appendChild(tag);
      });
    }
    return shardLoads[i];
  }

  /** The day's photos for a game, in the day's order. */
  function dailyPool(game, day) {
    var m = manifest();
    if (!m) return Promise.resolve([]);
    var first = hashStr(game + ':shard:' + day) % m.shards;
    return loadShard(first).then(function (list) {
      // The last shard can be small: move on to the next one if so.
      return list.length >= 100 ? list : loadShard((first + 1) % m.shards);
    }).then(function (list) {
      return list.slice().sort(function (a, b) {
        return (hashStr(game + ':' + day + ':' + a.id) - hashStr(game + ':' + day + ':' + b.id)) || (a.id < b.id ? -1 : 1);
      });
    });
  }

  /** Practice photos from a couple of random shards. */
  function randomPool() {
    var m = manifest();
    if (!m) return Promise.resolve([]);
    var picks = shuffle(Array.from({ length: m.shards }, function (_, i) { return i; })).slice(0, 2);
    return Promise.all(picks.map(loadShard)).then(function (lists) {
      return shuffle([].concat.apply([], lists));
    });
  }

  /** Timeline: the first five photos (in pool order) at least 5 years apart from each other. */
  var TIMELINE_SIZE = 5, TIMELINE_GAP = 5;
  function pickTimeline(pool) {
    var out = [];
    for (var i = 0; i < pool.length && out.length < TIMELINE_SIZE; i++) {
      var p = pool[i];
      if (out.every(function (q) { return Math.abs(q.year - p.year) >= TIMELINE_GAP; })) out.push(p);
    }
    return out;
  }

  /** Older or Newer: a run of photos, each at least 3 years from the one before. */
  var SEQUENCE_SIZE = 50, SEQUENCE_GAP = 3;
  function pickSequence(pool, size) {
    var out = [];
    var n = size || SEQUENCE_SIZE;
    for (var i = 0; i < pool.length && out.length < n; i++) {
      var p = pool[i];
      if (!out.length || Math.abs(p.year - out[out.length - 1].year) >= SEQUENCE_GAP) out.push(p);
    }
    return out;
  }

  /**
   * Commons thumbnail URLs for a photo, best first. Commons only serves set
   * widths (250, 330, 500, 960, 1280, …), from thumb.wikimedia.org. Full-size
   * originals on upload.wikimedia.org are often rate-limited when hotlinked,
   * so those get a thumbnail URL too, with the original as the last resort.
   */
  function sources(url, width) {
    var out = [];
    var m = /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/thumb\/(\w\/\w\w\/[^/]+)\/(\d+)px-([^/]+)$/.exec(url);
    var o = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/(\w\/\w\w\/([^/]+\.(?:jpe?g|png)))$/i.exec(url);
    var thumb = function (path, file, w) { return 'https://thumb.wikimedia.org/wikipedia/commons/thumb/' + path + '/' + w + 'px-' + file; };
    if (m) {
      if (Number(m[2]) > width) out.push(thumb(m[1], m[3], width));
      out.push(url);
    } else if (o) {
      out.push(thumb(o[1], o[2], width));
      if (width > 500) out.push(thumb(o[1], o[2], 500));
      out.push(url);
    } else {
      out.push(url);
    }
    return out;
  }
  function sized(url, width) { return sources(url, width)[0]; }

  /**
   * Point an <img> at a photo, trying each source in turn, then showing a
   * "couldn't load" state on the img's parent (class is-broken).
   */
  function setImage(img, photo, width) {
    var holder = img.parentNode;
    var list = sources(photo.url, width);
    var k = 0;
    holder.classList.remove('is-broken', 'is-loaded');
    img.onload = function () { holder.classList.add('is-loaded'); };
    img.onerror = function () {
      if (++k < list.length) { img.src = list[k]; return; }
      holder.classList.add('is-broken');
    };
    img.src = list[0];
  }

  function preload(photo, width) { var i = new Image(); i.src = sized(photo.url, width); }

  function dailyNumber(day) { return Math.round((Date.parse(day) - Date.parse('2026-11-07')) / 864e5) + 1; }

  window.PhotoDeck = {
    dailyPool: dailyPool,
    randomPool: randomPool,
    pickTimeline: pickTimeline,
    pickSequence: pickSequence,
    sized: sized,
    setImage: setImage,
    preload: preload,
    shuffle: shuffle,
    hashStr: hashStr,
    dailyNumber: dailyNumber,
    TIMELINE_SIZE: TIMELINE_SIZE,
    SEQUENCE_SIZE: SEQUENCE_SIZE
  };
})();

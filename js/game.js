/* =============================================================================
 * A Snapshot in History — game loop
 * Depends on: Leaflet (window.L), js/scoring.js, js/data.js
 * ========================================================================== */
(function () {
  'use strict';

  var ROUNDS_PER_MATCH = 5;
  var YEAR_MIN = 1900;
  var YEAR_MAX = 2020;
  var IMAGE_TIMEOUT_MS = 15000;
  var PLACEHOLDER_SRC = './assets/placeholder.svg';

  // Where photos come from, in order:
  //   1. ./data/photos.json: pre-built from Wikidata + Commons by
  //      scripts/build-photos.js. Loads instantly; this is the main source.
  //   2. Live Wikidata queries (js/wikidata-rounds.js), only if enabled below.
  //      Off by default because each query takes ~10–60 s.
  //   3. The embedded entries in js/data.js, as a last resort.
  var PHOTOS_JSON = './data/photos.json';
  var LIVE_ROUNDS = {
    enabled: false,
    timeoutMs: 45000,
    options: { minYear: YEAR_MIN, maxYear: YEAR_MAX } // e.g. add country: 'Q142' or bbox: {...}
  };

  var Scoring = window.SnapshotScoring;

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function formatDistance(km) {
    if (km < 1) return Math.round(km * 1000) + ' m away';
    if (km < 100) return km.toFixed(1) + ' km away';
    return fmt(km) + ' km away';
  }
  function formatYearDiff(diff, actual) {
    if (diff === 0) return 'Exactly ' + actual + '!';
    return diff + (diff === 1 ? ' year' : ' years') + ' off (' + actual + ')';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Keep only well-formed entries so a bad record can never break a match. */
  function validPhotos(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (p) {
      return p &&
        isFinite(p.lat) && Math.abs(p.lat) <= 90 &&
        isFinite(p.lng) && Math.abs(p.lng) <= 180 &&
        isFinite(p.actual_year);
    }).map(function (p) {
      return {
        id: p.id,
        image_url: typeof p.image_url === 'string' ? p.image_url : '',
        lat: Number(p.lat),
        lng: Number(p.lng),
        actual_year: clamp(Math.round(Number(p.actual_year)), YEAR_MIN, YEAR_MAX),
        description: p.description || 'Untitled photograph',
        source_url: typeof p.source_url === 'string' && /^https:\/\//.test(p.source_url) ? p.source_url : ''
      };
    });
  }

  // ------------------------------------------------------------------ state
  var state = {
    photos: [],      // the photos for this match
    round: 0,        // 0-based index
    total: 0,
    guessLatLng: null,
    yearChosen: false,
    locked: false,
    history: []      // per-round results
  };

  // -------------------------------------------------------------- elements
  var el = {
    roundNum: $('round-num'), roundTotal: $('round-total'), totalScore: $('total-score'),
    viewer: $('viewer'), photo: $('photo'), loading: $('photo-loading'), error: $('photo-error'),
    zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoomReset: $('zoom-reset'),
    mapPanel: $('map-panel'), mapHint: $('map-hint'), mapPin: $('map-pin'), mapToggle: $('map-toggle'),
    guessControls: $('guess-controls'), resultControls: $('result-controls'),
    year: $('year'), yearOut: $('year-out'), yearDown: $('year-down'), yearUp: $('year-up'),
    reqPin: $('req-pin'), reqYear: $('req-year'), submit: $('submit'),
    resTotal: $('res-total'), resDist: $('res-dist'), resLoc: $('res-loc'),
    resYear: $('res-year'), resTime: $('res-time'), resMeter: $('res-meter'), resDesc: $('res-desc'),
    resCredit: $('res-credit'),
    next: $('next'),
    startScreen: $('start-screen'), start: $('start'),
    endScreen: $('end-screen'), endTotal: $('end-total'), endMax: $('end-max'),
    endVerdict: $('end-verdict'), endRows: $('end-rows'), again: $('again')
  };

  // =================================================================== MAP
  var map = null;
  var guessMarker = null;
  var revealLayer = null;
  var hoverCapable = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function pinIcon(color, label) {
    var html =
      '<div class="pin">' +
        (label ? '<span class="pin-label">' + escapeHtml(label) + '</span>' : '') +
        '<svg viewBox="0 0 26 36" aria-hidden="true">' +
          '<path d="M13 1C6.4 1 1 6.3 1 12.9 1 22 13 35 13 35s12-13 12-22.1C25 6.3 19.6 1 13 1z" fill="' + color + '" stroke="#14110f" stroke-width="2"/>' +
          '<circle cx="13" cy="13" r="4.5" fill="#14110f"/>' +
        '</svg>' +
      '</div>';
    return L.divIcon({ html: html, className: '', iconSize: [26, 36], iconAnchor: [13, 35] });
  }

  function initMap() {
    if (typeof window.L === 'undefined') {
      el.mapHint.textContent = 'Map failed to load — check your connection and reload.';
      return;
    }
    map = L.map('map', {
      center: [25, 0],
      zoom: 1,
      minZoom: 1,
      maxZoom: 18,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);

    map.on('click', onMapClick);

    // Leaflet needs to be told when its container changes size (hover/expand).
    if ('ResizeObserver' in window) {
      new ResizeObserver(function () { map.invalidateSize({ pan: false }); }).observe($('map'));
    }
  }

  function isMapExpanded() {
    return el.mapPanel.classList.contains('is-expanded') ||
      (hoverCapable && el.mapPanel.matches(':hover'));
  }

  function onMapClick(e) {
    if (state.locked) return;
    // On touch devices the first tap on a collapsed map just opens it.
    if (!isMapExpanded()) { setMapExpanded(true); return; }

    var latlng = e.latlng.wrap();
    state.guessLatLng = latlng;
    if (guessMarker) map.removeLayer(guessMarker);   // clear the previous temporary pin
    guessMarker = L.marker(latlng, { icon: pinIcon('#e7a33e'), keyboard: false }).addTo(map);
    el.mapHint.textContent = 'Pin placed · click again to move it';
    updateSubmitState();
  }

  function setMapExpanded(expanded) {
    el.mapPanel.classList.toggle('is-expanded', expanded);
    el.mapToggle.setAttribute('aria-expanded', String(expanded));
    el.mapToggle.title = expanded ? 'Collapse map' : 'Expand map';
  }

  function setMapPinned(pinned) {
    el.mapPin.setAttribute('aria-pressed', String(pinned));
    setMapExpanded(pinned);
  }

  function clearMap() {
    if (!map) return;
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    if (revealLayer) { map.removeLayer(revealLayer); revealLayer = null; }
    map.setView([25, 0], 1, { animate: false });
  }

  function revealOnMap(guess, actual) {
    if (!map) return;
    // Shift the actual point by ±360° if that makes the line shorter, so the
    // polyline takes the short way round across the antimeridian.
    var actualLng = actual.lng;
    if (actualLng - guess.lng > 180) actualLng -= 360;
    else if (guess.lng - actualLng > 180) actualLng += 360;
    var actualLatLng = L.latLng(actual.lat, actualLng);

    revealLayer = L.layerGroup([
      L.polyline([guess, actualLatLng], { color: '#d6402f', weight: 3, dashArray: '8 6', opacity: 0.95 }),
      L.marker(actualLatLng, { icon: pinIcon('#f2ead9', String(actual.year)), keyboard: false, zIndexOffset: 500 })
    ]).addTo(map);

    setMapExpanded(true);
    // Wait for the expand transition, then fit both pins.
    var bounds = L.latLngBounds([guess, actualLatLng]);
    var fit = function () {
      map.invalidateSize({ pan: false });
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 9, animate: true });
    };
    setTimeout(fit, 320);
  }

  // ========================================================= PHOTO VIEWER
  var view = { scale: 1, x: 0, y: 0, min: 1, max: 6 };
  var pointers = new Map();
  var pinchStart = null;
  var dragStart = null;
  var imageTimer = null;

  function applyTransform(animate) {
    el.photo.classList.toggle('is-animating', !!animate);
    el.photo.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
  }

  function clampPan() {
    var rect = el.viewer.getBoundingClientRect();
    var w = el.photo.offsetWidth * view.scale;
    var h = el.photo.offsetHeight * view.scale;
    var maxX = Math.max(0, (w - rect.width) / 2 + 24);
    var maxY = Math.max(0, (h - rect.height) / 2 + 24);
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  /** Zoom to `next` keeping the viewer point (cx, cy) — relative to centre — fixed. */
  function zoomAt(next, cx, cy, animate) {
    next = clamp(next, view.min, view.max);
    var k = next / view.scale;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.scale = next;
    if (view.scale === 1) { view.x = 0; view.y = 0; }
    clampPan();
    applyTransform(animate);
  }

  function resetZoom(animate) {
    view.scale = 1; view.x = 0; view.y = 0;
    applyTransform(animate);
  }

  function centerOffset(clientX, clientY) {
    var r = el.viewer.getBoundingClientRect();
    return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
  }

  function initViewer() {
    el.viewer.addEventListener('wheel', function (e) {
      if (e.target.closest('.zoom-controls')) return;
      e.preventDefault();
      var p = centerOffset(e.clientX, e.clientY);
      zoomAt(view.scale * Math.exp(-e.deltaY * 0.0015), p.x, p.y, false);
    }, { passive: false });

    el.viewer.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      el.viewer.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragStart = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
        el.viewer.classList.add('is-dragging');
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        pinchStart = {
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          scale: view.scale
        };
        dragStart = null;
      }
    });

    el.viewer.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStart) {
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        var mid = centerOffset((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        zoomAt(pinchStart.scale * (dist / pinchStart.dist), mid.x, mid.y, false);
      } else if (dragStart && view.scale > 1) {
        view.x = dragStart.x + (e.clientX - dragStart.px);
        view.y = dragStart.y + (e.clientY - dragStart.py);
        clampPan();
        applyTransform(false);
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 1) {
        var p = Array.from(pointers.values())[0];
        dragStart = { px: p.x, py: p.y, x: view.x, y: view.y };
      }
      if (pointers.size === 0) { dragStart = null; el.viewer.classList.remove('is-dragging'); }
    }
    el.viewer.addEventListener('pointerup', endPointer);
    el.viewer.addEventListener('pointercancel', endPointer);

    el.viewer.addEventListener('dblclick', function (e) {
      if (e.target.closest('button')) return;
      var p = centerOffset(e.clientX, e.clientY);
      if (view.scale > 1.01) resetZoom(true); else zoomAt(2.5, p.x, p.y, true);
    });

    el.zoomIn.addEventListener('click', function () { zoomAt(view.scale * 1.5, 0, 0, true); });
    el.zoomOut.addEventListener('click', function () { zoomAt(view.scale / 1.5, 0, 0, true); });
    el.zoomReset.addEventListener('click', function () { resetZoom(true); });
    window.addEventListener('resize', function () { clampPan(); applyTransform(false); });
  }

  function showPhotoError() {
    clearTimeout(imageTimer);
    el.loading.hidden = true;
    el.error.hidden = false;
    el.photo.classList.remove('is-loaded');
    el.photo.removeAttribute('src');
  }

  function loadPhoto(url) {
    clearTimeout(imageTimer);
    resetZoom(false);
    el.photo.classList.remove('is-loaded');
    el.error.hidden = true;
    el.loading.hidden = false;

    if (!url) { showPhotoError(); return; }

    // Use a detached Image so a slow/broken URL can't leave the visible <img>
    // in a half-loaded state, and so stale loads from a previous round are ignored.
    var token = {};
    loadPhoto.current = token;
    var probe = new Image();
    probe.decoding = 'async';
    probe.referrerPolicy = 'no-referrer';
    probe.onload = function () {
      if (loadPhoto.current !== token) return;
      if (!probe.naturalWidth) { showPhotoError(); return; }
      clearTimeout(imageTimer);
      el.photo.src = url;
      el.loading.hidden = true;
      el.photo.classList.add('is-loaded');
    };
    probe.onerror = function () {
      if (loadPhoto.current !== token) return;
      showPhotoError();
    };
    imageTimer = setTimeout(function () {
      if (loadPhoto.current !== token) return;
      loadPhoto.current = null;
      showPhotoError();
    }, IMAGE_TIMEOUT_MS);
    probe.src = url;
  }

  // ====================================================== YEAR / SUBMIT UI
  function setYear(value, chosen) {
    value = clamp(Math.round(value), YEAR_MIN, YEAR_MAX);
    el.year.value = value;
    if (chosen) state.yearChosen = true;
    var pct = ((value - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;
    el.year.style.setProperty('--fill', pct + '%');
    el.year.classList.toggle('is-unset', !state.yearChosen);
    el.yearOut.dataset.unset = String(!state.yearChosen);
    el.yearOut.textContent = state.yearChosen ? String(value) : 'Drag to pick';
    updateSubmitState();
  }

  function updateSubmitState() {
    var hasPin = !!state.guessLatLng;
    el.reqPin.classList.toggle('is-done', hasPin);
    el.reqYear.classList.toggle('is-done', state.yearChosen);
    el.submit.disabled = state.locked || !hasPin || !state.yearChosen;
  }

  function setInputsLocked(locked) {
    state.locked = locked;
    el.year.disabled = locked;
    el.yearDown.disabled = locked;
    el.yearUp.disabled = locked;
    el.mapPanel.classList.toggle('is-locked', locked);
    updateSubmitState();
  }

  // ============================================================ GAME FLOW
  var builtPhotos = null; // promise for photos.json, fetched once
  var playedIds = Object.create(null);

  function loadBuiltPhotos() {
    if (!builtPhotos) {
      builtPhotos = fetch(PHOTOS_JSON, { cache: 'no-cache' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (json) { return validPhotos(Array.isArray(json) ? json : json.photos); })
        .catch(function (err) {
          console.warn('Could not load ' + PHOTOS_JSON + '; using the embedded set.', err);
          builtPhotos = null; // try again next match
          return [];
        });
    }
    return builtPhotos;
  }

  function loadLivePhotos() {
    var api = window.WikidataRounds;
    if (!LIVE_ROUNDS.enabled || !api) return Promise.resolve([]);
    var opts = {};
    for (var k in LIVE_ROUNDS.options) opts[k] = LIVE_ROUNDS.options[k];
    opts.timeoutMs = LIVE_ROUNDS.timeoutMs;
    return api.fetchHistoricalRounds(ROUNDS_PER_MATCH, opts)
      .then(validPhotos)
      .catch(function (err) {
        console.warn('Live photos unavailable.', err);
        return [];
      });
  }

  /** Pick photos for a match: live, then pre-built, then embedded; unplayed ones first. */
  function loadMatchPhotos() {
    return Promise.all([loadLivePhotos(), loadBuiltPhotos()]).then(function (sources) {
      var live = sources[0];
      var built = shuffle(sources[1]);
      var fresh = built.filter(function (p) { return !playedIds[p.id]; });
      if (fresh.length < ROUNDS_PER_MATCH) { playedIds = Object.create(null); fresh = built; }
      var pool = live.concat(fresh);
      if (pool.length < ROUNDS_PER_MATCH) pool = pool.concat(shuffle(validPhotos(window.SNAPSHOT_DATA)));
      var seen = Object.create(null);
      return pool.filter(function (p) {
        var key = String(p.id);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
    });
  }

  var starting = false;
  function startMatch() {
    if (starting) return;
    starting = true;
    var buttons = [el.start, el.again];
    var labels = buttons.map(function (b) { return b.textContent; });
    buttons.forEach(function (b) { b.disabled = true; b.textContent = 'Finding photographs…'; });

    loadMatchPhotos().then(function (pool) {
      starting = false;
      buttons.forEach(function (b, i) { b.disabled = false; b.textContent = labels[i]; });
      if (!pool.length) {
        alert('No valid photos found in the dataset (js/data.js).');
        return;
      }
      var photos = pool.slice(0, ROUNDS_PER_MATCH);
      photos.forEach(function (p) { playedIds[p.id] = true; });
      beginMatch(photos);
    });
  }

  function beginMatch(photos) {
    state.photos = photos;
    state.round = 0;
    state.total = 0;
    state.history = [];
    el.roundTotal.textContent = state.photos.length;
    el.totalScore.textContent = '0';
    el.startScreen.hidden = true;
    el.endScreen.hidden = true;
    startRound();
  }

  function startRound() {
    var photo = state.photos[state.round];
    state.guessLatLng = null;
    state.yearChosen = false;

    el.roundNum.textContent = state.round + 1;
    el.guessControls.classList.remove('hidden');
    el.guessControls.classList.add('flex');
    el.resultControls.classList.add('hidden');
    el.resultControls.classList.remove('flex');
    el.resMeter.style.width = '0';
    el.mapHint.textContent = 'Click the map to drop your pin';

    clearMap();
    setMapPinned(false);
    setInputsLocked(false);
    setYear(Math.round((YEAR_MIN + YEAR_MAX) / 2), false);
    loadPhoto(photo.image_url);
  }

  function submitGuess() {
    if (el.submit.disabled) return;
    var photo = state.photos[state.round];
    var guess = { lat: state.guessLatLng.lat, lng: state.guessLatLng.lng, year: Number(el.year.value) };
    var actual = { lat: photo.lat, lng: photo.lng, year: photo.actual_year };
    var result = Scoring.scoreRound(guess, actual);

    setInputsLocked(true);
    state.total += result.total;
    state.history.push({ photo: photo, guess: guess, result: result });

    revealOnMap(state.guessLatLng, actual);
    el.mapHint.textContent = 'Your pin vs. where it was taken';

    // Result panel
    el.resTotal.textContent = fmt(result.total);
    el.resDist.textContent = formatDistance(result.distanceKm);
    el.resLoc.textContent = fmt(result.locationScore);
    el.resYear.textContent = formatYearDiff(result.yearDiff, actual.year);
    el.resTime.textContent = fmt(result.timeScore);
    el.resDesc.textContent = photo.description;
    el.resCredit.hidden = !photo.source_url;
    if (photo.source_url) el.resCredit.href = photo.source_url;
    el.next.textContent = state.round + 1 >= state.photos.length ? 'See results' : 'Next round';

    el.guessControls.classList.add('hidden');
    el.guessControls.classList.remove('flex');
    el.resultControls.classList.remove('hidden');
    el.resultControls.classList.add('flex');
    requestAnimationFrame(function () {
      el.resMeter.style.width = (result.total / Scoring.ROUND_MAX) * 100 + '%';
    });
    animateNumber(el.totalScore, state.total - result.total, state.total);
    el.next.focus({ preventScroll: true });
  }

  function nextRound() {
    state.round += 1;
    if (state.round >= state.photos.length) endMatch();
    else startRound();
  }

  function endMatch() {
    var max = state.photos.length * Scoring.ROUND_MAX;
    el.endTotal.textContent = fmt(state.total);
    el.endMax.textContent = fmt(max);
    var pct = state.total / max;
    el.endVerdict.textContent =
      pct >= 0.9 ? 'Archivist-grade. You read photographs like a historian.' :
      pct >= 0.7 ? 'Sharp eye — the details didn’t get past you.' :
      pct >= 0.45 ? 'Solid instincts. A few eras blurred together.' :
      pct >= 0.2 ? 'Some good reads in there. History is tricky!' :
                   'Every archivist starts somewhere. Try another match?';

    el.endRows.innerHTML = state.history.map(function (h, i) {
      var r = h.result;
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td class="desc">' + escapeHtml(h.photo.description) + '</td>' +
        '<td class="num">' + escapeHtml(formatDistance(r.distanceKm).replace(' away', '')) +
          '<br><span class="stat-dim">' + (r.yearDiff === 0 ? 'exact year' : r.yearDiff + ' yr') + '</span></td>' +
        '<td class="num"><b>' + fmt(r.total) + '</b></td>' +
      '</tr>';
    }).join('');

    el.endScreen.hidden = false;
    el.again.focus({ preventScroll: true });
  }

  function animateNumber(node, from, to) {
    var start = performance.now();
    var dur = 700;
    function tick(now) {
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = fmt(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // =============================================================== EVENTS
  function bindEvents() {
    el.year.addEventListener('input', function () { setYear(el.year.value, true); });
    el.yearDown.addEventListener('click', function () {
      setYear(state.yearChosen ? Number(el.year.value) - 1 : Number(el.year.value), true);
    });
    el.yearUp.addEventListener('click', function () {
      setYear(state.yearChosen ? Number(el.year.value) + 1 : Number(el.year.value), true);
    });

    el.submit.addEventListener('click', submitGuess);
    el.next.addEventListener('click', nextRound);
    el.start.addEventListener('click', startMatch);
    el.again.addEventListener('click', startMatch);

    el.mapToggle.addEventListener('click', function () {
      var expanded = !el.mapPanel.classList.contains('is-expanded');
      setMapExpanded(expanded);
      if (!expanded) el.mapPin.setAttribute('aria-pressed', 'false');
    });
    el.mapPin.addEventListener('click', function () {
      setMapPinned(el.mapPin.getAttribute('aria-pressed') !== 'true');
    });

    document.addEventListener('keydown', function (e) {
      if (!el.startScreen.hidden || !el.endScreen.hidden) return;
      if (e.key === 'Enter' && !e.target.closest('button')) {
        if (!state.locked) submitGuess(); else nextRound();
      } else if (e.key === 'Escape' && !state.locked) {
        setMapPinned(false);
      } else if (e.key.toLowerCase() === 'm' && e.target === document.body) {
        el.mapToggle.click();
      }
    });
  }

  // ================================================================= INIT
  function init() {
    if (!Scoring) { console.error('scoring.js failed to load'); return; }
    // Fallback image for any <img> on the page that fails (belt and braces).
    document.addEventListener('error', function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG' && t !== el.photo && t.src.indexOf(PLACEHOLDER_SRC.slice(1)) === -1) {
        t.src = PLACEHOLDER_SRC;
      }
    }, true);

    loadBuiltPhotos(); // start downloading the photo list while the start screen shows
    initMap();
    initViewer();
    bindEvents();
    setYear(1960, false);
    el.roundTotal.textContent = Math.min(ROUNDS_PER_MATCH, validPhotos(window.SNAPSHOT_DATA).length);
    el.start.focus({ preventScroll: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

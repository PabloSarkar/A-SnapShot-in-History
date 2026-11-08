/* =============================================================================
 * The Daily Dose — Compass (compass.html)
 * -----------------------------------------------------------------------------
 * Find the secret country in eight guesses. Each guess shows:
 *   - distance from the guess to the secret country (Haversine, km or miles)
 *   - the compass bearing from the guess to the secret country
 *   - region: green = same subregion, yellow = same continent, red = neither
 *   - population: green within 10%, otherwise ⬆ (secret has more) / ⬇ (fewer)
 *
 * Countries: js/compass-countries.js (195 UN members + observers), all of
 * which can be the answer. The daily answer walks a fixed shuffle of every
 * country, one per day, so it doesn't repeat for 195 days. Like every daily on
 * the site it follows the player's local date (js/daily-archive.js); the
 * leaderboard API (functions/api) repeats the same shuffle to check results.
 *
 * Saved per day as { date, guesses: [cca2…], done, won, finishedAt, summary }.
 * Statistics (played, win %, streaks, guess distribution) are worked out from
 * those saved daily results, so they follow a signed-in player across devices.
 * ========================================================================== */
(function () {
  'use strict';

  var Archive = window.DailyArchive;
  var MAX_GUESSES = 8;
  var POP_CLOSE = 0.10;          // within 10% counts as a match
  var KM_PER_MI = 1.609344;
  var UNITS_KEY = 'compass.units';

  /* ============================================================== data */
  function normalise(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  var countries = (window.COMPASS_COUNTRIES || []).map(function (r) {
    var aliases = r[8] ? r[8].split('|') : [];
    return {
      name: r[0], code: r[1], capital: r[2], continent: r[3], subregion: r[4], pop: r[5], lat: r[6], lng: r[7],
      aliases: aliases, key: normalise(r[0]), akeys: aliases.map(normalise)
    };
  });
  var byCode = {};
  countries.forEach(function (c) { byCode[c.code] = c; });

  function flag(code) {
    return String.fromCodePoint.apply(null, code.toUpperCase().split('').map(function (ch) { return 0x1F1E6 + ch.charCodeAt(0) - 65; }));
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  function fmtPop(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
  }

  /* ========================================================= geometry */
  var R_KM = 6371.0088;
  function rad(d) { return d * Math.PI / 180; }
  function haversineKm(a, b) {
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /**
   * Compass bearing from a to b, 0–360° (0 = north): the constant heading of
   * a rhumb line, which matches how a direction reads on a map. (The
   * great-circle starting bearing can point "north" from France to Fiji.)
   * Longitude difference takes the shorter way round the globe.
   */
  function bearing(a, b) {
    var dLng = rad(b.lng - a.lng);
    if (Math.abs(dLng) > Math.PI) dLng = dLng > 0 ? dLng - 2 * Math.PI : dLng + 2 * Math.PI;
    var clampLat = function (d) { return rad(Math.max(-89.9, Math.min(89.9, d))); };
    var dPsi = Math.log(Math.tan(Math.PI / 4 + clampLat(b.lat) / 2) / Math.tan(Math.PI / 4 + clampLat(a.lat) / 2));
    return (Math.atan2(dLng, dPsi) * 180 / Math.PI + 360) % 360;
  }
  var POINTS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var ARROWS8 = ['⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️'];
  function sector(deg) { return Math.round(deg / 45) % 8; }

  /** Everything a guess reveals about the secret country. */
  function clue(guess, secret) {
    var correct = guess.code === secret.code;
    var km = correct ? 0 : haversineKm(guess, secret);
    var deg = correct ? 0 : bearing(guess, secret);
    var region = guess.subregion === secret.subregion ? 'green' : guess.continent === secret.continent ? 'yellow' : 'red';
    var popClose = Math.abs(guess.pop - secret.pop) <= POP_CLOSE * secret.pop;
    return {
      correct: correct, km: km, deg: deg, dir: sector(deg), region: region,
      pop: popClose ? 'green' : secret.pop > guess.pop ? 'up' : 'down',
      prox: Math.max(0, 1 - km / 20015)
    };
  }

  /* ============================================================ daily */
  function hashStr(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function dailyNumber(day) { return Math.round((Date.parse(day) - Date.parse(Archive.LAUNCH)) / 864e5) + 1; }
  function dailyAnswer(day) {
    var order = countries.map(function (c) { return c.code; }).sort();
    var rng = mulberry32(hashStr('compass-order-v1'));
    for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
    var n = dailyNumber(day);
    return byCode[order[((n - 1) % order.length + order.length) % order.length]];
  }
  var ARCHIVE_DAY = Archive.requestedDay();
  function dailyDay() { return ARCHIVE_DAY || Archive.today(); }

  /* ============================================================ state */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    menu: $('menu'), menuStatus: $('menu-status'), dailyBtn: $('daily-btn'), practiceBtn: $('practice-btn'),
    dailyName: $('daily-name'), dailyDesc: $('daily-desc'), dailyBadge: $('daily-badge'),
    howto: $('howto'), howtoOpen: $('howto-open'), howtoClose: $('howto-close'), help: $('help-btn'),
    menuStats: $('menu-stats'), statsBtn: $('stats-btn'), units: $('units-btn'),
    modeLabel: $('mode-label'), guessNum: $('guess-num'), main: $('main'),
    form: $('form'), input: $('input'), guessBtn: $('guess-btn'), list: $('list'), error: $('error'), board: $('board'),
    end: $('end'), endEyebrow: $('end-eyebrow'), endTitle: $('end-title'), endLede: $('end-lede'), endAnswer: $('end-answer'),
    endGrid: $('end-grid'), endActions: $('end-actions'), endNote: $('end-note'), statsClose: $('stats-close'),
    stPlayed: $('st-played'), stWin: $('st-win'), stStreak: $('st-streak'), stMax: $('st-max'), dist: $('dist'),
    share: $('share-btn'), lbLink: $('lb-link'), again: $('again-btn'), boardBtn: $('board-btn'), menuBtn: $('menu-btn'),
    confetti: $('confetti')
  };
  var state = null;   // { mode, day, answer, guesses: [code], done, won, finishedAt }

  function units() { try { return localStorage.getItem(UNITS_KEY) === 'mi' ? 'mi' : 'km'; } catch (e) { return 'km'; } }
  function fmtDist(km) { return units() === 'mi' ? fmt(km / KM_PER_MI) + ' mi' : fmt(km) + ' km'; }

  function newGame(mode, day, answer, saved) {
    state = { mode: mode, day: day, answer: answer, guesses: [], done: false, won: false, finishedAt: null };
    if (saved && Array.isArray(saved.guesses)) {
      saved.guesses.forEach(function (code) {
        if (state.done || !byCode[code] || state.guesses.indexOf(code) !== -1) return;
        state.guesses.push(code);
        if (code === answer.code) { state.done = true; state.won = true; }
        else if (state.guesses.length >= MAX_GUESSES) state.done = true;
      });
      state.finishedAt = saved.finishedAt || null;
    }
  }

  function save() {
    if (state.mode !== 'daily') return;
    if (state.done && !state.finishedAt) state.finishedAt = Date.now();   // leaderboards: same-day plays only
    Archive.write('compass', state.day, {
      date: state.day, guesses: state.guesses, done: state.done, won: state.won,
      finishedAt: state.done ? state.finishedAt : null,
      summary: state.done ? (state.won ? state.guesses.length : 'X') + '/' + MAX_GUESSES : state.guesses.length + ' of ' + MAX_GUESSES
    });
  }

  /* ============================================================ board */
  var ARROW_SVG = '<svg class="arrow" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3l8 12h-5v14h-6V15H8z" fill="currentColor"/></svg>';

  function rowHtml(code, k, fresh) {
    var g = byCode[code], c = clue(g, state.answer);
    var dirTile = c.correct
      ? '<div class="tile is-green"><span class="big">🎯</span><small>Found</small></div>'
      : '<div class="tile" aria-label="Direction ' + POINTS8[c.dir] + '">' +
          ARROW_SVG.replace('class="arrow"', 'class="arrow" style="transform:rotate(' + c.deg.toFixed(0) + 'deg)"') +
          '<small>' + POINTS8[c.dir] + '</small></div>';
    var popTile = c.pop === 'green'
      ? '<div class="tile is-green"><span class="big">' + fmtPop(g.pop) + '</span><small>' + (c.correct ? 'Match' : 'Within 10%') + '</small></div>'
      : '<div class="tile"><span class="big">' + fmtPop(g.pop) + ' <span class="pop-arrow" aria-label="' + (c.pop === 'up' ? 'secret has more people' : 'secret has fewer people') + '">' + (c.pop === 'up' ? '⬆' : '⬇') + '</span></span><small>' + (c.pop === 'up' ? 'More people' : 'Fewer people') + '</small></div>';
    return '<div class="cp-row' + (fresh ? ' is-new' : '') + '">' +
      '<div class="tile tile-country' + (c.correct ? ' is-green' : '') + '"><span class="flag" aria-hidden="true">' + flag(g.code) + '</span><span class="nm">' + esc(g.name) + '</span><span class="tile-num">' + (k + 1) + '</span></div>' +
      '<div class="tile' + (c.correct ? ' is-green' : '') + '"><span class="big">' + fmtDist(c.km) + '</span>' + (c.correct ? '<small>Spot on</small>' : '<span class="meter" style="width:' + (c.prox * 100).toFixed(1) + '%"></span>') + '</div>' +
      dirTile +
      '<div class="tile is-' + c.region + '"><span>' + esc(g.subregion) + '</span>' + (g.subregion !== g.continent ? '<small>' + esc(g.continent) + '</small>' : '') + '</div>' +
      popTile +
      '</div>';
  }

  function renderBoard(freshIndex) {
    var head = el.board.firstElementChild;
    var html = state.guesses.map(function (code, k) { return rowHtml(code, k, k === freshIndex); }).join('');
    if (!state.done) {
      for (var k = state.guesses.length; k < MAX_GUESSES; k++) {
        html += '<div class="cp-row is-placeholder" aria-hidden="true">' +
          '<div class="tile tile-country is-empty"><span class="tile-num">' + (k + 1) + '</span></div>' +
          '<div class="tile is-empty"></div><div class="tile is-empty"></div><div class="tile is-empty"></div><div class="tile is-empty"></div></div>';
      }
    }
    el.board.innerHTML = '';
    el.board.appendChild(head);
    el.board.insertAdjacentHTML('beforeend', html);
    el.guessNum.textContent = Math.min(state.guesses.length + (state.done ? 0 : 1), MAX_GUESSES);
    el.input.disabled = el.guessBtn.disabled = state.done;
    el.input.placeholder = state.done ? (state.won ? 'Solved! See you tomorrow.' : 'Out of guesses.') : 'Type a country…';
    if (state.done && state.mode === 'practice') el.input.placeholder = state.won ? 'Solved!' : 'Out of guesses.';
  }

  /* =========================================================== guess */
  function submit(c) {
    if (!state || state.done) return;
    if (state.guesses.indexOf(c.code) !== -1) { el.error.textContent = 'You’ve already guessed ' + c.name + '.'; return; }
    el.error.textContent = '';
    el.input.value = '';
    closeList();
    state.guesses.push(c.code);
    if (c.code === state.answer.code) { state.done = true; state.won = true; }
    else if (state.guesses.length >= MAX_GUESSES) state.done = true;
    save();
    renderBoard(state.guesses.length - 1);
    var rows = el.board.querySelectorAll('.cp-row:not(.cp-head):not(.is-placeholder)');
    var last = rows[rows.length - 1];
    if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (state.done) {
      setTimeout(function () {
        if (state.won) confetti();
        showEnd();
      }, 900);
    } else {
      el.input.focus();
    }
  }

  /* ======================================================== combobox */
  var matches = [], active = -1;
  function search(q) {
    var nq = normalise(q);
    if (!nq) return [];
    var buckets = [[], [], [], []];
    countries.forEach(function (c) {
      if (state && state.guesses.indexOf(c.code) !== -1) return;
      if (c.key.indexOf(nq) === 0) return buckets[0].push({ c: c });
      if ((' ' + c.key).indexOf(' ' + nq) !== -1) return buckets[1].push({ c: c });
      for (var i = 0; i < c.akeys.length; i++) {
        if (c.akeys[i].indexOf(nq) === 0 || (' ' + c.akeys[i]).indexOf(' ' + nq) !== -1) return buckets[2].push({ c: c, alias: c.aliases[i] });
      }
      if (c.key.indexOf(nq) !== -1) buckets[3].push({ c: c });
    });
    return buckets[0].concat(buckets[1], buckets[2], buckets[3]).slice(0, 8);
  }
  function highlight(name, q) {
    var nq = normalise(q), key = normalise(name);
    var i = key.indexOf(nq);
    if (i < 0 || key.length !== name.length) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + nq.length)) + '</mark>' + esc(name.slice(i + nq.length));
  }
  function openList() {
    var q = el.input.value;
    if (!q.trim()) { closeList(); return; }
    matches = search(q);
    active = matches.length ? 0 : -1;
    el.list.innerHTML = matches.length
      ? matches.map(function (m, i) {
          return '<li role="option" id="opt-' + m.c.code + '" data-code="' + m.c.code + '" aria-selected="' + (i === active) + '">' +
            '<span class="flag" aria-hidden="true">' + flag(m.c.code) + '</span>' +
            '<span class="nm">' + highlight(m.c.name, q) + (m.alias ? '<small>' + esc(m.alias) + '</small>' : '') + '</span>' +
            '<span class="sub">' + esc(m.c.continent) + '</span></li>';
        }).join('')
      : '<li class="empty" role="option" aria-disabled="true">' + (alreadyGuessed(q) ? 'Already guessed' : 'No matching country') + '</li>';
    el.list.hidden = false;
    el.input.setAttribute('aria-expanded', 'true');
    syncActive();
  }
  function closeList() {
    el.list.hidden = true;
    el.input.setAttribute('aria-expanded', 'false');
    el.input.removeAttribute('aria-activedescendant');
    matches = []; active = -1;
  }
  function syncActive() {
    Array.prototype.forEach.call(el.list.querySelectorAll('[data-code]'), function (li, i) {
      li.setAttribute('aria-selected', String(i === active));
      if (i === active) { li.scrollIntoView({ block: 'nearest' }); el.input.setAttribute('aria-activedescendant', li.id); }
    });
  }
  /** An exact name or alias match, guessed or not. */
  function exact(q) {
    var nq = normalise(q);
    for (var i = 0; i < countries.length; i++) {
      if (countries[i].key === nq || countries[i].akeys.indexOf(nq) !== -1) return countries[i];
    }
    return null;
  }
  function alreadyGuessed(q) { var c = exact(q); return c && state && state.guesses.indexOf(c.code) !== -1; }

  el.input.addEventListener('input', function () { el.error.textContent = ''; openList(); });
  el.input.addEventListener('focus', function () { if (el.input.value.trim()) openList(); });
  el.input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (el.list.hidden) { openList(); e.preventDefault(); return; }
      if (!matches.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      syncActive();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeList();
    }
  });
  el.list.addEventListener('mousedown', function (e) { e.preventDefault(); });
  el.list.addEventListener('click', function (e) {
    var li = e.target.closest('[data-code]');
    if (li) submit(byCode[li.dataset.code]);
  });
  document.addEventListener('click', function (e) { if (!el.form.contains(e.target)) closeList(); });
  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = el.input.value;
    if (!q.trim()) { el.error.textContent = 'Type a country name.'; return; }
    var c = exact(q) || (active >= 0 && matches[active] ? matches[active].c : null);
    if (!c) { el.error.textContent = '“' + q.trim() + '” isn’t a country in the list. Pick one from the suggestions.'; return; }
    submit(c);
  });

  /* ============================================================ stats */
  /** Daily statistics from the saved results (finished dailies only). */
  function stats() {
    var all = Archive.readAll('compass');
    var days = Object.keys(all).filter(function (d) { return all[d] && all[d].done; }).sort();
    var played = days.length, wins = 0, dist = [];
    for (var i = 0; i < MAX_GUESSES; i++) dist.push(0);
    var max = 0, run = 0, prev = null;
    days.forEach(function (d) {
      var r = all[d];
      if (r.won) { wins++; dist[Math.min(MAX_GUESSES, r.guesses.length) - 1]++; }
      var next = prev && Archive.shiftDay(prev, 1) === d;
      run = r.won ? (next ? run + 1 : 1) : 0;
      if (!r.won) run = 0;
      max = Math.max(max, run);
      prev = d;
    });
    // Current streak: consecutive won days ending today (or yesterday, if today isn't finished yet).
    var cur = 0, day = Archive.today();
    if (!(all[day] && all[day].done)) day = Archive.shiftDay(day, -1);
    while (all[day] && all[day].done && all[day].won) { cur++; day = Archive.shiftDay(day, -1); }
    return { played: played, winPct: played ? Math.round(100 * wins / played) : 0, current: cur, max: max, dist: dist };
  }

  function renderStats(highlightGuesses) {
    var s = stats();
    el.stPlayed.textContent = s.played;
    el.stWin.textContent = s.winPct;
    el.stStreak.textContent = s.current;
    el.stMax.textContent = s.max;
    var top = Math.max.apply(null, s.dist.concat(1));
    el.dist.innerHTML = '<p class="cp-dist-title">Guess distribution</p>' + s.dist.map(function (n, i) {
      return '<div class="cp-bar' + (highlightGuesses === i + 1 ? ' is-now' : '') + '"><span>' + (i + 1) + '</span>' +
        '<i style="width:' + Math.max(8, Math.round(100 * n / top)) + '%">' + n + '</i></div>';
    }).join('');
  }

  /* ============================================================== end */
  function answerHtml(c) {
    return '<span class="flag" aria-hidden="true">' + flag(c.code) + '</span><div><b>' + esc(c.name) + '</b>' +
      '<p>Capital: ' + esc(c.capital || '—') + '</p><p>' + esc(c.subregion) + ' · ' + esc(c.continent) + '</p>' +
      '<p>Population ' + fmt(c.pop) + '</p></div>';
  }
  function gridLines() {
    return state.guesses.map(function (code) {
      var c = clue(byCode[code], state.answer);
      return ({ green: '🟩', yellow: '🟨', red: '🟥' })[c.region] +
        (c.pop === 'green' ? '🟩' : c.pop === 'up' ? '⬆️' : '⬇️') +
        (c.correct ? '🎯' : ARROWS8[c.dir]);
    });
  }

  function showEnd() {
    var daily = state.mode === 'daily';
    var n = state.guesses.length;
    setStatsMode(false);
    el.endEyebrow.textContent = daily ? 'Compass #' + dailyNumber(state.day) + ' · ' + Archive.longDate(state.day) : 'Practice';
    el.endTitle.textContent = state.won ? (n === 1 ? 'First try!' : n <= 3 ? 'Brilliant!' : 'You found it!') : 'Out of guesses';
    el.endLede.textContent = state.won ? 'Solved in ' + n + ' of ' + MAX_GUESSES + ' guesses.' : 'The secret country was:';
    el.endAnswer.innerHTML = answerHtml(state.answer);
    el.endGrid.innerHTML = gridLines().map(function (l) { return '<div class="squares-row" style="font-size:1.1rem;letter-spacing:2px">' + l + '</div>'; }).join('');
    renderStats(daily && state.won ? n : null);
    el.share.hidden = !daily;
    el.lbLink.hidden = !daily;
    el.lbLink.href = './leaderboard.html?game=compass&day=' + state.day;
    el.again.textContent = daily ? 'Practice' : 'Play again';
    el.endNote.className = 'card-note';
    el.endNote.textContent = !daily ? 'Statistics count daily games only.' : ARCHIVE_DAY
      ? 'Missed other days? Open the calendar on the home page.'
      : 'Next country in ' + Archive.timeToNext() + '.';
    el.end.hidden = false;
    (daily ? el.share : el.again).focus({ preventScroll: true });
  }

  /** The same overlay without the result: just the statistics. */
  function setStatsMode(on) {
    [el.endLede, el.endAnswer, el.endGrid, el.endActions].forEach(function (x) { x.hidden = on; });
    el.statsClose.hidden = !on;
  }
  function showStats() {
    setStatsMode(true);
    el.endEyebrow.textContent = 'Daily games';
    el.endTitle.textContent = 'Statistics';
    renderStats(null);
    el.endNote.className = 'card-note';
    el.endNote.textContent = 'Counted from your daily results' + (window.SnapshotAccount && window.SnapshotAccount.user() ? ' on every device you’re signed in on.' : ' in this browser. Sign in to keep them across devices.');
    el.end.hidden = false;
    el.statsClose.focus();
  }

  function shareText() {
    return 'Compass #' + dailyNumber(state.day) + ' ' + (state.won ? state.guesses.length : 'X') + '/' + MAX_GUESSES + '\n' +
      gridLines().join('\n') + '\n' + location.origin + location.pathname;
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
      catch (e) { reject(e); } finally { document.body.removeChild(ta); }
    });
  }

  /* ========================================================= confetti */
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var cv = el.confetti, ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    cv.hidden = false;
    ctx.scale(dpr, dpr);
    var colours = ['#e7a33e', '#f4bd62', '#f2ead9', '#6fbf8a', '#d6402f', '#8fb59a'];
    var bits = [];
    for (var i = 0; i < 140; i++) {
      bits.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35,
        vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        w: 6 + Math.random() * 6, h: 3 + Math.random() * 5, c: colours[i % colours.length]
      });
    }
    var t0 = performance.now();
    (function frame(t) {
      var age = t - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      bits.forEach(function (b) {
        b.vy += 0.38; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - age / 2200);
        ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      });
      if (age < 2200) requestAnimationFrame(frame);
      else { cv.hidden = true; ctx.setTransform(1, 0, 0, 1, 0, 0); }
    })(t0);
  }

  /* ============================================================= menu */
  function renderMenu() {
    var day = dailyDay();
    var rec = Archive.read('compass', day);
    el.dailyName.textContent = ARCHIVE_DAY ? 'Daily #' + dailyNumber(day) : 'Daily';
    el.dailyBadge.hidden = !rec && !ARCHIVE_DAY;
    el.dailyBadge.textContent = rec && rec.done ? (ARCHIVE_DAY ? '✓ ' : 'Today: ') + rec.summary : rec ? 'In progress' : 'Archive';
    el.dailyDesc.textContent = ARCHIVE_DAY
      ? Archive.longDate(day) + (rec && rec.done ? '. See your result' : ': the country everyone got that day')
      : rec && rec.done ? 'Played today. See your result' : rec ? 'Pick up where you left off' : 'Today’s country: the same for everyone';
  }

  function begin(mode) {
    var day = dailyDay();
    var answer = mode === 'daily' ? dailyAnswer(day) : countries[Math.floor(Math.random() * countries.length)];
    newGame(mode, day, answer, mode === 'daily' ? Archive.read('compass', day) : null);
    el.menu.hidden = true;
    el.end.hidden = true;
    el.modeLabel.hidden = false;
    el.modeLabel.textContent = mode === 'daily' ? 'Daily #' + dailyNumber(day) : 'Practice';
    el.input.value = '';
    el.error.textContent = '';
    closeList();
    renderBoard(-1);
    el.main.scrollTop = 0;
    if (mode === 'daily' && !state.guesses.length) save();   // shows "in progress" on the calendar
    if (state.done) setTimeout(showEnd, 250);
    else el.input.focus();
  }

  /* =========================================================== events */
  el.dailyBtn.addEventListener('click', function () { begin('daily'); });
  el.practiceBtn.addEventListener('click', function () { begin('practice'); });
  el.again.addEventListener('click', function () { begin('practice'); });
  el.boardBtn.addEventListener('click', function () { el.end.hidden = true; });
  el.menuBtn.addEventListener('click', function () { el.end.hidden = true; renderMenu(); el.menu.hidden = false; });
  el.statsClose.addEventListener('click', function () { el.end.hidden = true; });
  el.statsBtn.addEventListener('click', showStats);
  el.menuStats.addEventListener('click', showStats);
  el.share.addEventListener('click', function () {
    copy(shareText()).then(function () {
      el.endNote.className = 'card-note is-ok';
      el.endNote.textContent = 'Results copied to clipboard.';
    }, function () {
      el.endNote.className = 'card-note';
      el.endNote.textContent = shareText().replace(/\n/g, '  ');
    });
  });
  el.units.addEventListener('click', function () {
    try { localStorage.setItem(UNITS_KEY, units() === 'km' ? 'mi' : 'km'); } catch (e) { /* ignore */ }
    el.units.textContent = units();
    if (state) renderBoard(-1);
  });
  el.units.textContent = units();
  function openHowto() { el.howto.hidden = false; el.howtoClose.focus(); }
  el.howtoOpen.addEventListener('click', openHowto);
  el.help.addEventListener('click', openHowto);
  el.howtoClose.addEventListener('click', function () { el.howto.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!el.howto.hidden) el.howto.hidden = true;
    else if (!el.end.hidden) el.end.hidden = true;
  });
  window.addEventListener('dailyarchive:sync', function () { if (!el.menu.hidden) renderMenu(); });

  renderMenu();
  if (ARCHIVE_DAY) begin('daily');

  // Test hook
  window.__compass = { get state() { return state; }, dailyAnswer: dailyAnswer, clue: clue, haversineKm: haversineKm, bearing: bearing, byCode: byCode };
})();

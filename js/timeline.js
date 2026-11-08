/* =============================================================================
 * The Daily Dose — Timeline (timeline.html)
 * -----------------------------------------------------------------------------
 * Five photographs, at least five years apart. Put them in the order they
 * were taken. Each check locks the photos that are in the right place; you
 * get three checks. A photo locked on try 1/2/3 scores 200/100/50.
 *
 * Daily: the same five for everyone on a (local) date, via js/photo-deck.js.
 * Saved per day through js/daily-archive.js as
 *   { date, tries: [[id × 5], …], order: [id × 5], done, won, score, summary, finishedAt }
 * The leaderboard API replays `tries` to score a result, so keep the rules in
 * step with deriveEntry() in functions/api/[[route]].js.
 * ========================================================================== */
(function () {
  'use strict';

  var Deck = window.PhotoDeck;
  var Archive = window.DailyArchive;
  var MAX_TRIES = 3;
  var POINTS = [200, 100, 50];
  var MAX_SCORE = POINTS[0] * Deck.TIMELINE_SIZE;
  var SQUARE = { good: '🟩', bad: '⬛' };

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var el = {
    menu: $('menu'), menuStatus: $('menu-status'), dailyBtn: $('daily-btn'), practiceBtn: $('practice-btn'),
    dailyName: $('daily-name'), dailyDesc: $('daily-desc'), dailyBadge: $('daily-badge'),
    howto: $('howto'), howtoOpen: $('howto-open'), howtoClose: $('howto-close'),
    modeLabel: $('mode-label'), tryNum: $('try-num'), score: $('score'),
    stage: $('stage'), row: $('row'), instr: $('instr'), tries: $('tries'), status: $('status'),
    submit: $('submit'), showResults: $('show-results'),
    end: $('end'), endEyebrow: $('end-eyebrow'), endScore: $('end-score'), endVerdict: $('end-verdict'),
    endSquares: $('end-squares'), endRows: $('end-rows'), endNote: $('end-note'),
    share: $('share-btn'), lbLink: $('lb-link'), again: $('again-btn'), boardBtn: $('board-btn'), menuBtn: $('menu-btn'),
    lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxTitle: $('lightbox-title'),
    lightboxCredit: $('lightbox-credit'), lightboxClose: $('lightbox-close')
  };

  var ARCHIVE_DAY = Archive.requestedDay();
  function dailyDay() { return ARCHIVE_DAY || Archive.today(); }
  function longDate(day) { return Archive.longDate(day); }

  var state = null;
  /*
   * state = {
   *   mode: 'daily' | 'practice', day,
   *   photos: { id: photo }, answer: [id × 5] (oldest first),
   *   order: [id × 5] (the player's current order), tries: [[id × 5]],
   *   locked: { id: try index }, done, won, finishedAt
   * }
   */

  /* ============================================================== rules */
  function lockedFrom(tries, answer) {
    var locked = {};
    tries.forEach(function (t, k) {
      t.forEach(function (id, i) { if (id === answer[i] && locked[id] === undefined) locked[id] = k; });
    });
    return locked;
  }
  function scoreOf(locked) {
    var s = 0;
    for (var id in locked) s += POINTS[locked[id]] || 0;
    return s;
  }
  function allLocked() { return state.answer.every(function (id) { return state.locked[id] !== undefined; }); }

  /** A starting order with at most one photo already in place. */
  function startingOrder(dealt, answer) {
    for (var r = 0; r < dealt.length; r++) {
      var rot = dealt.slice(r).concat(dealt.slice(0, r));
      var right = rot.filter(function (id, i) { return id === answer[i]; }).length;
      if (right <= 1) return rot;
    }
    return dealt.slice().reverse();
  }

  function newGame(mode, day, photos, saved) {
    var byId = {};
    photos.forEach(function (p) { byId[p.id] = p; });
    var answer = photos.slice().sort(function (a, b) { return a.year - b.year; }).map(function (p) { return p.id; });
    var dealt = photos.map(function (p) { return p.id; });
    var valid = function (list) {
      return Array.isArray(list) && list.length === dealt.length && list.every(function (id) { return byId[id]; }) &&
        new Set(list).size === dealt.length;
    };
    var tries = saved && Array.isArray(saved.tries) ? saved.tries.filter(valid).slice(0, MAX_TRIES) : [];
    state = {
      mode: mode, day: day, photos: byId, answer: answer,
      order: saved && valid(saved.order) ? saved.order.slice() : tries.length ? tries[tries.length - 1].slice() : startingOrder(dealt, answer),
      tries: tries, locked: lockedFrom(tries, answer),
      done: false, won: false, finishedAt: saved && saved.finishedAt || null
    };
    // Locked photos always sit in their right place.
    keepLockedInPlace();
    state.won = allLocked();
    state.done = state.won || tries.length >= MAX_TRIES;
  }

  function keepLockedInPlace() {
    var free = state.order.filter(function (id) { return state.locked[id] === undefined; });
    state.order = state.answer.map(function (id) { return state.locked[id] !== undefined ? id : free.shift(); });
  }

  /** Move a photo to another slot; unlocked photos in between shift along. */
  function moveTo(id, slot) {
    if (state.done || state.locked[id] !== undefined) return false;
    var freeSlots = [];
    state.order.forEach(function (x, i) { if (state.locked[x] === undefined) freeSlots.push(i); });
    if (freeSlots.indexOf(slot) === -1) return false;
    var ids = freeSlots.map(function (i) { return state.order[i]; });
    var from = ids.indexOf(id);
    var to = freeSlots.indexOf(slot);
    if (from === to) return false;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    freeSlots.forEach(function (s, k) { state.order[s] = ids[k]; });
    return true;
  }
  function step(id, dir) {
    var i = state.order.indexOf(id);
    for (var j = i + dir; j >= 0 && j < state.order.length; j += dir) {
      if (state.locked[state.order[j]] === undefined) return moveTo(id, j) && j;
    }
    return false;
  }

  /* ============================================================ storage */
  function save() {
    if (state.mode !== 'daily') return;
    if (state.done && !state.finishedAt) state.finishedAt = Date.now();
    var score = scoreOf(state.locked);
    Archive.write('timeline', state.day, {
      date: state.day, tries: state.tries, order: state.order, done: state.done, won: state.won,
      score: score, finishedAt: state.done ? state.finishedAt : null,
      summary: state.done ? fmt(score) + ' pts' : 'Try ' + (state.tries.length + 1) + ' of ' + MAX_TRIES
    });
  }

  /* ============================================================== board */
  var cards = {};   // id -> <li>
  function cardFor(id) {
    if (cards[id]) return cards[id];
    var p = state.photos[id];
    var li = document.createElement('li');
    li.className = 'tl-card';
    li.dataset.id = id;
    li.tabIndex = 0;
    li.innerHTML =
      '<span class="ph"><img alt="" draggable="false" /><span class="ph-broken">Photo unavailable</span></span>' +
      '<button type="button" class="icon-btn tl-zoom" aria-label="View larger"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<span class="tl-points" hidden></span>' +
      '<span class="tl-meta">' +
        '<span class="tl-pos"></span>' +
        '<span class="tl-year"></span>' +
        '<span class="tl-moves">' +
          '<button type="button" class="tl-move" data-dir="-1" aria-label="Move earlier">' +
            '<svg class="h" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<svg class="v" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="tl-move" data-dir="1" aria-label="Move later">' +
            '<svg class="h" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<svg class="v" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
        '</span>' +
      '</span>';
    Deck.setImage(li.querySelector('img'), p, 500);
    li.querySelector('.tl-zoom').addEventListener('click', function (e) { e.stopPropagation(); openLightbox(id); });
    Array.prototype.forEach.call(li.querySelectorAll('.tl-move'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        animate(function () { step(id, Number(b.dataset.dir)); });
        afterMove(id, b.dataset.dir === '-1' ? 'earlier' : 'later');
      });
    });
    li.addEventListener('keydown', function (e) {
      if (e.target !== li) return;
      var dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (dir) { e.preventDefault(); animate(function () { step(id, dir); }); li.focus(); afterMove(id); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(id); }
    });
    attachDrag(li, id);
    cards[id] = li;
    return li;
  }

  function afterMove(id) {
    var pos = state.order.indexOf(id) + 1;
    el.status.textContent = 'Moved to position ' + pos + ' of ' + state.order.length + '.';
    save();
  }

  /** Re-render with a FLIP animation so cards glide to their new places. */
  function animate(change) {
    var before = {};
    state.order.forEach(function (id) { if (cards[id]) before[id] = cards[id].getBoundingClientRect(); });
    change();
    render();
    state.order.forEach(function (id) {
      var c = cards[id], b = before[id];
      if (!c || !b || c.classList.contains('is-dragging')) return;
      var a = c.getBoundingClientRect();
      var dx = b.left - a.left, dy = b.top - a.top;
      if (!dx && !dy) return;
      c.style.transition = 'none';
      c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          c.style.transition = 'transform 0.28s cubic-bezier(.2,.8,.2,1)';
          c.style.transform = '';
          setTimeout(function () { c.style.transition = ''; }, 320);
        });
      });
    });
  }

  function render() {
    var n = state.order.length;
    state.order.forEach(function (id, i) {
      var li = cardFor(id);
      if (el.row.children[i] !== li) el.row.insertBefore(li, el.row.children[i] || null);
      var p = state.photos[id];
      var locked = state.locked[id] !== undefined;
      var missed = state.done && !locked;
      var free = !state.done && !locked;
      li.classList.toggle('is-locked', locked);
      li.classList.toggle('is-missed', missed);
      li.style.cursor = free ? '' : 'default';
      li.querySelector('.tl-pos').textContent = i + 1;
      li.querySelector('.tl-year').textContent = locked || state.done ? p.year : '????';
      var pts = li.querySelector('.tl-points');
      pts.hidden = !state.done;
      pts.textContent = locked ? '+' + POINTS[state.locked[id]] : '0';
      var moves = li.querySelectorAll('.tl-move');
      var canEarlier = false, canLater = false;
      for (var j = 0; j < i; j++) if (state.locked[state.order[j]] === undefined) canEarlier = true;
      for (var k = i + 1; k < n; k++) if (state.locked[state.order[k]] === undefined) canLater = true;
      moves[0].disabled = !free || !canEarlier;
      moves[1].disabled = !free || !canLater;
      li.setAttribute('aria-label', 'Position ' + (i + 1) + ' of ' + n +
        (locked ? ', locked, ' + p.year : state.done ? ', ' + p.year : ', press arrow keys to move, Enter to view larger'));
    });
    var tryShown = Math.min(state.tries.length + (state.done ? 0 : 1), MAX_TRIES);
    el.tryNum.textContent = tryShown;
    el.score.textContent = fmt(scoreOf(state.locked));
    Array.prototype.forEach.call(el.tries.children, function (d, i) { d.classList.toggle('is-used', i < state.tries.length); });
    el.submit.hidden = state.done;
    el.showResults.hidden = !state.done;
    el.instr.textContent = state.done
      ? (state.won ? 'Every photo in its place.' : 'Here’s the right order.') + ' Tap a photo to see it larger.'
      : 'Drag the photographs into the order they were taken, oldest first.';
  }

  function statusText() {
    var right = state.answer.filter(function (id) { return state.locked[id] !== undefined; }).length;
    if (state.done) {
      return state.won
        ? 'Solved on try <b>' + state.tries.length + '</b> · <b>' + fmt(scoreOf(state.locked)) + '</b> points'
        : 'Out of tries · <b>' + fmt(scoreOf(state.locked)) + '</b> points';
    }
    if (!state.tries.length) return 'Try <b>1</b> of ' + MAX_TRIES + '. Right places lock in.';
    var left = MAX_TRIES - state.tries.length;
    return '<b>' + right + ' of ' + state.answer.length + '</b> in place. ' + left + (left === 1 ? ' try' : ' tries') + ' left.';
  }

  /* ============================================================= submit */
  function submit() {
    if (!state || state.done) return;
    var before = Object.keys(state.locked).length;
    state.tries.push(state.order.slice());
    var k = state.tries.length - 1;
    state.order.forEach(function (id, i) { if (id === state.answer[i] && state.locked[id] === undefined) state.locked[id] = k; });
    state.won = allLocked();
    state.done = state.won || state.tries.length >= MAX_TRIES;
    var gained = Object.keys(state.locked).length - before;
    save();
    render();
    // Shake the ones still wrong.
    if (!state.done) {
      state.order.forEach(function (id) {
        if (state.locked[id] !== undefined) return;
        var c = cards[id];
        c.classList.remove('is-shake'); void c.offsetWidth; c.classList.add('is-shake');
      });
    }
    el.status.innerHTML = statusText();
    if (state.done) {
      el.submit.disabled = true;
      setTimeout(function () {
        if (!state.won) animate(function () { state.order = state.answer.slice(); });
        setTimeout(showEnd, state.won ? 500 : 1100);
      }, 500);
    } else if (!gained) {
      el.status.innerHTML = 'None new in place. ' + statusText().replace(/^<b>.*?<\/b> in place\. /, '');
    }
  }

  /* ================================================================ end */
  function showEnd() {
    el.submit.disabled = false;
    var score = scoreOf(state.locked);
    el.endEyebrow.textContent = state.mode === 'daily'
      ? 'Timeline #' + Deck.dailyNumber(state.day) + ' · ' + longDate(state.day)
      : 'Practice';
    el.endScore.textContent = fmt(score);
    el.endVerdict.textContent = score === MAX_SCORE ? 'A perfect timeline, first time.'
      : state.won ? 'Solved on try ' + state.tries.length + '.'
      : 'Out of tries: ' + Object.keys(state.locked).length + ' of ' + state.answer.length + ' in place.';
    el.endSquares.innerHTML = state.tries.map(function (t) {
      return '<div class="squares-row">' + t.map(function (id, i) {
        return '<span class="sq ' + (id === state.answer[i] ? 'is-good' : '') + '"></span>';
      }).join('') + '</div>';
    }).join('');
    el.endSquares.setAttribute('aria-label', state.tries.map(function (t, k) {
      return 'Try ' + (k + 1) + ': ' + t.filter(function (id, i) { return id === state.answer[i]; }).length + ' in place';
    }).join(', '));
    el.endRows.innerHTML = '';
    state.answer.forEach(function (id) {
      var p = state.photos[id];
      var tr = document.createElement('tr');
      var pts = state.locked[id] !== undefined ? POINTS[state.locked[id]] : 0;
      tr.innerHTML = '<td class="thumb"><span class="ph"><img alt="" /></span></td>' +
        '<td class="yr">' + p.year + '</td>' +
        '<td class="desc"></td>' +
        '<td class="num"><b>' + pts + '</b></td>';
      var desc = tr.querySelector('.desc');
      if (p.source) {
        var a = document.createElement('a');
        a.href = p.source; a.target = '_blank'; a.rel = 'noopener'; a.textContent = p.description;
        desc.appendChild(a);
      } else desc.textContent = p.description;
      Deck.setImage(tr.querySelector('img'), p, 250);
      tr.querySelector('.thumb').addEventListener('click', function () { openLightbox(id); });
      el.endRows.appendChild(tr);
    });
    var daily = state.mode === 'daily';
    el.share.hidden = !daily;
    el.lbLink.hidden = !daily;
    el.lbLink.href = './leaderboard.html?game=timeline&day=' + state.day;
    el.again.textContent = daily ? 'Practice' : 'Play again';
    el.endNote.className = 'card-note';
    el.endNote.textContent = !daily ? '' : ARCHIVE_DAY
      ? 'Missed other days? Open the calendar on the home page.'
      : 'Next Timeline in ' + Archive.timeToNext() + '.';
    el.end.hidden = false;
    (daily ? el.share : el.again).focus({ preventScroll: true });
  }

  function shareText() {
    return 'Timeline #' + Deck.dailyNumber(state.day) + ' · ' + fmt(scoreOf(state.locked)) + '/' + fmt(MAX_SCORE) + '\n' +
      state.tries.map(function (t) {
        return t.map(function (id, i) { return id === state.answer[i] ? SQUARE.good : SQUARE.bad; }).join('');
      }).join('\n') + '\n' + location.origin + location.pathname;
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

  /* =========================================================== lightbox */
  var lastFocus = null;
  function openLightbox(id) {
    var p = state.photos[id];
    var known = state.done || state.locked[id] !== undefined;
    lastFocus = document.activeElement;
    Deck.setImage(el.lightboxImg, p, 1280);
    el.lightboxTitle.innerHTML = known ? '<b>' + p.year + '</b> · ' : '';
    el.lightboxTitle.appendChild(document.createTextNode(known ? p.description : 'Position ' + (state.order.indexOf(id) + 1) + ' of ' + state.order.length));
    el.lightboxCredit.textContent = p.credit ? 'Photo: ' + p.credit + (p.source ? ' ↗' : '') : '';
    if (p.source) el.lightboxCredit.href = p.source; else el.lightboxCredit.removeAttribute('href');
    el.lightbox.hidden = false;
    el.lightboxClose.focus();
  }
  function closeLightbox() {
    el.lightbox.hidden = true;
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }

  /* =============================================================== drag */
  function attachDrag(li, id) {
    var start = null, dragging = false, target = null, pointerId = null;
    li.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      // On touch screens, drag from the photo so the rest of the card still scrolls the page.
      if (e.pointerType !== 'mouse' && !e.target.closest('.ph')) return;
      start = { x: e.clientX, y: e.clientY };
      pointerId = e.pointerId;
      dragging = false;
    });
    li.addEventListener('pointermove', function (e) {
      if (!start || e.pointerId !== pointerId) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) + Math.abs(dy) < 8) return;
        if (state.done || state.locked[id] !== undefined) { start = null; return; }
        dragging = true;
        try { li.setPointerCapture(pointerId); } catch (err) { /* ignore */ }
        li.classList.add('is-dragging');
      }
      e.preventDefault();
      li.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      var t = slotAt(e.clientX, e.clientY, id);
      if (t !== target) {
        if (target !== null) cards[state.order[target]].classList.remove('is-target');
        target = t;
        if (target !== null) cards[state.order[target]].classList.add('is-target');
      }
    });
    function end(e) {
      if (!start || (e && e.pointerId !== pointerId)) return;
      var wasDragging = dragging;
      start = null; dragging = false;
      if (target !== null) cards[state.order[target]].classList.remove('is-target');
      if (!wasDragging) { if (e && e.type === 'pointerup') openLightbox(id); return; }
      // Glide from where it was dropped to its new place.
      var dropped = li.getBoundingClientRect();
      li.classList.remove('is-dragging');
      li.style.transform = '';
      var slot = target;
      target = null;
      animate(function () { if (slot !== null) moveTo(id, slot); });
      var now = li.getBoundingClientRect();
      li.style.transition = 'none';
      li.style.transform = 'translate(' + (dropped.left - now.left) + 'px,' + (dropped.top - now.top) + 'px)';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          li.style.transition = 'transform 0.22s cubic-bezier(.2,.8,.2,1)';
          li.style.transform = '';
          setTimeout(function () { li.style.transition = ''; }, 260);
        });
      });
      if (slot !== null) afterMove(id);
    }
    li.addEventListener('pointerup', end);
    li.addEventListener('pointercancel', function (e) {
      if (!start) return;
      start = null; dragging = false; li.classList.remove('is-dragging'); li.style.transform = '';
      if (target !== null) cards[state.order[target]].classList.remove('is-target');
      target = null;
    });
  }
  /** The free slot under a point (or nearest to it), other than the dragged card's own. */
  function slotAt(x, y, dragId) {
    var best = null, bestD = Infinity;
    state.order.forEach(function (id, i) {
      if (id === dragId || state.locked[id] !== undefined) return;
      var r = cards[id].getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      var d = inside ? 0 : Math.hypot(x - cx, y - cy);
      if (d < bestD) { bestD = d; best = i; }
    });
    var own = cards[dragId].getBoundingClientRect();
    // Only snap when the pointer is over (or close to) a card.
    var reach = Math.max(own.width, own.height) * 0.75;
    return bestD <= reach ? best : null;
  }

  /* =============================================================== menu */
  function renderMenu() {
    var day = dailyDay();
    var rec = Archive.read('timeline', day);
    el.dailyName.textContent = ARCHIVE_DAY ? 'Daily #' + Deck.dailyNumber(day) : 'Daily';
    el.dailyBadge.hidden = !rec && !ARCHIVE_DAY;
    el.dailyBadge.textContent = rec && rec.done ? (ARCHIVE_DAY ? '✓ ' : 'Today: ') + rec.summary : rec ? 'In progress' : 'Archive';
    el.dailyDesc.textContent = ARCHIVE_DAY
      ? longDate(day) + (rec && rec.done ? '. See your result' : ': the five everyone got that day')
      : rec && rec.done ? 'Played today. See your result' : rec ? 'Pick up where you left off' : 'Today’s five: the same for everyone';
  }

  function setBusy(busy, msg) {
    el.dailyBtn.disabled = busy;
    el.practiceBtn.disabled = busy;
    el.menuStatus.textContent = msg || '';
  }

  function begin(mode) {
    setBusy(true, 'Finding photographs…');
    var day = dailyDay();
    var load = mode === 'daily' ? Deck.dailyPool('timeline', day) : Deck.randomPool();
    load.then(function (pool) {
      var photos = Deck.pickTimeline(pool);
      if (photos.length < Deck.TIMELINE_SIZE) {
        setBusy(false, 'Couldn’t load the photographs. Check your connection and try again.');
        return;
      }
      setBusy(false, '');
      newGame(mode, day, photos, mode === 'daily' ? Archive.read('timeline', day) : null);
      cards = {};
      el.row.textContent = '';
      el.end.hidden = true;
      el.menu.hidden = true;
      el.modeLabel.hidden = false;
      el.modeLabel.textContent = mode === 'daily' ? 'Daily #' + Deck.dailyNumber(day) : 'Practice';
      render();
      el.status.innerHTML = statusText();
      if (mode === 'daily' && !state.tries.length) save();   // shows "in progress" on the calendar
      if (state.done) setTimeout(showEnd, 300);
      else if (cards[state.order[0]]) cards[state.order[0]].focus({ preventScroll: true });
    }, function () {
      setBusy(false, 'Couldn’t load the photographs. Check your connection and try again.');
    });
  }

  /** Photo backgrounds for the two menu cards (never today's daily photos). */
  function decorateMenu() {
    Deck.randomPool().then(function (pool) {
      Deck.dailyPool('timeline', dailyDay()).then(function (daily) {
        var avoid = {};
        Deck.pickTimeline(daily).forEach(function (p) { avoid[p.id] = true; });
        var picks = pool.filter(function (p) { return !avoid[p.id]; }).slice(0, 2);
        [el.dailyBtn, el.practiceBtn].forEach(function (btn, i) {
          if (picks[i]) Deck.setImage(btn.querySelector('img'), picks[i], 960);
        });
      });
    });
  }

  /* ============================================================= events */
  el.dailyBtn.addEventListener('click', function () { begin('daily'); });
  el.practiceBtn.addEventListener('click', function () { begin('practice'); });
  el.submit.addEventListener('click', submit);
  el.showResults.addEventListener('click', showEnd);
  el.again.addEventListener('click', function () { el.end.hidden = true; begin('practice'); });
  el.boardBtn.addEventListener('click', function () { el.end.hidden = true; el.showResults.focus(); });
  el.menuBtn.addEventListener('click', function () { el.end.hidden = true; renderMenu(); el.menu.hidden = false; });
  el.share.addEventListener('click', function () {
    copy(shareText()).then(function () {
      el.endNote.className = 'card-note is-ok';
      el.endNote.textContent = 'Result copied to clipboard.';
    }, function () {
      el.endNote.className = 'card-note';
      el.endNote.textContent = shareText().replace(/\n/g, '  ');
    });
  });
  el.howtoOpen.addEventListener('click', function () { el.howto.hidden = false; el.howtoClose.focus(); });
  el.howtoClose.addEventListener('click', function () { el.howto.hidden = true; el.howtoOpen.focus(); });
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', function (e) { if (e.target === el.lightbox) closeLightbox(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!el.lightbox.hidden) closeLightbox();
    else if (!el.howto.hidden) { el.howto.hidden = true; el.howtoOpen.focus(); }
    else if (!el.end.hidden) el.end.hidden = true;
  });
  window.addEventListener('dailyarchive:sync', function () { if (!el.menu.hidden) renderMenu(); });

  renderMenu();
  decorateMenu();
  // Opened from the archive calendar (?date=…): go straight to that day.
  if (ARCHIVE_DAY) begin('daily');

  // Test hook
  window.__timeline = { get state() { return state; }, begin: begin };
})();

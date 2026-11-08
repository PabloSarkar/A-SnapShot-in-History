/* =============================================================================
 * The Daily Dose — Older or Newer (oldernewer.html)
 * -----------------------------------------------------------------------------
 * A known photo (year shown) and the next one (year hidden): was the next one
 * taken earlier or later? Right answers build a streak; the first wrong one
 * ends the run. Consecutive photos are always at least three years apart.
 *
 * Daily: the same run of 50 photos (49 calls) for everyone on a (local) date,
 * via js/photo-deck.js. Saved per day through js/daily-archive.js as
 *   { date, answers: 'onno…' (o = older, n = newer), done, score, summary, finishedAt }
 * The leaderboard API replays `answers` to score a result.
 * ========================================================================== */
(function () {
  'use strict';

  var Deck = window.PhotoDeck;
  var Archive = window.DailyArchive;
  var PRACTICE_SIZE = 400;
  var BEST_KEY = 'oldernewer.best';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    menu: $('menu'), menuStatus: $('menu-status'), dailyBtn: $('daily-btn'), practiceBtn: $('practice-btn'),
    dailyName: $('daily-name'), dailyDesc: $('daily-desc'), dailyBadge: $('daily-badge'), practiceDesc: $('practice-desc'),
    howto: $('howto'), howtoOpen: $('howto-open'), howtoClose: $('howto-close'),
    modeLabel: $('mode-label'), streak: $('streak'), best: $('best'), bestLabel: $('best-label'),
    known: $('known'), knownImg: $('known-img'), knownYear: $('known-year'), knownDesc: $('known-desc'), knownCredit: $('known-credit'),
    next: $('next'), nextImg: $('next-img'), prompt: $('prompt'), ask: $('ask'), older: $('older-btn'), newer: $('newer-btn'),
    reveal: $('reveal'), nextYear: $('next-year'), nextDelta: $('next-delta'), progress: $('progress'),
    end: $('end'), endEyebrow: $('end-eyebrow'), endScore: $('end-score'), endVerdict: $('end-verdict'),
    endSquares: $('end-squares'), endRows: $('end-rows'), endMissTable: $('end-miss-table'), endNote: $('end-note'),
    share: $('share-btn'), lbLink: $('lb-link'), again: $('again-btn'), menuBtn: $('menu-btn'),
    lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxTitle: $('lightbox-title'),
    lightboxCredit: $('lightbox-credit'), lightboxClose: $('lightbox-close')
  };

  var ARCHIVE_DAY = Archive.requestedDay();
  function dailyDay() { return ARCHIVE_DAY || Archive.today(); }

  var state = null;
  /* state = { mode, day, seq: [photo], i (index of the known photo), answers: '', score, done, phase, finishedAt } */

  function readBest() { try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { return 0; } }
  function writeBest(n) { try { localStorage.setItem(BEST_KEY, String(n)); } catch (e) { /* private mode */ } }

  /** Which way the next photo really is: 'n' newer or 'o' older. */
  function truth(k) { return state.seq[k + 1].year > state.seq[k].year ? 'n' : 'o'; }

  function newGame(mode, day, seq, saved) {
    state = { mode: mode, day: day, seq: seq, i: 0, answers: '', score: 0, done: false, phase: 'ask', finishedAt: null, missed: false };
    var answers = saved && typeof saved.answers === 'string' ? saved.answers : '';
    // Replay a saved daily run.
    for (var k = 0; k < answers.length && !state.done; k++) {
      var a = answers[k];
      if (a !== 'o' && a !== 'n') break;
      state.answers += a;
      if (a === truth(state.i)) { state.score++; state.i++; if (state.i >= seq.length - 1) state.done = true; }
      else { state.done = true; state.missed = true; }
    }
    if (state.done) { state.phase = 'over'; state.finishedAt = saved.finishedAt || null; }
  }

  function save() {
    if (state.mode !== 'daily') return;
    if (state.done && !state.finishedAt) state.finishedAt = Date.now();
    Archive.write('oldernewer', state.day, {
      date: state.day, answers: state.answers, done: state.done, score: state.score,
      finishedAt: state.done ? state.finishedAt : null,
      summary: state.done ? state.score + ' in a row' : 'Streak ' + state.score
    });
  }

  /* ============================================================= render */
  function credit(a, p) {
    a.textContent = p.credit ? p.credit + (p.source ? ' ↗' : '') : '';
    if (p.source) a.href = p.source; else a.removeAttribute('href');
  }

  function render() {
    var known = state.seq[state.i], next = state.seq[state.i + 1];
    Deck.setImage(el.knownImg, known, 960);
    el.knownYear.textContent = known.year;
    el.knownDesc.textContent = known.description;
    el.knownDesc.title = known.description;
    credit(el.knownCredit, known);
    if (next) {
      Deck.setImage(el.nextImg, next, 960);
      // Load the photo after this one too, so the next round appears instantly.
      if (state.seq[state.i + 2]) Deck.preload(state.seq[state.i + 2], 960);
    }
    el.prompt.innerHTML = 'Was this taken before or after <b>' + known.year + '</b>?';
    el.next.classList.remove('is-right', 'is-wrong');
    el.ask.hidden = false;
    el.prompt.hidden = false;
    el.reveal.hidden = true;
    el.older.disabled = el.newer.disabled = state.phase !== 'ask';
    renderStats();
  }

  function renderStats() {
    el.streak.textContent = state.score;
    if (state.mode === 'practice') el.best.textContent = Math.max(readBest(), state.score);
    else el.best.textContent = Math.max(0, state.seq.length - 1 - state.answers.length);
    var calls = state.seq.length - 1;
    el.progress.innerHTML = state.mode === 'daily'
      ? 'Call <b>' + Math.min(state.answers.length + 1, calls) + '</b> of ' + calls
      : state.score ? 'Streak <b>' + state.score + '</b>. Keep it going.' : 'One wrong call ends the run.';
  }

  /* ============================================================= answer */
  function answer(dir) {
    if (!state || state.phase !== 'ask') return;
    state.phase = 'reveal';
    var known = state.seq[state.i], next = state.seq[state.i + 1];
    var right = dir === truth(state.i);
    state.answers += dir;
    if (right) state.score++;
    else { state.done = true; state.missed = true; }
    if (right && state.i + 1 >= state.seq.length - 1) state.done = true;   // ran out of photos: a perfect run
    if (state.mode === 'practice' && state.score > readBest()) writeBest(state.score);
    save();

    el.older.disabled = el.newer.disabled = true;
    el.ask.hidden = true;
    el.prompt.hidden = true;
    el.reveal.hidden = false;
    var diff = next.year - known.year;
    el.nextDelta.textContent = Math.abs(diff) + (Math.abs(diff) === 1 ? ' year ' : ' years ') + (diff > 0 ? 'newer' : 'older') +
      (right ? ' · correct' : ' · not quite');
    countUp(el.nextYear, known.year, next.year, 550);
    el.next.classList.add(right ? 'is-right' : 'is-wrong');
    renderStats();

    if (state.done) {
      state.phase = 'over';
      setTimeout(showEnd, right ? 900 : 1500);
    } else {
      setTimeout(advance, 1250);
    }
  }

  function countUp(node, from, to, ms) {
    var t0 = performance.now();
    (function frame(t) {
      var k = Math.min(1, (t - t0) / ms);
      var e = 1 - Math.pow(1 - k, 3);
      node.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(frame);
    })(t0);
  }

  function advance() {
    el.known.classList.add('is-out');
    el.next.classList.add('is-out');
    setTimeout(function () {
      state.i++;
      state.phase = 'ask';
      render();
      el.known.classList.remove('is-out');
      el.next.classList.remove('is-out');
      if (document.activeElement === document.body || !document.activeElement || document.activeElement.disabled) el.newer.focus({ preventScroll: true });
    }, 230);
  }

  /* ================================================================ end */
  function squaresHtml() {
    var cells = [];
    for (var k = 0; k < state.answers.length; k++) cells.push(k < state.score ? 'is-good' : 'is-bad');
    var rows = [];
    for (var r = 0; r < cells.length; r += 10) {
      rows.push('<div class="squares-row">' + cells.slice(r, r + 10).map(function (c) { return '<span class="sq ' + c + '"></span>'; }).join('') + '</div>');
    }
    return rows.join('');
  }

  function showEnd() {
    var daily = state.mode === 'daily';
    var calls = state.seq.length - 1;
    el.endEyebrow.textContent = daily
      ? 'Older or Newer #' + Deck.dailyNumber(state.day) + ' · ' + Archive.longDate(state.day)
      : 'Practice';
    el.endScore.textContent = state.score;
    el.endVerdict.textContent = !state.missed
      ? 'A perfect run: all ' + calls + ' calls right.'
      : state.score === 0 ? 'Tripped at the first one.'
      : !daily && state.score >= readBest() ? 'A new personal best.'
      : 'Your run ended on call ' + (state.score + 1) + '.';
    el.endSquares.innerHTML = squaresHtml();
    el.endSquares.setAttribute('aria-label', state.score + ' right' + (state.missed ? ', then a miss' : ''));
    el.endRows.innerHTML = '';
    el.endMissTable.hidden = !state.missed;
    if (state.missed) {
      var k = state.answers.length - 1;
      [state.seq[k], state.seq[k + 1]].forEach(function (p, j) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td class="thumb"><span class="ph"><img alt="" /></span></td>' +
          '<td class="small-print">' + (j ? 'You said ' + (state.answers[k] === 'n' ? 'newer' : 'older') : 'Known') + '</td>' +
          '<td class="desc"></td><td class="num yr">' + p.year + '</td>';
        var desc = tr.querySelector('.desc');
        if (p.source) {
          var a = document.createElement('a');
          a.href = p.source; a.target = '_blank'; a.rel = 'noopener'; a.textContent = p.description;
          desc.appendChild(a);
        } else desc.textContent = p.description;
        Deck.setImage(tr.querySelector('img'), p, 250);
        tr.querySelector('.thumb').addEventListener('click', function () { openLightbox(p, true); });
        el.endRows.appendChild(tr);
      });
    }
    el.share.hidden = !daily;
    el.lbLink.hidden = !daily;
    el.lbLink.href = './leaderboard.html?game=oldernewer&day=' + state.day;
    el.again.textContent = daily ? 'Practice' : 'Play again';
    el.endNote.className = 'card-note';
    el.endNote.textContent = !daily ? 'Best: ' + readBest() + ' in a row.' : ARCHIVE_DAY
      ? 'Missed other days? Open the calendar on the home page.'
      : 'Next daily run in ' + Archive.timeToNext() + '.';
    el.end.hidden = false;
    (daily ? el.share : el.again).focus({ preventScroll: true });
  }

  function shareText() {
    var rows = [];
    for (var r = 0; r < state.answers.length; r += 10) {
      var row = '';
      for (var k = r; k < Math.min(r + 10, state.answers.length); k++) row += k < state.score ? '🟩' : '🟥';
      rows.push(row);
    }
    return 'Older or Newer #' + Deck.dailyNumber(state.day) + ' · ' + state.score + ' in a row' + (state.missed ? '' : ' (perfect)') + '\n' +
      rows.join('\n') + '\n' + location.origin + location.pathname;
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
  function openLightbox(p, known) {
    lastFocus = document.activeElement;
    Deck.setImage(el.lightboxImg, p, 1280);
    el.lightboxTitle.innerHTML = known ? '<b>' + p.year + '</b> · ' : '';
    el.lightboxTitle.appendChild(document.createTextNode(known ? p.description : 'Older or newer than ' + state.seq[state.i].year + '?'));
    el.lightboxCredit.textContent = p.credit ? 'Photo: ' + p.credit + (p.source ? ' ↗' : '') : '';
    if (p.source) el.lightboxCredit.href = p.source; else el.lightboxCredit.removeAttribute('href');
    el.lightbox.hidden = false;
    el.lightboxClose.focus();
  }
  function closeLightbox() {
    el.lightbox.hidden = true;
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }

  /* =============================================================== menu */
  function renderMenu() {
    var day = dailyDay();
    var rec = Archive.read('oldernewer', day);
    el.dailyName.textContent = ARCHIVE_DAY ? 'Daily #' + Deck.dailyNumber(day) : 'Daily';
    el.dailyBadge.hidden = !rec && !ARCHIVE_DAY;
    el.dailyBadge.textContent = rec && rec.done ? (ARCHIVE_DAY ? '✓ ' : 'Today: ') + rec.summary : rec ? 'In progress' : 'Archive';
    el.dailyDesc.textContent = ARCHIVE_DAY
      ? Archive.longDate(day) + (rec && rec.done ? '. See your result' : ': the run everyone got that day')
      : rec && rec.done ? 'Played today. See your result' : rec ? 'Pick up where you left off' : 'Today’s run: the same photos for everyone';
    var best = readBest();
    el.practiceDesc.textContent = best ? 'An endless run of random photographs. Best: ' + best : 'An endless run of random photographs';
  }

  function setBusy(busy, msg) {
    el.dailyBtn.disabled = busy;
    el.practiceBtn.disabled = busy;
    el.menuStatus.textContent = msg || '';
  }

  function begin(mode) {
    setBusy(true, 'Finding photographs…');
    var day = dailyDay();
    var load = mode === 'daily' ? Deck.dailyPool('oldernewer', day) : Deck.randomPool();
    load.then(function (pool) {
      var seq = Deck.pickSequence(pool, mode === 'daily' ? Deck.SEQUENCE_SIZE : PRACTICE_SIZE);
      if (seq.length < 10) {
        setBusy(false, 'Couldn’t load the photographs. Check your connection and try again.');
        return;
      }
      setBusy(false, '');
      newGame(mode, day, seq, mode === 'daily' ? Archive.read('oldernewer', day) : null);
      el.end.hidden = true;
      el.menu.hidden = true;
      el.modeLabel.hidden = false;
      el.modeLabel.textContent = mode === 'daily' ? 'Daily #' + Deck.dailyNumber(day) : 'Practice';
      el.bestLabel.textContent = mode === 'daily' ? 'Left' : 'Best';
      if (state.done) {
        // Finished already: show where the run ended.
        state.i = Math.max(0, state.answers.length - 1);
        render();
        el.ask.hidden = true; el.prompt.hidden = true; el.reveal.hidden = false;
        var known = state.seq[state.i], next = state.seq[state.i + 1];
        el.nextYear.textContent = next.year;
        el.nextDelta.textContent = Math.abs(next.year - known.year) + ' years ' + (next.year > known.year ? 'newer' : 'older');
        el.next.classList.add(state.missed ? 'is-wrong' : 'is-right');
        setTimeout(showEnd, 300);
        return;
      }
      if (mode === 'daily' && !state.answers) save();   // shows "in progress" on the calendar
      render();
      el.newer.focus({ preventScroll: true });
    }, function () {
      setBusy(false, 'Couldn’t load the photographs. Check your connection and try again.');
    });
  }

  function decorateMenu() {
    Deck.randomPool().then(function (pool) {
      Deck.dailyPool('oldernewer', dailyDay()).then(function (daily) {
        var avoid = {};
        Deck.pickSequence(daily).forEach(function (p) { avoid[p.id] = true; });
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
  el.older.addEventListener('click', function () { answer('o'); });
  el.newer.addEventListener('click', function () { answer('n'); });
  el.again.addEventListener('click', function () { el.end.hidden = true; begin('practice'); });
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
  Array.prototype.forEach.call(document.querySelectorAll('.on-zoom'), function (b) {
    b.addEventListener('click', function () {
      if (!state) return;
      var nextKnown = state.phase !== 'ask';
      if (b.dataset.side === 'known') openLightbox(state.seq[state.i], true);
      else if (state.seq[state.i + 1]) openLightbox(state.seq[state.i + 1], nextKnown);
    });
  });
  el.howtoOpen.addEventListener('click', function () { el.howto.hidden = false; el.howtoClose.focus(); });
  el.howtoClose.addEventListener('click', function () { el.howto.hidden = true; el.howtoOpen.focus(); });
  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', function (e) { if (e.target === el.lightbox) closeLightbox(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!el.lightbox.hidden) closeLightbox();
      else if (!el.howto.hidden) { el.howto.hidden = true; el.howtoOpen.focus(); }
      else if (!el.end.hidden) el.end.hidden = true;
      return;
    }
    if (!el.menu.hidden || !el.end.hidden || !el.lightbox.hidden || !el.howto.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'o') { e.preventDefault(); answer('o'); }
    else if (k === 'arrowright' || k === 'n') { e.preventDefault(); answer('n'); }
  });
  window.addEventListener('dailyarchive:sync', function () { if (!el.menu.hidden) renderMenu(); });

  renderMenu();
  decorateMenu();
  if (ARCHIVE_DAY) begin('daily');

  window.__oldernewer = { get state() { return state; }, begin: begin };
})();

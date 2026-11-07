/* =============================================================================
 * The Daily Dose — archive calendar on the hub (index.html)
 * The date pill opens a month calendar of every daily challenge since launch.
 * Each day shows one dot per daily game (filled = played, half = in progress,
 * empty = not played); choosing a day lists the games with a link to play,
 * continue or view that day's challenge. Data comes from js/daily-archive.js.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.DailyArchive;
  if (!A) return;

  function $(id) { return document.getElementById(id); }
  var el = {
    pill: $('hub-date'), day: $('hub-day'), month: $('hub-month'), panel: $('archive'),
    title: $('cal-title'), prev: $('cal-prev'), next: $('cal-next'), grid: $('cal-grid'),
    dayTitle: $('cal-day-title'), games: $('cal-games')
  };
  if (!el.pill || !el.panel) return;

  var today = A.today();
  var selected = today;
  var view = today.slice(0, 7);        // "YYYY-MM" being shown

  // Pill shows today's (UTC) date: the day the daily challenges belong to.
  el.day.textContent = String(+today.slice(8, 10));
  el.month.textContent = new Date(today + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  el.pill.setAttribute('aria-label', 'Today, ' + A.longDate(today) + '. Open the daily challenge archive');

  function monthLabel(ym) {
    return new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  function shiftMonth(ym, delta) {
    var d = new Date(ym + '-15T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + delta);
    return d.toISOString().slice(0, 7);
  }
  function inRange(day) { return day >= A.LAUNCH && day <= today; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function dayStatuses(day) {
    return A.GAMES.map(function (g) { return { game: g, st: A.status(g.id, day) }; });
  }

  /* ------------------------------------------------------------- grid */
  function renderGrid() {
    el.title.textContent = monthLabel(view);
    el.prev.disabled = view <= A.LAUNCH.slice(0, 7);
    el.next.disabled = view >= today.slice(0, 7);

    var first = view + '-01';
    var lead = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;   // Monday-first
    var days = new Date(Date.UTC(+view.slice(0, 4), +view.slice(5, 7), 0)).getUTCDate();
    var html = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(function (d) { return '<span class="cal-wd" aria-hidden="true">' + d + '</span>'; }).join('');
    for (var i = 0; i < lead; i++) html += '<span class="cal-blank" aria-hidden="true"></span>';
    for (var n = 1; n <= days; n++) {
      var day = view + '-' + (n < 10 ? '0' : '') + n;
      if (!inRange(day)) { html += '<span class="cal-cell is-out" aria-hidden="true">' + n + '</span>'; continue; }
      var sts = dayStatuses(day);
      var played = sts.filter(function (s) { return s.st.state === 'done'; }).length;
      var dots = sts.map(function (s) { return '<i class="dot is-' + s.st.state + '"></i>'; }).join('');
      var label = A.longDate(day) + (day === today ? ', today' : '') + ': ' + played + ' of ' + sts.length + ' played';
      html += '<button type="button" class="cal-cell' + (day === today ? ' is-today' : '') + (day === selected ? ' is-selected' : '') +
        (played === sts.length ? ' is-complete' : '') + '" data-day="' + day + '" aria-label="' + esc(label) + '" aria-pressed="' + (day === selected) + '"' +
        ' tabindex="' + (day === selected ? 0 : -1) + '">' +
        '<span class="cal-num">' + n + '</span><span class="cal-dots" aria-hidden="true">' + dots + '</span></button>';
    }
    el.grid.innerHTML = html;
  }

  /* --------------------------------------------------------- day detail */
  function renderDay() {
    el.dayTitle.textContent = A.longDate(selected, true) + (selected === today ? ' · Today' : '');
    el.games.innerHTML = dayStatuses(selected).map(function (s) {
      var st = s.st.state;
      var text = st === 'done' ? 'Played' + (s.st.summary ? ' · ' + s.st.summary : '') : st === 'progress' ? 'In progress' : 'Not played';
      var action = st === 'done' ? 'View result' : st === 'progress' ? 'Continue' : 'Play';
      return '<li class="cal-game is-' + st + '">' +
        '<span class="cal-game-name"><i class="dot is-' + st + '" aria-hidden="true"></i>' + esc(s.game.name) + '</span>' +
        '<span class="cal-game-status">' + esc(text) + '</span>' +
        '<a class="cal-play' + (st === 'done' ? ' is-secondary' : '') + '" href="' + esc(A.urlFor(s.game.id, selected)) + '"' +
        ' aria-label="' + esc(action + ': ' + s.game.name + ', ' + A.longDate(selected)) + '">' + action + '</a></li>';
    }).join('');
  }

  function select(day, focus) {
    if (!inRange(day)) return;
    selected = day;
    view = day.slice(0, 7);
    renderGrid();
    renderDay();
    if (focus) { var b = el.grid.querySelector('[data-day="' + day + '"]'); if (b) b.focus(); }
  }

  /* ------------------------------------------------------- open / close */
  function open() {
    el.panel.hidden = false;
    el.pill.setAttribute('aria-expanded', 'true');
    select(selected, false);
    var b = el.grid.querySelector('[data-day="' + selected + '"]');
    if (b) b.focus({ preventScroll: true });
  }
  function close(returnFocus) {
    if (el.panel.hidden) return;
    el.panel.hidden = true;
    el.pill.setAttribute('aria-expanded', 'false');
    if (returnFocus) el.pill.focus();
  }

  el.pill.addEventListener('click', function () { el.panel.hidden ? open() : close(false); });
  el.prev.addEventListener('click', function () { view = shiftMonth(view, -1); renderGrid(); });
  el.next.addEventListener('click', function () { view = shiftMonth(view, 1); renderGrid(); });
  el.grid.addEventListener('click', function (e) {
    var b = e.target.closest('[data-day]');
    if (b) select(b.dataset.day, true);
  });
  // Arrow keys move between days (wrapping across months), Home/End to week ends.
  el.grid.addEventListener('keydown', function (e) {
    var b = e.target.closest('[data-day]');
    if (!b) return;
    var step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    var target = A.shiftDay(b.dataset.day, step);
    if (target < A.LAUNCH) target = A.LAUNCH;
    if (target > today) target = today;
    select(target, true);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(true); });
  // Close on clicks outside. Use the event path, not e.target: choosing a day
  // re-renders the grid, so the clicked button is already detached by now.
  document.addEventListener('click', function (e) {
    if (el.panel.hidden) return;
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (path.indexOf(el.panel) === -1 && path.indexOf(el.pill) === -1) close(false);
  });
  // Refresh when results arrive from the account (another device) or another tab.
  window.addEventListener('dailyarchive:sync', function () { if (!el.panel.hidden) { renderGrid(); renderDay(); } });
  // Keep dots fresh if a game was played in another tab.
  window.addEventListener('storage', function (e) {
    if (!el.panel.hidden && e.key && e.key.indexOf('dailies.') === 0) { renderGrid(); renderDay(); }
  });

  // Games link to ./#archive ("Missed a day?").
  if (location.hash === '#archive') {
    open();
    el.pill.scrollIntoView({ block: 'start' });
  }
})();

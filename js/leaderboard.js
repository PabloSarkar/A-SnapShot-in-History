/* =============================================================================
 * The Daily Dose — leaderboards page (leaderboard.html)
 * -----------------------------------------------------------------------------
 * Reads /api/leaderboard (functions/api/[[route]].js):
 *   ?type=daily&game=<id>&day=YYYY-MM-DD
 *   ?type=alltime&game=<id|all>&metric=<stat>
 * and draws the top 50, plus the signed-in player's own row if they're further
 * down. The current view lives in the URL, so a game's results screen can link
 * straight to e.g. leaderboard.html?game=pinpoint&day=2026-11-08.
 * ========================================================================== */
(function () {
  'use strict';

  var Account = window.SnapshotAccount;
  var Archive = window.DailyArchive;

  var GAMES = [
    { id: 'snapshot', name: 'Snapshot', max: 50000 },
    { id: 'pinpoint', name: 'Pinpoint', max: 10000 },
    { id: 'outline', name: 'Outline' },
    { id: 'all', name: 'All games', allTimeOnly: true }
  ];

  // All-time stats per game. `sub` is the second column ("Games" by default).
  var POINTS = [
    { id: 'total', name: 'Total points', col: 'Points' },
    { id: 'average', name: 'Average score', col: 'Average', note: 'Players with at least 3 dailies.' },
    { id: 'best', name: 'Best score', col: 'Best' },
    { id: 'played', name: 'Games played', col: 'Played', noSub: true },
    { id: 'streak', name: 'Current streak', col: 'Days', note: 'Days in a row, still going.' },
    { id: 'longest', name: 'Longest streak', col: 'Days', note: 'Most days in a row, ever.' }
  ];
  var METRICS = {
    snapshot: POINTS,
    pinpoint: POINTS,
    outline: [
      { id: 'wins', name: 'Wins', col: 'Wins' },
      { id: 'winrate', name: 'Win rate', col: 'Win rate', pct: true, note: 'Players with at least 5 dailies.' },
      { id: 'avgguesses', name: 'Avg guesses', col: 'Guesses', dec: true, note: 'Average guesses in a win. Players with at least 3 wins. Lower is better.' },
      { id: 'played', name: 'Games played', col: 'Played', noSub: true },
      { id: 'streak', name: 'Current streak', col: 'Days', note: 'Days in a row, still going.' },
      { id: 'longest', name: 'Longest streak', col: 'Days', note: 'Most days in a row, ever.' }
    ],
    all: [
      { id: 'played', name: 'Dailies played', col: 'Played', noSub: true, note: 'Every finished daily, across all games.' },
      { id: 'streak', name: 'Current streak', col: 'Days', note: 'Days in a row with at least one daily, still going.' },
      { id: 'longest', name: 'Longest streak', col: 'Days', note: 'Most days in a row with at least one daily.' }
    ]
  };

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  function gameById(id) { for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i]; return null; }
  function metricById(game, id) {
    var list = METRICS[game] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0];
  }

  /* ------------------------------------------------------------ state */
  var params = new URLSearchParams(location.search);
  var today = Archive.today();
  var state = {
    type: params.get('type') === 'alltime' ? 'alltime' : 'daily',
    game: gameById(params.get('game')) ? params.get('game') : 'pinpoint',
    day: params.get('day') && Archive.isValidDay(params.get('day')) ? params.get('day') : today,
    metric: params.get('metric') || ''
  };
  if (state.type === 'daily' && state.game === 'all') state.game = 'pinpoint';
  state.metric = metricById(state.game, state.metric).id;

  function writeUrl() {
    var q = new URLSearchParams();
    if (state.type === 'alltime') { q.set('type', 'alltime'); q.set('game', state.game); q.set('metric', state.metric); }
    else { q.set('game', state.game); if (state.day !== today) q.set('day', state.day); }
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  /* ------------------------------------------------------------ controls */
  function chip(label, pressed, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  function renderControls() {
    ['daily', 'alltime'].forEach(function (t) {
      $('lb-type-' + t).setAttribute('aria-selected', state.type === t ? 'true' : 'false');
    });

    var games = $('lb-games');
    games.textContent = '';
    GAMES.forEach(function (g) {
      if (g.allTimeOnly && state.type !== 'alltime') return;
      games.appendChild(chip(g.name, g.id === state.game, function () {
        state.game = g.id;
        state.metric = metricById(g.id, state.metric).id;
        update();
      }));
    });

    $('lb-day').hidden = state.type !== 'daily';
    $('lb-metrics').hidden = state.type !== 'alltime';
    if (state.type === 'daily') {
      $('lb-day-label').textContent = (state.day === today ? 'Today · ' : '') + Archive.longDate(state.day, true);
      $('lb-day-prev').disabled = state.day <= Archive.LAUNCH;
      $('lb-day-next').disabled = state.day >= today;
    } else {
      var metrics = $('lb-metrics');
      metrics.textContent = '';
      METRICS[state.game].forEach(function (m) {
        metrics.appendChild(chip(m.name, m.id === state.metric, function () { state.metric = m.id; update(); }));
      });
    }
  }

  $('lb-type-daily').addEventListener('click', function () {
    state.type = 'daily';
    if (state.game === 'all') state.game = 'pinpoint';
    update();
  });
  $('lb-type-alltime').addEventListener('click', function () {
    state.type = 'alltime';
    state.metric = metricById(state.game, state.metric).id;
    update();
  });
  // Arrow keys move between the two tabs.
  document.querySelector('.lb-seg').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var next = state.type === 'daily' ? 'alltime' : 'daily';
    $('lb-type-' + next).click();
    $('lb-type-' + next).focus();
  });
  $('lb-day-prev').addEventListener('click', function () { state.day = Archive.shiftDay(state.day, -1); update(); });
  $('lb-day-next').addEventListener('click', function () { state.day = Archive.shiftDay(state.day, 1); update(); });

  /* ------------------------------------------------------------ table */
  function valueText(row) {
    if (state.type === 'daily') {
      if (state.game === 'outline') return row.won ? row.guesses + '/6' : 'X/6';
      return fmt(row.value);
    }
    var m = metricById(state.game, state.metric);
    if (m.pct) return fmt(row.value) + '%';
    if (m.dec) return Number(row.value).toFixed(2);
    return fmt(row.value);
  }
  function subText(row) {
    if (state.type === 'daily') {
      if (!row.finishedAt) return '';
      return new Date(row.finishedAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return fmt(row.played);
  }

  function rowEl(row) {
    var tr = document.createElement('tr');
    if (row.you) tr.className = 'is-you';
    var rank = document.createElement('td');
    rank.className = 'lb-rank';
    var badge = document.createElement('span');
    badge.className = 'lb-badge' + (row.rank <= 3 ? ' is-top is-' + row.rank : '');
    badge.textContent = row.rank;
    rank.appendChild(badge);

    var name = document.createElement('td');
    name.className = 'lb-name';
    name.textContent = row.username;
    if (row.you) {
      var tag = document.createElement('span');
      tag.className = 'lb-you';
      tag.textContent = 'You';
      name.appendChild(tag);
    }
    var val = document.createElement('td');
    val.className = 'lb-num lb-val';
    val.textContent = valueText(row);
    var sub = document.createElement('td');
    sub.className = 'lb-num lb-sub';
    sub.textContent = subText(row);
    tr.appendChild(rank); tr.appendChild(name); tr.appendChild(val); tr.appendChild(sub);
    return tr;
  }

  function caption() {
    var g = gameById(state.game);
    if (state.type === 'daily') {
      if (state.game === 'outline') return 'Fewest guesses wins. Ties go to whoever finished first.';
      return 'Out of ' + fmt(g.max) + ' points. Ties go to whoever finished first.';
    }
    var m = metricById(state.game, state.metric);
    return m.note || (state.game === 'all' ? '' : 'All daily challenges since launch.');
  }

  function showMessage(text, html) {
    $('lb-table').hidden = true;
    $('lb-rows').textContent = '';
    var empty = $('lb-empty');
    empty.hidden = false;
    if (html) empty.innerHTML = html; else empty.textContent = text;
  }

  var seq = 0;
  function load() {
    var mine = ++seq;
    var card = $('lb-card');
    card.setAttribute('aria-busy', 'true');
    card.classList.add('is-loading');
    $('lb-caption').textContent = caption();

    var q = state.type === 'daily'
      ? 'type=daily&game=' + state.game + '&day=' + state.day
      : 'type=alltime&game=' + state.game + '&metric=' + state.metric;

    Account.request('GET', 'leaderboard?' + q).then(function (data) {
      if (mine !== seq) return;
      draw(data);
    }, function (err) {
      if (mine !== seq) return;
      $('lb-caption').textContent = '';
      if (err && (err.status === 503 || err.status === 404 || err.status === 405 || !err.status)) {
        showMessage('', 'Leaderboards need accounts, which aren’t switched on for this site yet. ' +
          'You can still <a href="./">play every game</a> as a guest.');
      } else {
        showMessage((err && err.message) || 'Couldn’t load the leaderboard. Try again in a moment.');
      }
    }).then(function () {
      if (mine !== seq) return;
      card.setAttribute('aria-busy', 'false');
      card.classList.remove('is-loading');
    });
  }

  function draw(data) {
    var rows = (data && data.rows) || [];
    if (!rows.length) {
      var dailyMsg = state.day === today
        ? 'No one’s on today’s board yet. <a href="' + Archive.urlFor(state.game, state.day) + '">Be the first</a>.'
        : 'No one finished this daily on the day.';
      showMessage('', state.type === 'daily' ? dailyMsg : 'No one qualifies for this one yet.');
      return;
    }
    $('lb-empty').hidden = true;
    $('lb-table').hidden = false;

    var m = state.type === 'alltime' ? metricById(state.game, state.metric) : null;
    $('lb-col-value').textContent = m ? m.col : (state.game === 'outline' ? 'Guesses' : 'Score');
    $('lb-col-sub').textContent = m ? (m.noSub ? '' : 'Games') : 'Finished';
    $('lb-table').classList.toggle('no-sub', !!(m && m.noSub));

    var body = $('lb-rows');
    body.textContent = '';
    rows.forEach(function (r) { body.appendChild(rowEl(r)); });

    // Signed-in player ranked below the top 50: show a gap, then their row.
    if (data.you && !rows.some(function (r) { return r.you; })) {
      var gap = document.createElement('tr');
      gap.className = 'lb-gap';
      gap.innerHTML = '<td colspan="4"><span>⋯</span></td>';
      body.appendChild(gap);
      body.appendChild(rowEl(data.you));
    }
    var count = $('lb-caption');
    count.textContent = caption() + (caption() ? ' ' : '') + data.count + (data.count === 1 ? ' player.' : ' players.');
  }

  function update() {
    writeUrl();
    renderControls();
    load();
  }

  /* ------------------------------------------------------------ account */
  Account.init().then(function (user) {
    if (user) {
      $('hub-account-label').textContent = user.username;
      $('hub-account').setAttribute('aria-label', 'Account: ' + user.username);
      $('hub-account').classList.add('is-signed-in');
    } else if (Account.isAvailable && Account.isAvailable()) {
      $('lb-signin-note').hidden = false;
    }
  });
  // Results pushed up after signing in can put the player on today's board.
  window.addEventListener('dailyarchive:sync', function () { load(); });

  update();
})();

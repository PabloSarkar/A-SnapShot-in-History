/* =============================================================================
 * The Daily Dose — daily challenge archive (shared by the hub and every game)
 * -----------------------------------------------------------------------------
 * - Days are UTC dates ("YYYY-MM-DD"), the same for every player.
 * - The archive runs from LAUNCH to today. Any game opened with
 *   ?date=YYYY-MM-DD plays that day's daily challenge instead of today's.
 * - Results are kept per game and per day in localStorage:
 *     dailies.<game> = { "YYYY-MM-DD": { done, summary, ...game fields } }
 *   `done` and `summary` (e.g. "8,676 pts", "4/6") are what the hub's
 *   calendar shows; the rest belongs to the game.
 * - Older single-day keys from before the archive are migrated on first use.
 * ========================================================================== */
(function () {
  'use strict';

  var LAUNCH = '2026-11-07';
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** The daily games, in hub order. url is relative to the site root. */
  var GAMES = [
    { id: 'snapshot', name: 'Snapshot', url: './snapshot.html' },
    { id: 'pinpoint', name: 'Pinpoint', url: './pinpoint.html' },
    { id: 'outline', name: 'Outline', url: './outline.html' }
  ];

  function today() { return new Date().toISOString().slice(0, 10); }

  function isValidDay(day) {
    if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
    var t = Date.parse(day + 'T00:00:00Z');
    if (!isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return false; // e.g. 2026-02-31
    return day >= LAUNCH && day <= today();
  }

  /** The archive day requested in the page URL (?date=…), or null for today. */
  function requestedDay() {
    var m = /[?&]date=(\d{4}-\d{2}-\d{2})\b/.exec(location.search);
    var day = m && m[1];
    return day && isValidDay(day) && day !== today() ? day : null;
  }

  function shiftDay(day, delta) {
    var d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  function longDate(day, withWeekday) {
    return new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', {
      weekday: withWeekday ? 'long' : undefined, day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });
  }

  /* ----------------------------------------------------------- storage */
  function key(game) { return 'dailies.' + game; }

  function readAll(game) {
    var all = null;
    try { all = JSON.parse(localStorage.getItem(key(game))); } catch (e) { all = null; }
    if (!all || typeof all !== 'object') all = {};
    if (migrate(game, all)) writeAll(game, all);
    return all;
  }
  function writeAll(game, all) {
    try { localStorage.setItem(key(game), JSON.stringify(all)); } catch (e) { /* private mode: play still works */ }
  }
  function read(game, day) { return readAll(game)[day] || null; }
  function write(game, day, record) {
    var all = readAll(game);
    all[day] = record;
    writeAll(game, all);
  }

  /** Bring results saved before the archive existed into the per-day store. */
  function migrate(game, all) {
    var legacyKey = { pinpoint: 'pinpoint.daily.v1', outline: 'outline.daily.v1', snapshot: 'snapshot.daily' }[game];
    var raw;
    try { raw = JSON.parse(localStorage.getItem(legacyKey)); } catch (e) { raw = null; }
    if (!raw || !raw.date || all[raw.date]) return false;
    var rec;
    if (game === 'pinpoint') {
      rec = raw;
      rec.summary = Math.round(raw.total || 0).toLocaleString('en-US') + ' pts';
    } else if (game === 'outline') {
      rec = raw;
      rec.summary = (raw.won ? raw.guesses.length : 'X') + '/6';
    } else {
      rec = { date: raw.date, done: true, total: raw.total, summary: Math.round(raw.total || 0).toLocaleString('en-US') + ' pts' };
    }
    all[raw.date] = rec;
    try { localStorage.removeItem(legacyKey); } catch (e) { /* ignore */ }
    return true;
  }

  /** { state: 'done' | 'progress' | 'none', summary } for the calendar. */
  function status(game, day) {
    var rec = read(game, day);
    if (!rec) return { state: 'none', summary: '' };
    return { state: rec.done ? 'done' : 'progress', summary: rec.summary || '' };
  }

  /** Link to a game's daily for a given day (today links without ?date). */
  function urlFor(game, day) {
    var g = GAMES.filter(function (x) { return x.id === game; })[0];
    if (!g) return './';
    return day === today() ? g.url : g.url + '?date=' + day;
  }

  window.DailyArchive = {
    LAUNCH: LAUNCH,
    GAMES: GAMES,
    today: today,
    isValidDay: isValidDay,
    requestedDay: requestedDay,
    shiftDay: shiftDay,
    longDate: longDate,
    read: read,
    write: write,
    readAll: readAll,
    status: status,
    urlFor: urlFor
  };
})();

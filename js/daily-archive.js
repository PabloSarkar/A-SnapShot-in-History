/* =============================================================================
 * The Daily Dose — daily challenge archive (shared by the hub and every game)
 * -----------------------------------------------------------------------------
 * - Days follow each player's own calendar date ("YYYY-MM-DD"), like Wordle:
 *   a new challenge unlocks at the player's local midnight, and everyone on
 *   the same date gets the same challenge. (Date keys are only ever *formatted*
 *   in UTC below, which keeps "2026-11-08" from shifting a day.)
 * - The archive runs from LAUNCH to today. Any game opened with
 *   ?date=YYYY-MM-DD plays that day's daily challenge instead of today's.
 * - Results are kept per game and per day in localStorage:
 *     dailies.<game> = { "YYYY-MM-DD": { done, summary, ...game fields } }
 *   `done` and `summary` (e.g. "8,676 pts", "4/6") are what the hub's
 *   calendar shows; the rest belongs to the game.
 * - Older single-day keys from before the archive are migrated on first use.
 *
 * Account sync (when js/account.js is loaded and the player is signed in):
 * - On every page load, results are pulled from /api/dailies and merged in,
 *   and anything only this browser has (e.g. played as a guest before
 *   signing in) is pushed up.
 * - Every write is pushed straight away (debounced).
 * - Merging keeps the first finished result for a day, otherwise the one
 *   furthest along; the server applies the same rule.
 * - Signing out clears these results from the browser, so a shared computer
 *   doesn't show the previous player's calendar.
 * - Pages hear about pulled changes via a 'dailyarchive:sync' window event.
 * ========================================================================== */
(function () {
  'use strict';

  var LAUNCH = '2026-11-07';
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** The daily games, in hub order. url is relative to the site root. */
  var GAMES = [
    { id: 'snapshot', name: 'Snapshot', url: './snapshot.html' },
    { id: 'pinpoint', name: 'Pinpoint', url: './pinpoint.html' },
    { id: 'outline', name: 'Outline', url: './outline.html' },
    { id: 'timeline', name: 'Timeline', url: './timeline.html' },
    { id: 'oldernewer', name: 'Older or Newer', url: './oldernewer.html' },
    { id: 'compass', name: 'Compass', url: './compass.html' }
  ];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** The player's local calendar date. */
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** Minutes until the player's next local midnight, as "5h 12m". */
  function timeToNext() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    var mins = Math.max(0, Math.ceil((next - now) / 60000));
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h ? h + 'h ' : '') + m + 'm';
  }

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
    push(game, day, record);
  }

  /* -------------------------------------------------------------- sync */
  /** How far through the day's game a record is: finished beats everything, then more moves. */
  function progressOf(rec) {
    if (!rec || typeof rec !== 'object') return -1;
    if (rec.done) return 1e6;
    var moves = rec.results || rec.guesses || rec.tries || rec.answers;   // Pinpoint, Outline, Timeline, Older or Newer
    return moves && typeof moves.length === 'number' ? moves.length : 0;
  }
  /** Keep the first finished result, otherwise whichever is further along. */
  function keepBetter(mine, theirs) {
    if (!mine) return theirs;
    if (!theirs || mine.done) return mine;
    if (theirs.done) return theirs;
    return progressOf(theirs) > progressOf(mine) ? theirs : mine;
  }

  function account() {
    var acct = window.SnapshotAccount;
    return acct && acct.user() && acct.request ? acct : null;
  }

  var pushTimers = {};
  /** Send one day's result to the account (debounced per game/day). */
  function push(game, day, record) {
    var acct = account();
    if (!acct) return;
    var k = game + '|' + day;
    clearTimeout(pushTimers[k]);
    pushTimers[k] = setTimeout(function () {
      delete pushTimers[k];
      acct.request('PUT', 'dailies', { game: game, day: day, record: record }).then(function (res) {
        // The server keeps the better of the two; adopt it if it isn't ours.
        var kept = res && res.record;
        if (kept && JSON.stringify(kept) !== JSON.stringify(record)) {
          var all = readAll(game); all[day] = kept; writeAll(game, all);
          announce();
        }
      }, function (err) { console.warn('Couldn’t save the daily result to your account', err); });
    }, 400);
  }

  function announce() {
    try { window.dispatchEvent(new CustomEvent('dailyarchive:sync')); } catch (e) { /* old browsers */ }
  }

  var syncing = null;
  /** Pull the account's results, merge them in, and push anything only this browser has. */
  function sync() {
    var acct = account();
    if (!acct) return Promise.resolve(false);
    if (syncing) return syncing;
    syncing = acct.request('GET', 'dailies').then(function (res) {
      var remote = (res && res.dailies) || {};
      var changed = false;
      GAMES.forEach(function (g) {
        var local = readAll(g.id), theirs = remote[g.id] || {};
        var days = Object.keys(local).concat(Object.keys(theirs));
        days.forEach(function (day) {
          if (!isValidDay(day)) return;
          var best = keepBetter(local[day], theirs[day]);
          if (best !== local[day]) { local[day] = best; changed = true; }
          if (best !== theirs[day] && JSON.stringify(best) !== JSON.stringify(theirs[day])) push(g.id, day, best);
        });
        writeAll(g.id, local);
      });
      if (changed) announce();
      return changed;
    }).catch(function (err) {
      console.warn('Couldn’t load daily results from your account', err);
      return false;
    }).then(function (changed) { syncing = null; return changed; });
    return syncing;
  }

  /** Remove every saved daily result from this browser (used on sign-out). */
  function clearLocal() {
    GAMES.forEach(function (g) { try { localStorage.removeItem(key(g.id)); } catch (e) { /* ignore */ } });
    announce();
  }

  // Wire up to the account client if this page has it.
  (function connect() {
    var acct = window.SnapshotAccount;
    if (!acct) return;
    var wasSignedIn = false;
    acct.onChange(function (user) {
      if (user && !wasSignedIn) sync();
      if (!user && wasSignedIn) clearLocal();
      wasSignedIn = !!user;
    });
    acct.init().then(function (user) { if (user) { wasSignedIn = true; sync(); } });
  })();

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
    timeToNext: timeToNext,
    isValidDay: isValidDay,
    requestedDay: requestedDay,
    shiftDay: shiftDay,
    longDate: longDate,
    read: read,
    write: write,
    readAll: readAll,
    status: status,
    urlFor: urlFor,
    sync: sync,
    clearLocal: clearLocal
  };
})();

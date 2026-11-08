/* =============================================================================
 * The Daily Dose — accounts API (Cloudflare Pages Functions + D1)
 * -----------------------------------------------------------------------------
 * Handles every request under /api/:
 *   GET  /api/me         -> { user: { username } | null }
 *   POST /api/signup     { username, password } -> { user }   (also signs in)
 *   POST /api/login      { username, password } -> { user }
 *   POST /api/logout     -> { ok: true }
 *   GET  /api/progress   -> { data }   (scores, streaks; the game's own format)
 *   PUT  /api/progress   { data } -> { ok: true }
 *   GET  /api/dailies    -> { dailies: { game: { "YYYY-MM-DD": record } } }   (player's local dates)
 *   PUT  /api/dailies    { game, day, record } -> { record }   (the record now stored)
 *   GET  /api/leaderboard?type=daily&game=pinpoint&day=YYYY-MM-DD
 *   GET  /api/leaderboard?type=alltime&game=pinpoint|outline|snapshot|all&metric=…
 *        -> { rows: [{ rank, username, value, … , you }], you: {…} | null, count }
 *        Public (no sign-in needed); `you` is filled in when signed in.
 *
 * Daily results (one row per user, game and day) follow the same rules as
 * the games: a finished result is never replaced by an unfinished one, the
 * first finished result for a day is the one that counts, and an unfinished
 * one only advances (more rounds / guesses played). The server applies these
 * itself, so a second device or a stale tab can't overwrite a real result.
 *
 * Needs a D1 database bound as `DB` (Pages project → Settings → Bindings).
 * Without it every endpoint answers 503 { error: 'not_configured' } and the
 * game simply carries on with guest (browser-only) progress.
 *
 * Security
 *   - Passwords: PBKDF2-SHA256, 100,000 iterations (the Workers maximum),
 *     16-byte random salt per user. Plain passwords are never stored or logged.
 *   - Sessions: 32 random bytes in an HttpOnly, Secure, SameSite=Lax cookie;
 *     only a SHA-256 hash of the token is stored, so a database leak can't
 *     be replayed as logins. Sessions last 30 days.
 *   - Brute force: 10 failed logins per username or per IP in 15 minutes
 *     locks further attempts for that key; 5 sign-ups per IP per hour.
 *   - CSRF: state-changing requests must be JSON and same-origin.
 *   - No email means no password reset (the sign-up form says so).
 * ========================================================================== */

const COOKIE = 'snap_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_PROGRESS_BYTES = 20000;
const MAX_DAILY_BYTES = 8000;
const DAILY_GAMES = new Set(['snapshot', 'pinpoint', 'outline']);
const DAILY_LAUNCH = '2026-11-07';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const enc = new TextEncoder();

// ------------------------------------------------------------------ helpers
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders }
  });
}
function fail(status, error, message) {
  return json({ error, message }, status);
}
function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hashPassword(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations },
    key,
    256
  );
  return hex(bits);
}
function now() {
  return Math.floor(Date.now() / 1000);
}
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}
function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ------------------------------------------------------------- database
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        iterations INTEGER NOT NULL,
        created_at INTEGER NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL)`),
      db.prepare('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS progress (
        user_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS daily_results (
        user_id INTEGER NOT NULL,
        game TEXT NOT NULL,
        day TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, game, day))`),
      // One row per finished, verified daily: what the leaderboards rank.
      db.prepare(`CREATE TABLE IF NOT EXISTS leaderboard_entries (
        user_id INTEGER NOT NULL,
        game TEXT NOT NULL,
        day TEXT NOT NULL,
        score REAL NOT NULL,
        guesses INTEGER,
        won INTEGER,
        live INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, game, day))`),
      db.prepare('CREATE INDEX IF NOT EXISTS leaderboard_day ON leaderboard_entries(game, day, live)'),
      db.prepare('CREATE TABLE IF NOT EXISTS auth_events (key TEXT NOT NULL, at INTEGER NOT NULL)'),
      db.prepare('CREATE INDEX IF NOT EXISTS auth_events_key ON auth_events(key, at)')
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function countEvents(db, key, sinceSeconds) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM auth_events WHERE key = ? AND at > ?')
    .bind(key, now() - sinceSeconds).first();
  return row ? row.n : 0;
}
function recordEvent(db, key) {
  return db.prepare('INSERT INTO auth_events (key, at) VALUES (?, ?)').bind(key, now()).run();
}

async function currentUser(db, request) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), now()).first();
  return row || null;
}

async function startSession(db, userId) {
  const token = base64url(randomBytes(32));
  const maxAge = SESSION_DAYS * 86400;
  await db.batch([
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), userId, now() + maxAge),
    // Housekeeping: drop expired sessions and old rate-limit events.
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
    db.prepare('DELETE FROM auth_events WHERE at < ?').bind(now() - 86400)
  ]);
  return sessionCookie(token, maxAge);
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

// --------------------------------------------------------------- routes
async function signup(db, request) {
  const ip = clientIp(request);
  if (await countEvents(db, 'signup:' + ip, 3600) >= 5) {
    return fail(429, 'rate_limited', 'Too many new accounts from this network. Try again in an hour.');
  }
  const body = await readJson(request);
  const username = body && typeof body.username === 'string' ? body.username.trim() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) {
    return fail(400, 'bad_username', 'Usernames are 3–20 characters: letters, numbers and _ only.');
  }
  if (password.length < 8 || password.length > 128) {
    return fail(400, 'bad_password', 'Passwords need at least 8 characters.');
  }
  const taken = await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (taken) return fail(409, 'username_taken', 'That username is taken. Try another.');

  const salt = hex(randomBytes(16));
  const passHash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  let result;
  try {
    result = await db.prepare(
      'INSERT INTO users (username, pass_hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(username, passHash, salt, PBKDF2_ITERATIONS, now()).run();
  } catch (e) {
    // Lost a race with someone registering the same name.
    return fail(409, 'username_taken', 'That username is taken. Try another.');
  }
  await recordEvent(db, 'signup:' + ip);
  const cookie = await startSession(db, result.meta.last_row_id);
  return json({ user: { username } }, 201, { 'set-cookie': cookie });
}

// A fixed salt/hash for unknown usernames, so a wrong username takes as long
// as a wrong password and response times don't reveal which accounts exist.
const DUMMY_SALT = '00112233445566778899aabbccddeeff';

async function login(db, request) {
  const ip = clientIp(request);
  const body = await readJson(request);
  const username = body && typeof body.username === 'string' ? body.username.trim() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!username || !password || password.length > 128) {
    return fail(400, 'missing_fields', 'Enter your username and password.');
  }
  const userKey = 'login:' + username.toLowerCase();
  const ipKey = 'login-ip:' + ip;
  if (await countEvents(db, userKey, 900) >= 10 || await countEvents(db, ipKey, 900) >= 30) {
    return fail(429, 'rate_limited', 'Too many attempts. Wait 15 minutes and try again.');
  }
  const user = await db.prepare('SELECT id, username, pass_hash, salt, iterations FROM users WHERE username = ?')
    .bind(username).first();
  const attempt = await hashPassword(password, user ? user.salt : DUMMY_SALT, user ? user.iterations : PBKDF2_ITERATIONS);
  if (!user || !timingSafeEqual(attempt, user.pass_hash)) {
    await db.batch([
      db.prepare('INSERT INTO auth_events (key, at) VALUES (?, ?)').bind(userKey, now()),
      db.prepare('INSERT INTO auth_events (key, at) VALUES (?, ?)').bind(ipKey, now())
    ]);
    return fail(401, 'bad_credentials', 'That username and password don’t match.');
  }
  const cookie = await startSession(db, user.id);
  return json({ user: { username: user.username } }, 200, { 'set-cookie': cookie });
}

async function logout(db, request) {
  const token = readCookie(request, COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

async function getProgress(db, user) {
  const row = await db.prepare('SELECT data FROM progress WHERE user_id = ?').bind(user.id).first();
  let data = null;
  try { data = row ? JSON.parse(row.data) : null; } catch (e) { data = null; }
  return json({ data });
}

async function putProgress(db, request, user) {
  const text = await request.text();
  if (text.length > MAX_PROGRESS_BYTES) return fail(413, 'too_large', 'Progress data is too large.');
  let body;
  try { body = JSON.parse(text); } catch (e) { return fail(400, 'bad_json', 'Invalid JSON.'); }
  if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    return fail(400, 'bad_progress', 'Expected { data: {...} }.');
  }
  await db.prepare(
    `INSERT INTO progress (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(user.id, JSON.stringify(body.data), now()).run();
  return json({ ok: true });
}

// ------------------------------------------------------------ daily results
/** How far through the day's game a record is: finished beats everything, then more moves. */
function progressOf(rec) {
  if (!rec || typeof rec !== 'object') return -1;
  if (rec.done) return 1e6;
  const moves = Array.isArray(rec.results) ? rec.results.length : Array.isArray(rec.guesses) ? rec.guesses.length : 0;
  return moves;
}
/** Which record to keep: the first finished one, otherwise the furthest along. */
function keepBetter(existing, incoming) {
  if (!existing) return incoming;
  if (existing.done) return existing;
  return progressOf(incoming) >= progressOf(existing) ? incoming : existing;
}
function utcDay(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}

async function getDailies(db, user, env, request) {
  const { results } = await db.prepare('SELECT game, day, data FROM daily_results WHERE user_id = ?').bind(user.id).all();
  const out = {};
  for (const row of results || []) {
    try { (out[row.game] = out[row.game] || {})[row.day] = JSON.parse(row.data); } catch (e) { /* skip a corrupt row */ }
  }
  // Finished results synced before leaderboards existed get their entry now (usually none).
  const { results: missing } = await db.prepare(
    `SELECT r.game, r.day, r.data, r.updated_at FROM daily_results r
     LEFT JOIN leaderboard_entries e ON e.user_id = r.user_id AND e.game = r.game AND e.day = r.day
     WHERE r.user_id = ? AND e.user_id IS NULL`).bind(user.id).all();
  for (const row of missing || []) {
    try {
      const rec = JSON.parse(row.data);
      if (rec && rec.done) await addLeaderboardEntry(db, env, request, user, row.game, row.day, rec, row.updated_at * 1000);
    } catch (e) { /* skip */ }
  }
  return json({ dailies: out });
}

async function putDaily(db, request, user, env) {
  const text = await request.text();
  if (text.length > MAX_DAILY_BYTES) return fail(413, 'too_large', 'Daily result is too large.');
  let body;
  try { body = JSON.parse(text); } catch (e) { return fail(400, 'bad_json', 'Invalid JSON.'); }
  const game = body && body.game, day = body && body.day, record = body && body.record;
  if (!DAILY_GAMES.has(game)) return fail(400, 'bad_game', 'Unknown game.');
  // Days are the player's local date, which can be up to 14 hours ahead of UTC
  // (e.g. Kiribati), so allow up to tomorrow in UTC.
  if (typeof day !== 'string' || !DAY_RE.test(day) || day < DAILY_LAUNCH || day > utcDay(1)) return fail(400, 'bad_day', 'Invalid day.');
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail(400, 'bad_record', 'Expected a record object.');

  const row = await db.prepare('SELECT data FROM daily_results WHERE user_id = ? AND game = ? AND day = ?').bind(user.id, game, day).first();
  let existing = null;
  try { existing = row ? JSON.parse(row.data) : null; } catch (e) { existing = null; }
  const keep = keepBetter(existing, record);
  if (keep !== existing) {
    await db.prepare(
      `INSERT INTO daily_results (user_id, game, day, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game, day) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(user.id, game, day, JSON.stringify(keep), now()).run();
    // First finished result for this day: add it to the leaderboards if it checks out.
    if (keep.done && !(existing && existing.done)) await addLeaderboardEntry(db, env, request, user, game, day, keep, Date.now());
  }
  return json({ record: keep });
}

/* =============================================================================
 * LEADERBOARDS
 * Scores are worked out in the browser, so before a result is ranked the
 * server checks it against what it can recompute:
 *   outline   the day's answer is recomputed here (same country list and
 *             shuffle as outline.html); the guesses must be real countries,
 *             unique, ≤ 6, and "won" must mean the last guess was the answer.
 *   pinpoint  the day's five places are recomputed (same pools and PRNG as
 *             pinpoint.html) and must match; every round's points must equal
 *             base × multiplier with base 0–1,000, and the total must add up.
 *             (Guess positions aren't stored, so distances can't be re-measured.)
 *   snapshot  the total must be a whole number from 0 to 50,000.
 * Only "live" results count: finished on the puzzle's own date somewhere on
 * Earth (UTC−12 … UTC+14). Archive replays never reach the leaderboards.
 * ========================================================================== */
const ROUND_MULTS = [1, 1.5, 2, 2.5, 3];
const gameData = {};          // per-isolate cache of the static data files

async function loadAsset(env, request, path, global) {
  if (gameData[path]) return gameData[path];
  let value = null;
  try {
    const res = await env.ASSETS.fetch(new URL(path, request.url));
    if (res.ok) {
      const text = await res.text();
      const i = text.indexOf('window.' + global + ' = ');
      if (i !== -1) value = JSON.parse(text.slice(i + global.length + 10).trim().replace(/;\s*$/, ''));
    }
  } catch (e) { value = null; }
  if (value !== null) gameData[path] = value;   // don't cache a failed load
  return value;
}
// Same helpers as the games, so the daily picks match exactly.
function hashStr(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dailyNumber(day) { return Math.round((Date.parse(day) - Date.parse(DAILY_LAUNCH)) / 864e5) + 1; }

async function outlineAnswer(env, request, day) {
  const rows = await loadAsset(env, request, '/js/outline-countries.js', 'OUTLINE_COUNTRIES');
  if (!Array.isArray(rows)) return null;
  const order = rows.filter((r) => r[5]).map((r) => r[1]).sort();
  const rng = mulberry32(hashStr('outline-order-v1'));
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const n = dailyNumber(day);
  return { answer: order[((n - 1) % order.length + order.length) % order.length], codes: new Set(rows.map((r) => r[1])) };
}
async function pinpointTargets(env, request, day) {
  const data = await loadAsset(env, request, '/js/pinpoint-places.js', 'PINPOINT_PLACES');
  if (!data || !Array.isArray(data.rounds) || data.rounds.length !== 5) return null;
  const rng = mulberry32(hashStr('pinpoint:' + day));
  return data.rounds.map((pool) => pool[Math.floor(rng() * pool.length)][0]);
}

/** Turn a finished record into a leaderboard entry, or null if it doesn't check out. */
async function deriveEntry(env, request, game, day, rec) {
  if (game === 'snapshot') {
    const t = rec.total;
    return Number.isInteger(t) && t >= 0 && t <= 50000 ? { score: t, guesses: null, won: null } : null;
  }
  if (game === 'outline') {
    const g = rec.guesses;
    if (!Array.isArray(g) || g.length < 1 || g.length > 6 || new Set(g).size !== g.length) return null;
    const truth = await outlineAnswer(env, request, day);
    if (!truth || !g.every((c) => truth.codes.has(c))) return null;
    const won = g[g.length - 1] === truth.answer && g.indexOf(truth.answer) === g.length - 1;
    if (!!rec.won !== won || (!won && g.length !== 6)) return null;
    return { score: won ? 7 - g.length : 0, guesses: g.length, won: won ? 1 : 0 };
  }
  if (game === 'pinpoint') {
    const r = rec.results;
    if (!Array.isArray(r) || r.length !== 5) return null;
    const names = await pinpointTargets(env, request, day);
    if (!names) return null;
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const x = r[i] || {};
      if (x.name !== names[i] || x.mult !== ROUND_MULTS[i]) return null;
      if (!Number.isInteger(x.base) || x.base < 0 || x.base > 1000) return null;
      if (x.timedOut && x.base !== 0) return null;
      if (!Number.isFinite(x.points) || Math.abs(x.points - Math.round(x.base * x.mult)) > 1) return null;
      total += x.points;
    }
    if (!Number.isFinite(rec.total) || Math.abs(total - rec.total) > 1) return null;
    return { score: total, guesses: null, won: null };
  }
  return null;
}

async function addLeaderboardEntry(db, env, request, user, game, day, rec, fallbackMs) {
  const entry = await deriveEntry(env, request, game, day, rec);
  if (!entry) return;
  // When it was finished: the client's timestamp if believable, else the server's.
  let at = Number(rec.finishedAt);
  if (!Number.isFinite(at) || at > Date.now() + 60000 || at < Date.parse(DAILY_LAUNCH) - 86400000) at = fallbackMs;
  const dayStart = Date.parse(day + 'T00:00:00Z');
  // Ranked only if it was both finished and received while that day was still
  // "today" somewhere on Earth (UTC+14 to UTC-12). Archive replays never rank.
  const end = dayStart + 36 * 3600000;
  const live = at >= dayStart - 14 * 3600000 && at < end && fallbackMs < end ? 1 : 0;
  await db.prepare(
    `INSERT OR IGNORE INTO leaderboard_entries (user_id, game, day, score, guesses, won, live, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(user.id, game, day, entry.score, entry.guesses, entry.won, live, Math.floor(at / 1000)).run();
}

/* ------------------------------------------------------------- queries */
const TOP = 50;
const METRICS = {
  // value expression, HAVING, sort direction, minimum games, which games
  total:      { sql: 'SUM(score)', dir: 'DESC', games: ['pinpoint', 'snapshot'] },
  average:    { sql: 'ROUND(AVG(score))', dir: 'DESC', min: 3, games: ['pinpoint', 'snapshot'] },
  best:       { sql: 'MAX(score)', dir: 'DESC', games: ['pinpoint', 'snapshot'] },
  wins:       { sql: 'SUM(won)', dir: 'DESC', games: ['outline'] },
  winrate:    { sql: 'ROUND(100.0 * AVG(won))', dir: 'DESC', min: 5, games: ['outline'] },
  avgguesses: { sql: 'ROUND(AVG(CASE WHEN won = 1 THEN guesses END), 2)', dir: 'ASC', min: 3, minWins: true, games: ['outline'] },
  played:     { sql: 'COUNT(*)', dir: 'DESC', games: ['pinpoint', 'snapshot', 'outline', 'all'] },
  streak:     { streak: 'current', games: ['pinpoint', 'snapshot', 'outline', 'all'] },
  longest:    { streak: 'longest', games: ['pinpoint', 'snapshot', 'outline', 'all'] }
};

/** Competition ranking (1, 2, 2, 4) over rows already sorted best-first. */
function rank(rows, same) {
  rows.forEach((r, i) => { r.rank = i > 0 && same(rows[i - 1], r) ? rows[i - 1].rank : i + 1; });
  return rows;
}
function finish(rows, me) {
  const you = me ? rows.find((r) => r.userId === me.id) || null : null;
  const strip = (r) => r && Object.assign({}, r, { userId: undefined, you: !!(me && r.userId === me.id) });
  return json({ rows: rows.slice(0, TOP).map(strip), you: strip(you), count: rows.length });
}

async function dailyBoard(db, game, day, me) {
  const order = game === 'outline' ? 'e.won DESC, e.guesses ASC, e.finished_at ASC' : 'e.score DESC, e.finished_at ASC';
  const { results } = await db.prepare(
    `SELECT e.user_id AS userId, u.username, e.score, e.guesses, e.won, e.finished_at AS finishedAt
     FROM leaderboard_entries e JOIN users u ON u.id = e.user_id
     WHERE e.game = ? AND e.day = ? AND e.live = 1 ORDER BY ${order}`).bind(game, day).all();
  const rows = (results || []).map((r) => Object.assign(r, { value: game === 'outline' ? (r.won ? r.guesses : null) : r.score }));
  return finish(rank(rows, (a, b) => game === 'outline' ? a.won === b.won && a.guesses === b.guesses : a.score === b.score), me);
}

function streaks(daysSorted, today) {
  let longest = 0, run = 0, prev = null;
  for (const d of daysSorted) {
    run = prev && Date.parse(d) - Date.parse(prev) === 864e5 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  // Still alive if the last day played is recent enough for some time zone to call it today or yesterday.
  const current = prev && Date.parse(today) - Date.parse(prev) <= 2 * 864e5 ? run : 0;
  return { current, longest };
}

async function allTimeBoard(db, game, metric, me) {
  const m = METRICS[metric];
  if (!m || m.games.indexOf(game) === -1) return fail(400, 'bad_metric', 'Unknown stat for this game.');
  const gameFilter = game === 'all' ? '' : 'AND e.game = ?';
  const binds = game === 'all' ? [] : [game];
  let rows;
  if (m.streak) {
    const { results } = await db.prepare(
      `SELECT DISTINCT e.user_id AS userId, u.username, e.day FROM leaderboard_entries e JOIN users u ON u.id = e.user_id
       WHERE e.live = 1 ${gameFilter} ORDER BY e.user_id, e.day`).bind(...binds).all();
    const byUser = new Map();
    for (const r of results || []) {
      if (!byUser.has(r.userId)) byUser.set(r.userId, { userId: r.userId, username: r.username, days: [] });
      byUser.get(r.userId).days.push(r.day);
    }
    const today = utcDay(0);
    rows = [...byUser.values()].map((u) => ({ userId: u.userId, username: u.username, value: streaks(u.days, today)[m.streak], played: u.days.length }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value || b.played - a.played || a.username.localeCompare(b.username));
  } else {
    const having = m.minWins ? `HAVING SUM(won) >= ${m.min}` : m.min ? `HAVING COUNT(*) >= ${m.min}` : '';
    const { results } = await db.prepare(
      `SELECT e.user_id AS userId, u.username, ${m.sql} AS value, COUNT(*) AS played
       FROM leaderboard_entries e JOIN users u ON u.id = e.user_id
       WHERE e.live = 1 ${gameFilter} GROUP BY e.user_id ${having}
       ORDER BY value ${m.dir}, played DESC, u.username ASC`).bind(...binds).all();
    rows = results || [];
  }
  return finish(rank(rows, (a, b) => a.value === b.value), me);
}

async function leaderboard(db, request) {
  const q = new URL(request.url).searchParams;
  const type = q.get('type'), game = q.get('game');
  const me = await currentUser(db, request);
  if (type === 'daily') {
    const day = q.get('day');
    if (!DAILY_GAMES.has(game)) return fail(400, 'bad_game', 'Unknown game.');
    if (!day || !DAY_RE.test(day) || day < DAILY_LAUNCH || day > utcDay(1)) return fail(400, 'bad_day', 'Invalid day.');
    return dailyBoard(db, game, day, me);
  }
  if (type === 'alltime') {
    if (!DAILY_GAMES.has(game) && game !== 'all') return fail(400, 'bad_game', 'Unknown game.');
    return allTimeBoard(db, game, q.get('metric'), me);
  }
  return fail(400, 'bad_type', 'type must be daily or alltime.');
}

// ----------------------------------------------------------------- entry
export async function onRequest(context) {
  const { request, env } = context;
  const route = (context.params.route || []).join('/');
  const method = request.method;

  if (!env.DB) {
    return fail(503, 'not_configured', 'Accounts aren’t switched on for this site yet.');
  }

  // CSRF hardening for anything that changes state.
  if (method !== 'GET' && method !== 'HEAD') {
    const type = request.headers.get('content-type') || '';
    const origin = request.headers.get('origin');
    if (!type.startsWith('application/json') && route !== 'logout') {
      return fail(415, 'json_required', 'Send JSON.');
    }
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return fail(403, 'bad_origin', 'Cross-site request refused.');
    }
  }

  try {
    await ensureSchema(env.DB);
    const db = env.DB;

    if (route === 'me' && method === 'GET') {
      const user = await currentUser(db, request);
      return json({ user: user ? { username: user.username } : null });
    }
    if (route === 'signup' && method === 'POST') return await signup(db, request);
    if (route === 'login' && method === 'POST') return await login(db, request);
    if (route === 'logout' && method === 'POST') return await logout(db, request);

    if (route === 'progress') {
      const user = await currentUser(db, request);
      if (!user) return fail(401, 'signed_out', 'Sign in first.');
      if (method === 'GET') return await getProgress(db, user);
      if (method === 'PUT') return await putProgress(db, request, user);
    }
    if (route === 'dailies') {
      const user = await currentUser(db, request);
      if (!user) return fail(401, 'signed_out', 'Sign in first.');
      if (method === 'GET') return await getDailies(db, user, env, request);
      if (method === 'PUT') return await putDaily(db, request, user, env);
    }
    if (route === 'leaderboard' && method === 'GET') return await leaderboard(db, request);
    return fail(404, 'not_found', 'No such endpoint.');
  } catch (e) {
    console.error('api error', route, e && e.stack || e);
    return fail(500, 'server_error', 'Something went wrong on our side. Please try again.');
  }
}

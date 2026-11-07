/* =============================================================================
 * A Snapshot in History — accounts API (Cloudflare Pages Functions + D1)
 * -----------------------------------------------------------------------------
 * Handles every request under /api/:
 *   GET  /api/me         -> { user: { username } | null }
 *   POST /api/signup     { username, password } -> { user }   (also signs in)
 *   POST /api/login      { username, password } -> { user }
 *   POST /api/logout     -> { ok: true }
 *   GET  /api/progress   -> { data }   (scores, streaks; the game's own format)
 *   PUT  /api/progress   { data } -> { ok: true }
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
    return fail(404, 'not_found', 'No such endpoint.');
  } catch (e) {
    console.error('api error', route, e && e.stack || e);
    return fail(500, 'server_error', 'Something went wrong on our side. Please try again.');
  }
}

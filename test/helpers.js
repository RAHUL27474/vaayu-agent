// Test helpers: boots the app on a free port with a fresh in-memory database and its own temp folders.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-test-'));
fs.mkdirSync(path.join(tmp, 'data'));
fs.mkdirSync(path.join(tmp, 'uploads'));
Object.assign(process.env, { VERCEL: '1', PG_DIR: 'memory://', DATA_DIR: path.join(tmp, 'data'), UPLOADS_DIR: path.join(tmp, 'uploads') });
delete process.env.DATABASE_URL;

const ROOT = path.join(__dirname, '..');
const app = require(path.join(ROOT, 'server.js'));
const { db, stats } = require(path.join(ROOT, 'src/db'));

let failures = 0;
let passes = 0;
function check(name, ok, extra = '') {
  if (ok) passes++; else failures++;
  if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? `  (${extra})` : ''}`);
}

const cookieOf = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

/** Starts the server; resolves with a client bound to it once start-up (schema + demo data) is done. */
function start() {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const B = `http://localhost:${server.address().port}`;
      await fetch(`${B}/`); // waits for start-up
      const client = {
        B,
        server,
        get: (p, cookie = '') => fetch(B + p, { headers: { cookie }, redirect: 'manual' }),
        post: (p, cookie, fields, referer = '/') => fetch(B + p, {
          method: 'POST', body: fields instanceof FormData ? fields : new URLSearchParams(fields), headers: { cookie, referer: B + referer }, redirect: 'manual',
        }),
        async login(email, password) {
          const r = await fetch(`${B}/login`, { method: 'POST', body: new URLSearchParams({ email, password }), redirect: 'manual' });
          return cookieOf(r);
        },
        /** Follows one redirect and returns the page text (flash messages show there). */
        async follow(r, cookie) {
          const loc = r.headers.get('location');
          if (!loc) return r.text();
          return (await fetch(new URL(loc, B), { headers: { cookie: cookieOf(r) || cookie } })).text();
        },
      };
      resolve(client);
    });
  });
}

function finish(client) {
  console.log(`\n${passes} passed, ${failures} failed`);
  client.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

const ROLES = {
  admin: ['admin@vaayutrip.com', 'admin123'],
  backend: ['backend@vaayutrip.com', 'backend123'],
  agent: ['agent@skyline.com', 'agent123'],
  pending: ['agent@wanderlust.in', 'agent123'],
  agent2: ['agent@ravitours.com', 'agent123'],
};

module.exports = { start, finish, check, cookieOf, db, stats, ROLES, ROOT };

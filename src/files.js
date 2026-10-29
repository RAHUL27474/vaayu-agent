// Uploaded files (KYC documents, agency logos, cover photos) are kept in the database so they survive
// server restarts; the copy on disk is a cache. Paths are stored relative to their root:
// "data/kyc/<name>" under DATA_DIR, "uploads/<name>" under UPLOADS_DIR.
const fs = require('fs');
const path = require('path');
const { one, run, DATA_DIR, UPLOADS_DIR } = require('./db');

const ROOTS = [['data', DATA_DIR], ['uploads', UPLOADS_DIR]];

/** Database key for a file on disk, or null if it is outside the data and uploads folders. */
function keyOf(abs) {
  const full = path.resolve(abs);
  for (const [name, root] of ROOTS) {
    const rel = path.relative(path.resolve(root), full);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `${name}/${rel.split(path.sep).join('/')}`;
  }
  return null;
}

/** Saves a file that is on disk into the database. */
function persistFile(abs) {
  const key = keyOf(abs);
  if (!key || !fs.existsSync(abs)) return;
  run('INSERT INTO files (path, data) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET data = excluded.data', key, fs.readFileSync(abs));
}

/** Writes a file to disk and saves it in the database. */
function writePersisted(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  persistFile(abs);
}

/** Makes sure a stored file is on disk (after a restart the cache is empty). True if it exists now. */
function restoreFile(abs) {
  if (fs.existsSync(abs)) return true;
  const key = keyOf(abs);
  const row = key && one('SELECT data FROM files WHERE path = ?', key);
  if (!row) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(row.data));
  return true;
}

/** Removes a file from disk and from the database. */
function deleteFile(abs) {
  fs.rmSync(abs, { force: true });
  const key = keyOf(abs);
  if (key) run('DELETE FROM files WHERE path = ?', key);
}

module.exports = { persistFile, writePersisted, restoreFile, deleteFile };

const crypto = require('crypto');
const { one } = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function inr(n, { decimals = 0 } = {}) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}

async function uniqueSlug(table, base) {
  let slug = slugify(base);
  for (let i = 2; await one(`SELECT 1 FROM ${table} WHERE slug = ?`, slug); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

// Human-friendly codes like Q-7K3MPX; letters chosen to avoid 0/O and 1/I confusion.
function code(prefix, len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return `${prefix}-${[...bytes].map((b) => chars[b % chars.length]).join('')}`;
}

function fmtDate(d) {
  if (!d) return '';
  const plain = d.length === 10;
  const date = new Date(plain ? `${d}T00:00:00Z` : `${d.replace(' ', 'T')}Z`);
  // Calendar dates as written; timestamps (stored in UTC) shown on the India calendar.
  return Number.isNaN(date.getTime()) ? d : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: plain ? 'UTC' : 'Asia/Kolkata' });
}

/** Time of a UTC timestamp in India, e.g. "4:35 pm IST". */
function fmtTime(d) {
  if (!d || d.length <= 10) return '';
  const date = new Date(`${d.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '' : `${date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })} IST`;
}

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = { hashPassword, verifyPassword, round2, inr, slugify, uniqueSlug, code, fmtDate, fmtTime, num };

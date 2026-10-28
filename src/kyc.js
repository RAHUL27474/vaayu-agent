// Agency KYC: GSTIN + GST certificate + PAN card for Indian agencies, a local tax ID + tax
// certificate for foreign ones, and a photo of the person applying. All files are private,
// so they live under the data directory (never public/) and are only served to admins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { DATA_DIR } = require('./db');

const KYC_DIR = path.join(DATA_DIR, 'kyc');
fs.mkdirSync(KYC_DIR, { recursive: true });

const COUNTRIES = [
  'India', 'United Arab Emirates', 'Nepal', 'Bhutan', 'Bangladesh', 'Sri Lanka', 'Maldives', 'Singapore', 'Malaysia', 'Thailand',
  'Indonesia', 'Vietnam', 'Saudi Arabia', 'Qatar', 'Oman', 'Kuwait', 'Bahrain', 'United Kingdom', 'United States', 'Canada',
  'Australia', 'New Zealand', 'Germany', 'France', 'Italy', 'Netherlands', 'South Africa', 'Kenya', 'Mauritius', 'Other',
];

// 2-digit state code, PAN (5 letters, 4 digits, 1 letter), entity number, 'Z', checksum.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const isIndia = (country) => !country || country === 'India';
const panFromGstin = (gstin) => (GSTIN_RE.test(gstin) ? gstin.slice(2, 12) : null);

const DOC_TYPES = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const PHOTO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/** The KYC files an agency provides: form field / column → labels and allowed types. */
const KYC_FILES = {
  tax_doc: { types: DOC_TYPES, india: 'GST registration certificate', foreign: 'tax registration certificate' },
  pan_doc: { types: DOC_TYPES, india: 'PAN card', foreign: null },
  photo: { types: PHOTO_TYPES, india: 'your photo', foreign: 'your photo' },
};
const kycLabel = (field, country) => KYC_FILES[field][isIndia(country) ? 'india' : 'foreign'];
/** Fields required for a country (the PAN card only for India). */
const requiredFiles = (country) => Object.keys(KYC_FILES).filter((f) => kycLabel(f, country));

const upload = multer({
  storage: multer.diskStorage({
    destination: KYC_DIR,
    // Extension comes from the checked MIME type, never from the uploaded filename.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${KYC_FILES[file.fieldname].types[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    const ok = Boolean(KYC_FILES[file.fieldname] && KYC_FILES[file.fieldname].types[file.mimetype]);
    if (!ok && KYC_FILES[file.fieldname]) (req.kycRejected ||= []).push(file.fieldname);
    cb(null, ok);
  },
}).fields(Object.keys(KYC_FILES).map((name) => ({ name, maxCount: 1 })));

// Wraps multer so size/type problems become a form error instead of a crash.
// Afterwards req.kycFiles maps each field to the stored file name (or is missing it).
function withKycDocs(req, res, next) {
  upload(req, res, (err) => {
    if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Each document must be under 5 MB.' : `Upload failed: ${err.message}`;
    req.kycFiles = Object.fromEntries(Object.entries(req.files || {}).map(([k, v]) => [k, v[0].filename]));
    next();
  });
}

// Normalises and checks country + tax number.
function checkTax({ country, gstin, taxId }) {
  const out = { country: COUNTRIES.includes(country) ? country : 'India', gstin: null, taxId: null, pan: null, errors: [] };
  if (isIndia(out.country)) {
    out.gstin = String(gstin || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!out.gstin) out.errors.push('GSTIN is required for agencies in India.');
    else if (!GSTIN_RE.test(out.gstin)) out.errors.push('GSTIN should be 15 characters, like 27ABCDE1234F1Z5.');
    out.pan = panFromGstin(out.gstin);
  } else {
    out.taxId = String(taxId || '').trim().toUpperCase().slice(0, 40);
    if (out.taxId.length < 4) out.errors.push(`Enter your company's tax registration number in ${out.country}.`);
  }
  return out;
}

/** Pixel size { width, height } of a PNG, JPEG or WebP file on disk, or null if it can't be read. */
function imageSize(file) {
  let b;
  try {
    const fd = fs.openSync(file, 'r');
    b = Buffer.alloc(512 * 1024);
    b = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0));
    fs.closeSync(fd);
  } catch { return null; }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the start-of-frame marker, which holds the size.
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Browsers can't reliably show images beyond this (they open as a blank page), and no scan needs it.
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;

/** Errors for the uploaded files: wrong type, too large, or a required file neither uploaded nor on file. */
function checkKycFiles(req, country, onFile = {}) {
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  for (const f of req.kycRejected || []) {
    errors.push(f === 'photo' ? 'Your photo must be a JPG, PNG or WebP image.' : `The ${kycLabel(f, country) || 'document'} must be a PDF, JPG, PNG or WebP file.`);
  }
  for (const [f, name] of Object.entries(req.kycFiles || {})) {
    const size = imageSize(path.join(KYC_DIR, name));
    if (size && size.width * size.height > MAX_IMAGE_PIXELS) {
      const label = f === 'photo' ? 'Your photo' : `The ${kycLabel(f, country) || 'document'} image`;
      errors.push(`${label} is ${size.width.toLocaleString('en-IN')} × ${size.height.toLocaleString('en-IN')} pixels, too large to view. Upload a normal phone photo or scan (under 40 megapixels), or a PDF.`);
    }
  }
  for (const f of requiredFiles(country)) {
    if (!req.kycFiles[f] && !onFile[f] && !(req.kycRejected || []).includes(f)) errors.push(`Upload ${kycLabel(f, country)}.`);
  }
  return errors;
}

/** What an agency still has to provide before it can be verified and approved (labels). */
function missingKyc(agency) {
  const out = [];
  if (isIndia(agency.country) ? !agency.gstin : !agency.tax_id) out.push(isIndia(agency.country) ? 'GSTIN' : 'tax ID');
  for (const f of requiredFiles(agency.country)) if (!agency[f]) out.push(kycLabel(f, agency.country).replace(/^your /, 'applicant '));
  return out;
}

const removeDoc = (file) => { if (file) fs.rmSync(path.join(KYC_DIR, path.basename(file)), { force: true }); };
const removeUploaded = (req) => Object.values(req.kycFiles || {}).forEach(removeDoc);

module.exports = {
  KYC_DIR, KYC_FILES, COUNTRIES, GSTIN_RE, isIndia, panFromGstin, kycLabel, requiredFiles,
  withKycDocs, checkTax, checkKycFiles, missingKyc, removeDoc, removeUploaded, imageSize,
};

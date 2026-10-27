// Agency tax registration: GSTIN for Indian agencies, a local tax ID for foreign ones,
// plus the registration certificate. Certificates are private, so they live under the
// data directory (never public/) and are only served to admins.
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
const docUpload = multer({
  storage: multer.diskStorage({
    destination: KYC_DIR,
    // Extension comes from the checked MIME type, never from the uploaded filename.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${DOC_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = Boolean(DOC_TYPES[file.mimetype]);
    if (!ok) req.taxDocRejected = true;
    cb(null, ok);
  },
});

// Wraps multer so size/type problems become a form error instead of a crash.
function withTaxDoc(field) {
  const mw = docUpload.single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The tax document must be under 5 MB.' : `Upload failed: ${err.message}`;
    next();
  });
}

// Normalises and checks country + tax number; `needDoc` is true when no certificate is on file.
function checkTax({ country, gstin, taxId }, { docUploaded, needDoc, rejected, uploadError }) {
  const out = { country: COUNTRIES.includes(country) ? country : 'India', gstin: null, taxId: null, pan: null, errors: [] };
  if (uploadError) out.errors.push(uploadError);
  if (isIndia(out.country)) {
    out.gstin = String(gstin || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!out.gstin) out.errors.push('GSTIN is required for agencies in India.');
    else if (!GSTIN_RE.test(out.gstin)) out.errors.push('GSTIN should be 15 characters, like 27ABCDE1234F1Z5.');
    out.pan = panFromGstin(out.gstin);
  } else {
    out.taxId = String(taxId || '').trim().toUpperCase().slice(0, 40);
    if (out.taxId.length < 4) out.errors.push(`Enter your company's tax registration number in ${out.country}.`);
  }
  if (rejected) out.errors.push('The tax document must be a PDF, JPG, PNG or WebP file.');
  else if (needDoc && !docUploaded) out.errors.push(isIndia(out.country) ? 'Upload your GST registration certificate.' : 'Upload your tax registration certificate.');
  return out;
}

const removeDoc = (file) => { if (file) fs.rmSync(path.join(KYC_DIR, path.basename(file)), { force: true }); };

module.exports = { KYC_DIR, COUNTRIES, GSTIN_RE, isIndia, panFromGstin, withTaxDoc, checkTax, removeDoc };

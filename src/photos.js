// Cover photos for activities and packages: JPG/PNG/WebP up to 5 MB, saved under <uploads>/photos.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { UPLOADS_DIR } = require('./db');
const { persistFile } = require('./files');

const PHOTO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const PHOTO_DIR = path.join(UPLOADS_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    // Extension comes from the checked MIME type, never from the uploaded filename.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${PHOTO_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10000, fieldSize: 1024 * 1024 },
  // SVG is excluded on purpose: uploaded SVGs can carry scripts.
  fileFilter: (req, file, cb) => {
    const ok = Boolean(PHOTO_TYPES[file.mimetype]);
    if (!ok) req.photoRejected = true;
    cb(null, ok);
  },
}).single('cover_file');

/** Middleware: parses a multipart form with an optional cover_file, turning upload errors into a message. */
function withCover(AppError) {
  return (req, res, next) => upload(req, res, (err) => {
    if (err) return next(new AppError(err.code === 'LIMIT_FILE_SIZE' ? 'The photo must be under 5 MB.' : `Upload failed: ${err.message}`));
    if (req.file) persistFile(req.file.path);
    next();
  });
}

/** The cover URL after the form: a new upload, removal, a pasted link, or the current one. */
function coverFrom(req, current) {
  if (req.photoRejected) req.flash('warn', 'Photo skipped: use a JPG, PNG or WebP image.');
  if (req.file) return `/uploads/photos/${req.file.filename}`;
  if (req.body.remove_cover) return null;
  const link = String(req.body.image_url ?? '').trim();
  if (/^https:\/\//i.test(link)) return link;
  // Clearing the link field removes a linked (not uploaded) cover.
  if (current && /^https:/i.test(current) && req.body.image_url !== undefined) return null;
  return current || null;
}

module.exports = { withCover, coverFrom };

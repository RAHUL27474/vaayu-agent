// Minimal .xlsx reader for bulk import: returns each worksheet's rows as arrays of strings.
// An .xlsx file is a zip of XML parts; we read the zip directory, inflate the parts we need
// (workbook, shared strings, the sheets) and pull out cell values. No formulas are evaluated:
// Excel stores the last computed value of each formula cell, and that is what we read.
const zlib = require('zlib');

class XlsxError extends Error {}

/** Map of entry name → Buffer for the zip parts we ask for. */
function unzip(buf, wanted) {
  // End of central directory record: signature 0x06054b50 within the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('This is not a valid Excel (.xlsx) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('This Excel file is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out[name] = data;
    // Cap the inflated size so a tiny "zip bomb" can't exhaust memory.
    else if (method === 8) out[name] = zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
    else throw new XlsxError('This Excel file uses an unsupported compression.');
  }
  return out;
}

const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
});
/** Concatenated text of all <t> runs inside an XML fragment (handles rich text). */
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function sheetRows(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="([^"]*)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] || '';
      else if (type === 'inlineStr') val = textOf(body);
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = decode(v);
      // Numbers stored with float noise (e.g. 3900.0000000001) read back as Excel shows them.
      if (!type && /^-?\d+\.\d{9,}$/.test(val)) val = String(Number(Number(val).toFixed(6)));
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => x || ''));
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/** Every worksheet in workbook order: [{ name, rows }], blank rows dropped. */
function readXlsx(buf) {
  const parts = unzip(buf, (n) => /^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(n));
  const wb = parts['xl/workbook.xml'];
  if (!wb) throw new XlsxError('This is not a valid Excel (.xlsx) file.');
  const sheets = [...wb.toString('utf8').matchAll(/<sheet\b[^>]*?\bname="([^"]*)"[^>]*?\br:id="([^"]*)"/g)].map((m) => ({ name: decode(m[1]), rid: m[2] }));
  if (!sheets.length) throw new XlsxError('The Excel file has no sheets.');
  const rels = Object.fromEntries([...(parts['xl/_rels/workbook.xml.rels'] || '').toString('utf8').matchAll(/<Relationship\b[^>]*?\bId="([^"]*)"[^>]*?\bTarget="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const shared = [...(parts['xl/sharedStrings.xml'] || '').toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  return sheets.map(({ name, rid }) => {
    const xml = parts[`xl/${(rels[rid] || '').replace(/^\/?(xl\/)?/, '')}`];
    if (!xml) throw new XlsxError(`Could not read the sheet "${name}".`);
    return { name, rows: sheetRows(xml.toString('utf8'), shared) };
  });
}

module.exports = { readXlsx, XlsxError };

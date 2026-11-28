// Minimal .xlsx writer for downloads: one worksheet with a title, a styled header row, typed cells
// (money, numbers, dates as real Excel dates) and a totals row. An .xlsx file is a zip of XML parts;
// we build the parts and zip them here, so no spreadsheet library is needed.
const zlib = require('zlib');

// ---------- zip ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = zlib.crc32 || ((buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
});

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0x00210000, 10); // fixed DOS time/date (1 Jan 1980)
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0x00210000, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

// ---------- sheet ----------
// Text without the control characters XML 1.0 does not allow.
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// Style ids in styles.xml below.
const S = { text: 0, header: 1, money: 2, int: 3, date: 4, datetime: 5, title: 6, meta: 7, totalLabel: 8, totalMoney: 9, totalInt: 10, pct: 11 };

// "2026-11-23 06:43:57" (UTC) or "2026-11-23" → Excel serial day number. Times are shown in India time.
function excelDate(v, withTime) {
  const s = String(v || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (withTime && m[4] !== undefined) ms += 330 * 60000;
  const serial = ms / 864e5 + 25569;
  return withTime ? serial : Math.floor(serial);
}

function cell(ref, type, v) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money' || type === 'int' || type === 'pct') {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return `<c r="${ref}" s="${S[type]}"><v>${type === 'money' ? Math.round(n * 100) / 100 : n}</v></c>`;
  }
  if (type === 'date' || type === 'datetime') {
    const d = excelDate(v, type === 'datetime');
    if (d === null) return '';
    return `<c r="${ref}" s="${S[type]}"><v>${d}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

const textWidth = (type, v) => {
  if (type === 'date') return 12;
  if (type === 'datetime') return 17;
  if (type === 'money') return Math.max(12, String(Math.round(Number(v) || 0)).length + 6);
  return String(v ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0) * 1.1 + 3;
};

/**
 * Builds the workbook. columns: [{ h: 'Header', t: 'text'|'money'|'int'|'pct'|'date'|'datetime', v: (row) => value }].
 * Money and number columns get a SUBTOTAL row at the bottom, so it follows Excel's filters.
 */
function buildXlsx({ sheet = 'Sheet1', title = '', meta = '', columns, rows }) {
  const width = columns.length;
  const last = colName(width - 1);
  const out = [];
  const widths = columns.map((c) => Math.max(c.h.length * 1.15 + 4, 8));
  let r = 1;
  if (title) out.push(`<row r="${r}" ht="22" customHeight="1">${cell(`A${r}`, 'text', title).replace('<c ', `<c s="${S.title}" `)}</row>`), r++;
  if (meta) out.push(`<row r="${r}">${cell(`A${r}`, 'text', meta).replace('<c ', `<c s="${S.meta}" `)}</row>`), r++;
  if (title || meta) r++; // a blank row before the table
  const headRow = r;
  out.push(`<row r="${r}" ht="20" customHeight="1">${columns.map((c, i) => cell(`${colName(i)}${r}`, 'text', c.h).replace('<c ', `<c s="${S.header}" `)).join('')}</row>`);
  r++;
  const first = r;
  for (const row of rows) {
    const cells = columns.map((c, i) => {
      let v;
      try { v = c.v(row); } catch { v = ''; }
      widths[i] = Math.max(widths[i], textWidth(c.t, v));
      return cell(`${colName(i)}${r}`, c.t || 'text', v);
    });
    out.push(`<row r="${r}">${cells.join('')}</row>`);
    r++;
  }
  const lastData = r - 1;
  const summed = columns.map((c) => ['money', 'int'].includes(c.t) && !c.noTotal);
  if (rows.length > 1 && summed.some(Boolean)) {
    const cells = columns.map((c, i) => {
      const ref = `${colName(i)}${r}`;
      if (summed[i]) return `<c r="${ref}" s="${c.t === 'money' ? S.totalMoney : S.totalInt}"><f>SUBTOTAL(9,${colName(i)}${first}:${colName(i)}${lastData})</f></c>`;
      return `<c r="${ref}" s="${S.totalLabel}"${i === 0 ? ' t="inlineStr"><is><t>Total</t></is></c>' : '/>'}`;
    });
    out.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, w)}" customWidth="1"/>`).join('');
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16"/><cols>${cols}</cols>
<sheetData>${out.join('')}</sheetData>
${rows.length ? `<autoFilter ref="A${headRow}:${last}${lastData}"/>` : ''}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
  const name = esc(String(sheet).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1');
  const definedNames = rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$${headRow}:$${last}$${lastData}</definedName></definedNames>` : '';
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets>${definedNames}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="dd mmm yyyy"/><numFmt numFmtId="166" formatCode="dd mmm yyyy, hh:mm"/><numFmt numFmtId="167" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF0E7490"/><name val="Calibri"/><family val="2"/></font><font><i/><sz val="9"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E7490"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFECFEFF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF0E7490"/></top><bottom style="double"><color rgb="FF0E7490"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="3" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheetXml],
  ]);
}

module.exports = { buildXlsx, excelDate };

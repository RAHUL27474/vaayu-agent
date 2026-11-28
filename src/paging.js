// Long lists show one page at a time. Queries fetch one extra row to know whether a next page exists,
// so no separate COUNT query is needed. Usage:
//   const p = paging(req);
//   const rows = await all(`SELECT … ORDER BY … ${p.sql}`, ...params, ...p.params);
//   const { rows: shown, pager } = pageOf(rows, p);   → render with <%- include('../partials/pager', { pager }) %>
const { wantsXlsx, MAX_ROWS } = require('./exports');

const PER_PAGE = 50;

function paging(req, per = PER_PAGE) {
  // An Excel download (?download=xlsx) takes the whole list in one go.
  if (wantsXlsx(req)) return { page: 1, per: MAX_ROWS, sql: 'LIMIT ? OFFSET ?', params: [MAX_ROWS + 1, 0] };
  const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  return { page, per, sql: 'LIMIT ? OFFSET ?', params: [per + 1, (page - 1) * per] };
}

const pageOf = (rows, p) => ({ rows: rows.slice(0, p.per), pager: { page: p.page, more: rows.length > p.per } });

module.exports = { paging, pageOf, PER_PAGE };

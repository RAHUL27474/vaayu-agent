// Long lists show one page at a time. Queries fetch one extra row to know whether a next page exists,
// so no separate COUNT query is needed. Usage:
//   const p = paging(req);
//   const rows = await all(`SELECT … ORDER BY … ${p.sql}`, ...params, ...p.params);
//   const { rows: shown, pager } = pageOf(rows, p);   → render with <%- include('../partials/pager', { pager }) %>
const PER_PAGE = 50;

function paging(req, per = PER_PAGE) {
  const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  return { page, per, sql: 'LIMIT ? OFFSET ?', params: [per + 1, (page - 1) * per] };
}

const pageOf = (rows, p) => ({ rows: rows.slice(0, p.per), pager: { page: p.page, more: rows.length > p.per } });

module.exports = { paging, pageOf, PER_PAGE };

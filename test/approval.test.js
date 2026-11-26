// Booking requests: with booking approval on, an agent cannot pay for a quote until VaayuTrip operations
// (backend team) approve it. Checked: blocking, the request, reject with reason, approve and pay, a quote
// changed after approval, an expired approval, who can decide, and the admin switch.
(async () => {
  const { start, finish, check, db, ROLES } = require('./helpers');
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const c = await start({ bookingApproval: true });
  const agent = await c.login(...ROLES.agent);
  const backend = await c.login(...ROLES.backend);
  const admin = await c.login(...ROLES.admin);

  const acts = await db.prepare("SELECT id FROM products WHERE kind = 'activity' AND status = 'published' ORDER BY id LIMIT 2").all();
  const newQuote = async (title) => {
    const qid = Number((await c.post('/agent/quotes', agent, { title })).headers.get('location').match(/(\d+)$/)[1]);
    await c.post(`/agent/activities/${acts[0].id}/quote`, agent, { quote_id: String(qid) });
    return qid;
  };
  const booked = async (qid) => !!(await one('SELECT id FROM bookings WHERE quote_id = ?', qid));
  const status = async (qid) => (await one('SELECT approval_status FROM quotes WHERE id = ?', qid)).approval_status;

  // ---------- blocked until approved ----------
  let qid = await newQuote('Approval trip 1');
  let page = await (await c.get(`/agent/quotes/${qid}`, agent)).text();
  check('quote page offers a booking request, not payment', page.includes('Send booking request') && !page.includes('action="/agent/quotes/' + qid + '/book"'));
  let msg = await c.follow(await c.post(`/agent/quotes/${qid}/book`, agent, {}), agent);
  check('booking without approval is refused', !(await booked(qid)) && msg.includes('booking request first'));

  // ---------- request ----------
  await c.post(`/agent/quotes/${qid}/request-booking`, agent, { note: 'Need sunset slot' });
  check('request is recorded', await status(qid) === 'requested');
  check('operations are notified', !!(await one("SELECT id FROM notifications WHERE agency_id IS NULL AND title = 'New booking request' AND link = ?", `/backend/booking-requests/${qid}`)));
  page = await (await c.get(`/agent/quotes/${qid}`, agent)).text();
  check('agent sees that it is waiting', page.includes('Waiting for VaayuTrip approval') && page.includes('Booking request sent'));
  check('booking while waiting is refused', (await c.follow(await c.post(`/agent/quotes/${qid}/book`, agent, {}), agent)).includes('still confirming') && !(await booked(qid)));
  const list = await (await c.get('/backend/booking-requests', backend)).text();
  check('backend team sees the request with a count in the menu', list.includes('Approval trip 1') && /Booking requests<\/span><b class="count">1<\/b>/.test(list));
  check('request page shows the agent note and services', (await (await c.get(`/backend/booking-requests/${qid}`, backend)).text()).includes('Need sunset slot'));
  check('agents cannot open booking requests', (await c.get('/backend/booking-requests', agent)).status !== 200);

  // ---------- reject needs a reason ----------
  await c.post(`/backend/booking-requests/${qid}/decide`, backend, { decision: 'reject', note: '' });
  check('reject without a reason is refused', await status(qid) === 'requested');
  await c.post(`/backend/booking-requests/${qid}/decide`, backend, { decision: 'reject', note: 'Sold out that evening' });
  check('rejected with a reason', await status(qid) === 'rejected');
  const agencyId = (await one('SELECT agency_id FROM quotes WHERE id = ?', qid)).agency_id;
  check('agent is told why', !!(await one("SELECT id FROM notifications WHERE agency_id = ? AND title = 'Booking request not approved' AND body LIKE '%Sold out that evening%'", agencyId)));
  check('quote page shows the reason and lets the agent send it again', (await (await c.get(`/agent/quotes/${qid}`, agent)).text()).includes('Sold out that evening'));

  // ---------- approve, then pay ----------
  await c.post(`/agent/quotes/${qid}/request-booking`, agent, {});
  await c.post(`/backend/booking-requests/${qid}/decide`, admin, { decision: 'approve', note: 'Confirmed', hours: '24' });
  check('admin can approve too', await status(qid) === 'approved');
  page = await (await c.get(`/agent/quotes/${qid}`, agent)).text();
  check('approved quote shows the pay buttons and the deadline', page.includes('Approved by VaayuTrip operations') && page.includes(`action="/agent/quotes/${qid}/book"`));
  await c.post(`/agent/quotes/${qid}/book`, agent, {});
  check('approved quote can be booked', await booked(qid));

  // ---------- changed after approval ----------
  qid = await newQuote('Approval trip 2');
  await c.post(`/agent/quotes/${qid}/request-booking`, agent, {});
  await c.post(`/backend/booking-requests/${qid}/decide`, backend, { decision: 'approve', hours: '24' });
  await c.post(`/agent/activities/${acts[1].id}/quote`, agent, { quote_id: String(qid) });
  msg = await c.follow(await c.post(`/agent/quotes/${qid}/book`, agent, {}), agent);
  check('a quote changed after approval cannot be booked', !(await booked(qid)) && msg.includes('changed after VaayuTrip approved'));

  // ---------- expired ----------
  qid = await newQuote('Approval trip 3');
  await c.post(`/agent/quotes/${qid}/request-booking`, agent, {});
  await c.post(`/backend/booking-requests/${qid}/decide`, backend, { decision: 'approve', hours: '12' });
  await db.prepare("UPDATE quotes SET approval_until = datetime('now', '-1 hour') WHERE id = ?").run(qid);
  msg = await c.follow(await c.post(`/agent/quotes/${qid}/book`, agent, {}), agent);
  check('an expired approval cannot be booked', !(await booked(qid)) && msg.includes('expired'));

  // ---------- withdraw ----------
  qid = await newQuote('Approval trip 4');
  await c.post(`/agent/quotes/${qid}/request-booking`, agent, {});
  await c.post(`/agent/quotes/${qid}/withdraw-request`, agent, {});
  check('agent can withdraw a request', await status(qid) === null);

  // ---------- admin switch ----------
  await c.post('/admin/settings', admin, { booking_approval: '0' });
  qid = await newQuote('No approval needed');
  await c.post(`/agent/quotes/${qid}/book`, agent, {});
  check('with the switch off, agents book directly', await booked(qid));

  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });

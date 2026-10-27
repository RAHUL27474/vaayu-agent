/**
 * Pricing and invoicing rules.
 *
 * Every quote line has a net price (what the agent pays VaayuTrip) and a sell price
 * (what the customer pays). The sell price is either set by the agent on the line,
 * or derived from the quote's markup (percent of net, or a flat amount spread across
 * lines in proportion to their net). The difference is the agent's commission.
 *
 * Lines with supplier "agent" are the agent's own services (e.g. their guide or
 * visa help). They have no VaayuTrip cost and can only be billed on the agent's
 * own branded invoice.
 *
 * Customer invoices come in two kinds:
 *  - customer_agent: issued by the agency under its own name and logo, all lines.
 *  - customer_vaayu: issued by VaayuTrip for agents without their own branding;
 *    prices include the agent's commission (embedded, or as a separate service-fee line).
 * Plus a b2b invoice from VaayuTrip to the agency at net prices.
 */
const { round2 } = require('./util');

function taxRate(settings) {
  return Number(settings.tax_rate ?? 5);
}

function priceQuote(quote, items) {
  const vaayuAuto = items.filter((i) => i.supplier === 'vaayu' && i.sell_price == null);
  const autoNetTotal = vaayuAuto.reduce((s, i) => s + i.net_price * i.qty, 0);

  const lines = items.map((i) => {
    let unitSell;
    if (i.sell_price != null) unitSell = i.sell_price;
    else if (i.supplier === 'agent') unitSell = i.net_price;
    else if (quote.markup_type === 'flat') {
      const share = autoNetTotal ? (i.net_price * i.qty) / autoNetTotal : 0;
      unitSell = i.net_price + (quote.markup_value * share) / (i.qty || 1);
    } else unitSell = i.net_price * (1 + quote.markup_value / 100);

    const unitNet = i.supplier === 'agent' ? 0 : i.net_price;
    const lineNet = round2(unitNet * i.qty);
    const lineSell = round2(unitSell * i.qty);
    return {
      ...i,
      unitNet: round2(unitNet),
      unitSell: round2(unitSell),
      lineNet,
      lineSell,
      commission: round2(lineSell - lineNet),
      overridden: i.sell_price != null,
    };
  });

  const vaayuLines = lines.filter((l) => l.supplier === 'vaayu');
  const agentLines = lines.filter((l) => l.supplier === 'agent');
  const sum = (arr, k) => round2(arr.reduce((s, l) => s + l[k], 0));

  return {
    lines,
    net: sum(vaayuLines, 'lineNet'),
    sell: sum(lines, 'lineSell'),
    vaayuSell: sum(vaayuLines, 'lineSell'),
    vaayuCommission: sum(vaayuLines, 'commission'),
    agentItemsTotal: sum(agentLines, 'lineSell'),
    commission: round2(sum(vaayuLines, 'commission') + sum(agentLines, 'lineSell')),
    hasAgentItems: agentLines.length > 0,
  };
}

/**
 * GST on the subtotal, plus TCS for overseas tour packages sold to customers
 * (collected on the amount including GST). Confirm current rates with your CA;
 * both are configurable in admin settings.
 */
function withTax(subtotal, settings, { international = false } = {}) {
  const rate = taxRate(settings);
  const tax = round2((subtotal * rate) / 100);
  const tcsRate = international ? Number(settings.tcs_rate ?? 2) : 0;
  const tcs = round2(((subtotal + tax) * tcsRate) / 100);
  return { subtotal: round2(subtotal), taxRate: rate, tax, tcsRate, tcs, total: round2(subtotal + tax + tcs) };
}

// Monthly instalments for an amount at the configured annual interest rate.
function emiPlans(amount, settings) {
  const annual = Number(settings.emi_rate ?? 14);
  const r = annual / 12 / 100;
  return [3, 6, 9, 12].map((n) => {
    const monthly = r ? (amount * r * (1 + r) ** n) / ((1 + r) ** n - 1) : amount / n;
    return { months: n, monthly: Math.ceil(monthly), total: Math.ceil(monthly) * n, rate: annual };
  });
}

function agencyHasBranding(agency) {
  return Boolean(agency && agency.logo_path && agency.name);
}

function vaayuParty(settings) {
  return {
    name: settings.company_name || 'VaayuTrip',
    legalName: settings.legal_name || settings.company_name || 'VaayuTrip',
    gstin: settings.gstin || '',
    address: settings.address || '',
    phone: settings.phone || '',
    email: settings.email || '',
    logo: '/img/vaayutrip-logo.svg',
    color: '#0e7490',
  };
}

function agencyParty(agency) {
  return {
    name: agency.name,
    legalName: agency.legal_name || agency.name,
    gstin: agency.gstin || '',
    taxId: agency.tax_id || '',
    address: [agency.address, agency.city, agency.country && agency.country !== 'India' ? agency.country : ''].filter(Boolean).join(', '),
    phone: agency.phone || '',
    email: agency.email || '',
    logo: agency.logo_path || null,
    color: agency.brand_color || '#0e7490',
  };
}

function customerParty(customer, quote) {
  return customer
    ? { name: customer.name, email: customer.email || '', phone: customer.phone || '', address: customer.city || '' }
    : { name: quote.title, email: '', phone: '', address: '' };
}

/** Builds the JSON snapshot stored on an invoice. kind: customer_agent | customer_vaayu | b2b */
function buildInvoice(kind, { quote, items, agency, customer, settings }) {
  const priced = priceQuote(quote, items);
  const meta = {
    quoteCode: quote.code,
    trip: quote.title,
    travelDate: quote.travel_date,
    travellers: `${quote.adults} adult${quote.adults === 1 ? '' : 's'}${quote.children ? `, ${quote.children} child${quote.children === 1 ? '' : 'ren'}` : ''}${quote.infants ? `, ${quote.infants} infant${quote.infants === 1 ? '' : 's'}` : ''}`,
  };
  let seller;
  let buyer;
  let lines;
  const notes = [];

  if (kind === 'customer_agent') {
    seller = agencyParty(agency);
    buyer = customerParty(customer, quote);
    lines = priced.lines.map((l) => ({ title: l.title, description: l.description, qty: l.qty, unit: l.unitSell, amount: l.lineSell }));
  } else if (kind === 'customer_vaayu') {
    seller = vaayuParty(settings);
    buyer = customerParty(customer, quote);
    const vaayuLines = priced.lines.filter((l) => l.supplier === 'vaayu');
    if (quote.show_service_fee) {
      lines = vaayuLines.map((l) => ({ title: l.title, description: l.description, qty: l.qty, unit: l.unitNet, amount: l.lineNet }));
      if (priced.vaayuCommission) {
        lines.push({ title: `Service fee — ${agency.name}`, description: 'Travel agent service charge', qty: 1, unit: priced.vaayuCommission, amount: priced.vaayuCommission });
      }
    } else {
      lines = vaayuLines.map((l) => ({ title: l.title, description: l.description, qty: l.qty, unit: l.unitSell, amount: l.lineSell }));
    }
    meta.bookedThrough = agency.name;
    if (priced.hasAgentItems) notes.push(`Services provided directly by ${agency.name} are billed separately.`);
  } else {
    seller = vaayuParty(settings);
    buyer = { ...agencyParty(agency), address: agencyParty(agency).address };
    lines = priced.lines
      .filter((l) => l.supplier === 'vaayu')
      .map((l) => ({ title: l.title, description: l.description, qty: l.qty, unit: l.unitNet, amount: l.lineNet }));
    notes.push('B2B invoice at agent net rates. Not for customer use.');
  }

  const totals = withTax(lines.reduce((s, l) => s + l.amount, 0), settings, { international: kind !== 'b2b' && Boolean(quote.is_international) });
  return { kind, seller, buyer, meta, lines, totals, notes };
}

module.exports = { priceQuote, withTax, emiPlans, buildInvoice, agencyHasBranding, vaayuParty, taxRate };

# VaayuTrip Agent

The VaayuTrip B2B platform for travel agents. VaayuTrip publishes holiday packages at agent net rates. Agents customise them, add their commission and their own services, share quotes, collect payments, book, and invoice their customers, either under their own brand or with a VaayuTrip invoice that includes their commission.

## Run it

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite, so there is nothing to compile).

```
npm install
npm start            # http://localhost:3000
npm run dev          # same, restarts on file changes
npm run seed         # wipe the database and reload demo data
npm run packages:sync  # add any catalogue packages missing from your database (keeps your data)
```

The first start creates `data/vaayutrip.db` with demo data.

| Role | Email | Password |
|---|---|---|
| VaayuTrip admin | `admin@vaayutrip.com` | `admin123` |
| Agent with own branding (Skyline Holidays) | `agent@skyline.com` | `agent123` |
| Agent without branding (Ravi Tours) | `agent@ravitours.com` | `agent123` |
| Agent awaiting approval (Wanderlust Trips) | `agent@wanderlust.in` | `agent123` |

Change these passwords before putting the app anywhere public.

## Adding your packages (admin)

1. Log in as admin, open **Packages**, click **+ New package**.
2. Fill the sections. Rows (cities, days, hotels, flights, rates, extras, departures, cancellation slabs) are added with the **+ Add** buttons:
   basics and photos, route, day-wise itinerary, hotels for each category, flights and airfare, per-person rates by season, extras, fixed departures (group tours only), inclusions/exclusions, and policies.
3. **Save package**: it stays a draft. The side panel lists anything missing before it can be published (rates, hotels for each priced category, itinerary).
4. **Preview as agent** shows the page and price calculator exactly as agents see it (at net prices).
5. **Publish to agents**: every active agent is notified and can quote it straight away. **Duplicate** copies a package as a starting point for a similar one.

Photos: upload a cover and up to 12 gallery photos (JPG, PNG or WebP, 5 MB each), or paste image links. Without a photo, a cover with the destination name is shown.

The portal ships with demo packages. Click **Remove demo packages** on the Packages page when you start adding your own; quotes already created keep their copy of the package.

## What's inside

**VaayuTrip admin (`/admin`)**
- Packages: a 10-section editor covering:
  1. basics (type, international, highlights, gallery)
  2. route (cities with nights)
  3. day-wise itinerary with meals (B/L/D), overnight stop and optional activities
  4. hotels per category (Standard / Deluxe / Premium / Luxury) with stars, room type and meal plan (EP/CP/MAP/AP)
  5. flights with indicative schedules, plus net airfare for adult, child and infant
  6. seasonal land rates per person (twin, triple, single, child with bed, child without bed, infant)
  7. add-ons (included or optional, per person or per booking)
  8. fixed group departures with seat counts
  9. inclusions and exclusions
  10. policies (advance and balance terms, cancellation slabs, child policy, notes, terms)

  A package can't be published until rates, hotels and an itinerary are in place. Publishing notifies every active agent. Packages can be duplicated.
- Agents: approve signups, verify KYC, suspend, set credit limits, adjust wallets. View each agency's tax certificate; KYC can only be marked verified once a GSTIN or tax ID and a certificate are on file.
- Offers & deals: publish promotions (with optional promo code, expiry and portal link) to every agent's dashboard. Pause or delete them any time.
- Support tickets: reply to agents' tickets and close them; open tickets show a count in the menu.
- Bookings: view every booking with lead-traveller details, approve or decline cancellations, refund to credit or wallet.
- Wallet top-ups: verify the UTR and approve to credit the agent's wallet.
- Invoices: all B2B, VaayuTrip-to-customer and agent-branded invoices.
- Settings: company details printed on VaayuTrip invoices, GST rate, EMI interest rate.

**Signup (`/signup`)**
- Agencies pick their country of registration. Indian agencies must give a valid GSTIN (the PAN is read from it) and upload their GST certificate. Agencies abroad give their company tax ID (VAT, TRN, EIN, ABN…) and upload a tax registration certificate.
- Certificates (PDF, JPG, PNG or WebP, up to 5 MB) are stored privately under the data directory, never in `public/`, and only admins can open them. Agents can update their tax details later under Company & branding, which sends KYC back for review.

**Agent portal (`/agent`)**
- Dashboard: a setup checklist until the agency is fully onboarded, live offers, and a 6-month earnings chart.
- Reports: bookings, sales, net, earnings and margin for any date range, earnings by month, top destinations and top customers, plus CSV export of bookings and the wallet ledger.
- Offers & deals, and Help & support (tickets with VaayuTrip, plus phone, WhatsApp and email contacts).
- Package pages have a share bar that sends the package from the agent's own website on WhatsApp.
- Book: holiday packages, flights, hotels, transfers and cabs, travel insurance.
- Package calculator: choose hotel category, travel date (or fixed departure), rooms, adults, children with/without bed, infants, flights on/off and optional extras. It splits adults into twin/triple/single rooms (max 3 per room), applies the right season, and shows each line, the net, the agent's markup and the per-person price. Quotes keep a frozen copy of the itinerary, hotels, flights and policies, so later package edits don't change quotes already sent.
- International packages add TCS (configurable, 2% by default from April 2026) to customer invoices. Fixed departures hold seats on booking and release them on cancellation.
- Quotes: start from a package or a search result. For each line, set your own price (never below net) or use your percent or flat markup. Add your own services (guide, decoration, visa help). See your earning live.
- Customer invoice choice per quote:
  - **My company's invoice**: your name, logo, GSTIN and colour, with all your edited items. Needs a logo uploaded under Company & branding.
  - **VaayuTrip invoice**: for agents without branding. It's issued by VaayuTrip, names the agent as "Booked through", and its prices include the agent's commission. The commission can be built into the line prices or shown as a separate "Service fee" line.
  - Every booking also generates a **B2B invoice** from VaayuTrip to the agent at net rates.
- Share link (`/q/<code>`) with EMI options and an Accept button, plus WhatsApp sharing (straight to the customer's number when it's on file) and payment links (`/pay/<code>`).
- Book now: pays VaayuTrip net + GST, from the wallet first and then the credit line.
- Bookings and cancellation requests, customers (CRM), and leads (manual, website, API) with one-click conversion to a quote.
- Wallet & credit, invoices, payment links, notifications.
- **My website** (`/site/<agency-slug>`): the agent's own travel website with their branding, every VaayuTrip package at their prices, and an enquiry form that creates leads.
- **API access**: `GET /api/v1/packages`, `GET /api/v1/packages/:slug`, `POST /api/v1/leads`, `GET /api/v1/bookings`, authenticated with `Authorization: Bearer <key>`.

## How prices work

```
net (what the agent pays VaayuTrip)
+ agent commission (their price per line, or the quote's % / flat markup)
+ agent's own services (agent-branded invoice only)
= customer subtotal, + GST = customer total
```

The agent pays VaayuTrip `net + GST` when booking. Their earning is `customer subtotal − net`. The rules live in [src/pricing.js](src/pricing.js).

## Project layout

```
server.js               app setup, sessions, layout rendering
src/db.js               SQLite schema and helpers
src/pricing.js          markup, totals, GST/TCS, EMI and invoice snapshots
src/packages.js         package structure, editor parsing, occupancy and season pricing
src/seed-packages.js    domestic demo packages (Goa, Kashmir, Rajasthan, Kerala) + Bali and Dubai group tour
src/seed-packages-intl.js  Vietnam, Cambodia, UK, Europe group tour, Dubai & Abu Dhabi, Bali honeymoon
src/sync-packages.js    inserts catalogue packages that are missing (matched by slug)
src/services.js         quotes, booking, wallet/credit, cancellations, invoices
src/inventory.js        sample flight/hotel/transfer/insurance inventory
src/routes/             public.js, agent.js, admin.js, api.js
views/                  EJS templates (layouts, agent, admin, public, invoice)
public/                 CSS, JS, logos, uploaded agency logos
```

## Before going live

- **Package content:** hotel names are illustrative ("or similar"), flight schedules are indicative, and rates and visa costs are estimates. Replace them with your contracted hotels, airline fares and current visa fees, and upload photos you own or have licensed (packages without a photo show a generated destination cover).
- **Supplier inventory:** flights, hotels, transfers and insurance return realistic sample results from [src/inventory.js](src/inventory.js). Swap those functions for real supplier APIs (e.g. TBO, Amadeus, Hotelbeds); the rest of the app only depends on the result shape.
- **Payments:** payment links use a demo checkout. Connect Razorpay or Cashfree and mark links paid from their webhook. Wallet top-ups are verified manually by UTR.
- **Hosting:** set `SESSION_SECRET`, run behind HTTPS, and back up `data/` and `public/uploads/`. For multiple servers, move from SQLite to Postgres (for example Supabase). `DATA_DIR` and `UPLOADS_DIR` override where the database and uploads are stored.
- **Vercel (demo only):** on Vercel the app stores the database and uploads in `/tmp`, which is wiped whenever a server instance starts, and each instance has its own copy. The demo data is re-seeded on every fresh start, so bookings, wallet changes and uploads don't last. Set `SESSION_SECRET` in the project's environment variables so logins work across instances. For real use, host on a server with a persistent disk or move the data to Postgres.
- **Email/WhatsApp:** notifications are in-app only. Add an email or WhatsApp Business API provider to send them.
- **Invoices:** invoices print to PDF from the browser. Have your CA confirm the GST treatment (rate, SAC code, place of supply) before issuing real tax invoices.

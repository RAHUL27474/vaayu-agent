# VaayuTrip Agent

The VaayuTrip B2B platform for travel agents, for international travel to Dubai, Bali, Vietnam, Cambodia, the United Kingdom and Europe. VaayuTrip does not sell packages. Its backend team enters the building blocks separately (airfares, hotels, activities, transfers, visas and travel insurance) at agent net rates. Agents build their own packages from them, add anything they arrange themselves, set their prices, share quotes, collect payments, book, and invoice their customers, either under their own brand or with a VaayuTrip invoice that includes their commission. Admins monitor everything through an activity log.

## Run it

Requires Node.js 22.13 or newer. The database is Postgres: the live site uses Supabase, and locally the app runs an embedded Postgres (PGlite), so there is no database server to install.

```
npm install
npm start            # http://localhost:3000
npm run dev          # same, restarts on file changes
npm run seed         # wipe the local database and reload demo data (refused when DATABASE_URL is set)
```

The first start creates a local database in `data/pg` with demo data: 88 inventory items (36 activities, 18 hotels, 14 airfares, 11 transfers, 6 visas, 3 insurance plans) and packages that the demo agencies built from them.

| Role | Email | Password |
|---|---|---|
| VaayuTrip admin | `admin@vaayutrip.com` | `admin123` |
| Backend team (enters inventory) | `backend@vaayutrip.com` | `backend123` |
| Agent with own branding (Skyline Holidays) | `agent@skyline.com` | `agent123` |
| Agent without branding (Ravi Tours) | `agent@ravitours.com` | `agent123` |
| Agent awaiting approval (Wanderlust Trips) | `agent@wanderlust.in` | `agent123` |

Change these passwords before putting the app anywhere public.

## Entering inventory (backend team)

The backend team logs in and lands on the **backend portal** (`/backend`). Admins can open it too, from **Inventory (backend)** in their menu.

1. **+ Add inventory**, then choose the type: activity, hotel, airfare, transfer, visa or insurance.
2. Fill in the city and country, which must be in one of the destinations (insurance can cover all of them), the description and the type-specific details:
   - **Hotels:** stars, room type and meal plan.
   - **Airfares:** airline, flight numbers, airports, times, one-way or return, and baggage.
   - **Visas:** processing time, validity and documents needed.
   - **Insurance:** medical cover and trip length.
3. Set the net price:
   - **Per person** (adult; child 2–11, where empty means the adult price; infant, where empty means free): tickets, fares, visas, insurance.
   - **Per group / vehicle** of up to N guests: private tours, cars, boats.
   - **Per room per night:** hotels.
4. Save: it's a draft. **Publish to agents** makes it available and notifies every active agent.

**Bulk import** (`/backend/import`) loads a spreadsheet saved as CSV; everything comes in as a draft to check before publishing. Download the template from that page.

The dashboard shows live and draft counts per type, a coverage grid of destinations against types (gaps are highlighted), drafts still missing information, and recent changes with who made them.

Price changes apply to new quotes only; quotes already made keep their prices. Unpublishing stops new use, and agents' packages that include the item show a warning. All destinations are abroad, so TCS applies on customer invoices.

## Building a package (agent)

1. Open **My packages**, click **+ New package** (or **Add to a package** from any item in the catalogue).
2. Basics and photo, route (cities and nights), and a day-wise itinerary.
3. **From VaayuTrip**: for each day, pick airfares, hotels (with the number of nights), activities, transfers, visas and insurance from the catalogue.
4. Optionally, **your own hotels** and **your services** (transfers, guides, decoration…) with your cost and your price.
5. Inclusions, exclusions and your own policies.
6. Open the package to price it for any party (date, adults, children, infants, rooms) and **Create quote**. **Publish to my website** puts it on the agency's website and API.

VaayuTrip items are bought at net and marked up with the quote's markup. The agent's own hotels and services appear at the agent's price on the agent-branded invoice; their cost stays private and is only used to work out the agent's earning.

## What's inside

**VaayuTrip admin (`/admin`)**
- **Activity log:** every change across the platform:
  - the backend team creating, editing, publishing or deleting inventory, with price changes flagged (old → new)
  - agents creating and publishing packages, making quotes and bookings, requesting cancellations and top-ups, raising tickets
  - admin decisions on agents, KYC, credit, wallets, top-ups, cancellations, offers and settings
  - logins, optionally

  Filter by who, area, staff member, agency and dates.
- **Team:** add backend-team members or other admins, reset their passwords, or switch accounts off. A switched-off account is logged out and can't log in.
- **Dashboard:** live inventory and drafts, packages built by agents, the most booked inventory and the latest activity.
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
- **Book from VaayuTrip:** browse activities, hotels, airfares, transfers, visas and travel insurance by destination, city, category or search, with the net price and the agent's earning. On any item:
  - price it for a party (adults, children, infants, and rooms and nights for hotels)
  - add it to a quote
  - add it to a day of one of their packages
- My packages: the package builder above. Each package page has a price calculator (date, adults, children, rooms) showing VaayuTrip items at net, the agent's markup, their hotels and services, their costs and their earning, and a share bar that sends the package from the agent's own website on WhatsApp. Quotes keep a frozen copy of the itinerary, so later package edits don't change quotes already sent.
- Every destination is abroad, so customer invoices add TCS (configurable, 2% by default from April 2026).
- Quotes: start from one of your packages or any catalogue item. For each line, set your own price (never below net) or use your percent or flat markup. Add your own services (hotel you book, guide, decoration, visa help) with your price and, privately, your cost. See your earning live.
- Customer invoice choice per quote:
  - **My company's invoice**: your name, logo, GSTIN and colour, with all your edited items. Needs a logo uploaded under Company & branding.
  - **VaayuTrip invoice**: for agents without branding. It's issued by VaayuTrip, names the agent as "Booked through", and its prices include the agent's commission. The commission can be built into the line prices or shown as a separate "Service fee" line.
  - Every booking also generates a **B2B invoice** from VaayuTrip to the agent at net rates.
- Share link (`/q/<code>`) with EMI options and an Accept button, plus WhatsApp sharing (straight to the customer's number when it's on file) and payment links (`/pay/<code>`).
- Book now: pays VaayuTrip net + GST, from the wallet first and then the credit line.
- Bookings and cancellation requests, customers (CRM), and leads (manual, website, API) with one-click conversion to a quote.
- Wallet & credit, invoices, payment links, notifications.
- **My website** (`/site/<agency-slug>`): the agent's own travel website with their branding, the packages they publish at their prices, and an enquiry form that creates leads.
- **API access**: `GET /api/v1/packages` and `GET /api/v1/packages/:slug` (the agency's published packages), `POST /api/v1/leads`, `GET /api/v1/bookings`, authenticated with `Authorization: Bearer <key>`.

## How prices work

```
net (what the agent pays VaayuTrip for activities, flights, hotels…)
+ agent commission (their price per line, or the quote's % / flat markup)
+ agent's own hotels and services at their price (agent-branded invoice only)
= customer subtotal, + GST (+ TCS abroad) = customer total
```

The agent pays VaayuTrip `net + GST` when booking, and pays their own hotels and suppliers directly. Their earning is `customer subtotal − net − their own costs`. The rules live in [src/pricing.js](src/pricing.js) and [src/packages.js](src/packages.js).

## Project layout

```
server.js               app setup, sessions, layout rendering
src/db.js               Postgres schema and async query helpers: one/all/run/tx (Supabase live, PGlite locally)
src/async-routes.js     lets Express 4 handle async route errors
src/files.js            uploaded files kept in the database, with a disk cache
src/pricing.js          markup, totals, GST/TCS, EMI and invoice snapshots
src/products.js         inventory: types, destinations, form parsing, per-person / per-group / per-room-night pricing
src/packages.js         agent-built packages: structure, builder parsing, pricing, display and quote snapshot
src/photos.js           cover photo uploads for activities and packages
src/seed-activities.js  demo activities; src/seed-inventory.js adds hotels, airfares, transfers, visas, insurance
src/seed-agent-packages.js  demo packages built by the demo agencies
src/services.js         quotes, booking, wallet/credit, cancellations, invoices
src/routes/             public.js, agent.js, admin.js, backend.js (backend portal), api.js
views/                  EJS templates (layouts, agent, admin, public, invoice)
public/                 CSS, JS, logos, uploaded agency logos
```

## Before going live

- **Photos:** upload photos you own or have licensed; items and packages without one show a generated destination cover. Agents' own hotels and services are their responsibility to fulfil.
- **Inventory:** the demo hotels are made up, and flight numbers, schedules and net rates are illustrative. The backend team should replace them with contracted inventory before agents sell. Airfares are stored as fixed fares; connect a GDS or airline API (e.g. Amadeus, TBO) if you need live availability and ticketing.
- **Payments:** payment links use a demo checkout. Connect Razorpay or Cashfree and mark links paid from their webhook. Wallet top-ups are verified manually by UTR.
- **Database:** set `DATABASE_URL` to use a hosted Postgres. The live site uses the Supabase project `vaayu-agent` (schema `portal`, database role `vaayu_app`, through the Supavisor pooler on port 6543; the connection is verified against Supabase's root certificate in `src/supabase-ca.js`). Without `DATABASE_URL` the app uses PGlite in `data/pg` (`PG_DIR=memory://` keeps it in memory, handy for tests). The schema is created and extended on start-up (skipped when its version hasn't changed); demo data is loaded once, into an empty database. Each server instance keeps a small connection pool (`DB_POOL_MAX`, default 5), so it serves many requests at once. Money changes are race-safe: wallet updates are atomic, bookings lock the agency and quote rows, and invoice numbers are serialised per series. Vercel preview deployments use a separate test database (role `vaayu_load`, schema `loadtest`), never the live data.
- **Files:** KYC documents, logos and cover photos are stored in the database (`files` table), so they survive restarts; `DATA_DIR` and `UPLOADS_DIR` only hold a disk cache. Browsers shrink large photos before upload, because Vercel accepts about 4.5 MB per request. If documents outgrow the free database (500 MB), move them to Supabase Storage.
- **Vercel:** runs in the Paris region (`vercel.json`), next to the database. Login cookies are signed with a key stored in the database, so they work on every server instance; `SESSION_SECRET` overrides it.
- **Email/WhatsApp:** notifications are in-app only. Add an email or WhatsApp Business API provider to send them.
- **Invoices:** invoices print to PDF from the browser. Have your CA confirm the GST treatment (rate, SAC code, place of supply) before issuing real tax invoices.

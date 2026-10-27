# VaayuTrip Agent

The VaayuTrip B2B platform for travel agents. VaayuTrip supplies activities (tours, attraction tickets and experiences) at agent net rates; it does not sell ready-made packages. Agents build their own holiday packages from those activities plus the hotels and services they arrange themselves, set their prices, share quotes, collect payments, book, and invoice their customers, either under their own brand or with a VaayuTrip invoice that includes their commission.

## Run it

Requires Node.js 22.13 or newer (it uses Node's built-in SQLite, so there is nothing to compile).

```
npm install
npm start            # http://localhost:3000
npm run dev          # same, restarts on file changes
npm run seed         # wipe the database and reload demo data
```

The first start creates `data/vaayutrip.db` with demo data: 38 activities in India and abroad, and packages that the demo agencies built from them.

| Role | Email | Password |
|---|---|---|
| VaayuTrip admin | `admin@vaayutrip.com` | `admin123` |
| Agent with own branding (Skyline Holidays) | `agent@skyline.com` | `agent123` |
| Agent without branding (Ravi Tours) | `agent@ravitours.com` | `agent123` |
| Agent awaiting approval (Wanderlust Trips) | `agent@wanderlust.in` | `agent123` |

Change these passwords before putting the app anywhere public.

## Adding activities (admin)

1. Log in as admin, open **Activities**, click **+ New activity**.
2. Fill in the city and country, category, duration, description, highlights, pickup point, timings, inclusions, cancellation policy and a photo.
3. Set the net price: **per person** (adult, and child 2–11; infants are free) for tickets and shared tours, or **per group** of up to N guests for private tours, boats and vehicles.
4. **Create activity**: it stays a draft. **Publish to agents** makes it available to every active agent and notifies them.

Price changes apply to new quotes only; quotes already made keep their prices. Unpublishing an activity stops new use, and agents' packages that include it show a warning. Activities outside India add TCS on customer invoices.

## Building a package (agent)

1. Open **My packages**, click **+ New package** (or **Add to a package** from any activity).
2. Basics and photo, route (cities and nights), and a day-wise itinerary.
3. **Activities from VaayuTrip**: pick the activity for each day from the catalogue.
4. **Hotels** you arrange: city, hotel, room, meal plan, nights, your cost and your price per room per night.
5. **Your services**: transfers, meals, guides, visa help and so on, per person or per booking, with your cost and price.
6. Inclusions, exclusions and your own policies.
7. Open the package to price it for any party (date, adults, children, rooms) and **Create quote**. **Publish to my website** puts it on the agency's website and API.

Activities are bought from VaayuTrip at net and marked up with the quote's markup. Hotels and services are the agent's own: they appear at the agent's price on the agent-branded invoice, and their cost stays private and is only used to work out the agent's earning.

## What's inside

**VaayuTrip admin (`/admin`)**
- Activities: the catalogue agents build from. Filter by city, category and status; see how many agent packages and bookings use each one. Publishing notifies every active agent. Activities can be duplicated.
- The dashboard shows live activities, how many packages agents have built, and the most booked activities.
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
- Activities: browse VaayuTrip's catalogue (India or international, by city, category or search) with the net price and the agent's earning. Price an activity for a party, add it to a quote, or add it to a day of one of their packages.
- My packages: the package builder above. Each package page has a price calculator (date, adults, children, rooms) showing VaayuTrip activities at net, the agent's markup, their hotels and services, their costs and their earning, and a share bar that sends the package from the agent's own website on WhatsApp. Quotes keep a frozen copy of the itinerary, so later package edits don't change quotes already sent.
- Book: flights, hotels, transfers and cabs, travel insurance, alongside activities.
- International packages and activities add TCS (configurable, 2% by default from April 2026) to customer invoices.
- Quotes: start from one of your packages, an activity or a search result. For each line, set your own price (never below net) or use your percent or flat markup. Add your own services (hotel you book, guide, decoration, visa help) with your price and, privately, your cost. See your earning live.
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
src/db.js               SQLite schema and helpers
src/pricing.js          markup, totals, GST/TCS, EMI and invoice snapshots
src/activities.js       activity catalogue: form parsing, per-person / per-group pricing
src/packages.js         agent-built packages: structure, builder parsing, pricing, display and quote snapshot
src/photos.js           cover photo uploads for activities and packages
src/seed-activities.js  demo activities (India, Dubai, Bali, Thailand, Singapore, Vietnam)
src/seed-agent-packages.js  demo packages built by the demo agencies
src/services.js         quotes, booking, wallet/credit, cancellations, invoices
src/inventory.js        sample flight/hotel/transfer/insurance inventory
src/routes/             public.js, agent.js, admin.js, api.js
views/                  EJS templates (layouts, agent, admin, public, invoice)
public/                 CSS, JS, logos, uploaded agency logos
```

## Before going live

- **Activity content:** the demo activities' net rates, timings and inclusions are illustrative estimates, and the demo agencies' hotels are made up. Replace the activities with your contracted ones and rates, and upload photos you own or have licensed (activities and packages without a photo show a generated destination cover). Agents' own hotels and services are their responsibility to fulfil.
- **Supplier inventory:** flights, hotels, transfers and insurance return realistic sample results from [src/inventory.js](src/inventory.js). Swap those functions for real supplier APIs (e.g. TBO, Amadeus, Hotelbeds); the rest of the app only depends on the result shape.
- **Payments:** payment links use a demo checkout. Connect Razorpay or Cashfree and mark links paid from their webhook. Wallet top-ups are verified manually by UTR.
- **Hosting:** set `SESSION_SECRET`, run behind HTTPS, and back up `data/` and `public/uploads/`. For multiple servers, move from SQLite to Postgres (for example Supabase). `DATA_DIR` and `UPLOADS_DIR` override where the database and uploads are stored.
- **Vercel (demo only):** on Vercel the app stores the database and uploads in `/tmp`, which is wiped whenever a server instance starts, and each instance has its own copy. The demo data is re-seeded on every fresh start, so bookings, wallet changes and uploads don't last. Set `SESSION_SECRET` in the project's environment variables so logins work across instances. For real use, host on a server with a persistent disk or move the data to Postgres.
- **Email/WhatsApp:** notifications are in-app only. Add an email or WhatsApp Business API provider to send them.
- **Invoices:** invoices print to PDF from the browser. Have your CA confirm the GST treatment (rate, SAC code, place of supply) before issuing real tax invoices.

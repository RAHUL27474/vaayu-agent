/**
 * Adds any demo/catalogue packages that are missing from the database, without touching
 * existing data. Packages are matched by slug, so re-running is safe.
 *   npm run packages:sync
 */
const { one, all, run, tx, notify } = require('./db');

const CATALOGUE = [...require('./seed-packages'), ...require('./seed-packages-intl')];

const slugOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function insertPackage(p, status = 'published') {
  return run(
    `INSERT INTO packages (title, slug, destination, nights, theme, summary, inclusions, exclusions, image_url, package_type, is_international,
       departure_city, details, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.title, slugOf(p.title), p.destination, p.nights, p.theme, p.summary, p.inclusions, p.exclusions, p.image_url,
    p.package_type, p.is_international, p.departure_city, JSON.stringify(p.details), status,
  ).lastInsertRowid;
}

function syncPackages({ announce = false } = {}) {
  const added = [];
  tx(() => {
    for (const p of CATALOGUE) {
      if (one('SELECT 1 FROM packages WHERE slug = ?', slugOf(p.title))) continue;
      const id = insertPackage(p);
      added.push({ id, title: p.title });
      if (announce) {
        for (const a of all("SELECT id FROM agencies WHERE status = 'active'")) {
          notify(a.id, 'New package available', `${p.title} (${p.nights}N, ${p.destination}) is now bookable.`, `/agent/packages/${id}`);
        }
      }
    }
  });
  return added;
}

module.exports = { CATALOGUE, slugOf, insertPackage, syncPackages };

if (require.main === module) {
  const added = syncPackages({ announce: true });
  console.log(added.length ? `Added ${added.length} package(s):\n${added.map((a) => `  #${a.id} ${a.title}`).join('\n')}` : 'All catalogue packages are already in the database.');
}

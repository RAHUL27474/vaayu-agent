// Small progressive enhancements; every page works without JavaScript.

// Rows with data-href act as links.
document.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button, input, select, form')) window.location = row.dataset.href;
});

// Copy-to-clipboard buttons: <button data-copy="text">
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch {
    window.prompt('Copy this:', btn.dataset.copy);
  }
});

// Forms with data-confirm ask before submitting.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// "Add to quote" selects: show the new-quote title field only when "New quote" is chosen.
document.querySelectorAll('select[data-new-toggle]').forEach((sel) => {
  const target = document.getElementById(sel.dataset.newToggle);
  const sync = () => { if (target) target.style.display = sel.value === 'new' ? '' : 'none'; };
  sel.addEventListener('change', sync);
  sync();
});

// Repeatable form rows: <div data-rows="key"> + <template data-template="key"> + [data-add-row="key"].
// New rows get a unique index so the server receives key[index][field].
let rowSeq = Date.now() % 100000;
document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add-row]');
  if (add) {
    const key = add.dataset.addRow;
    const tpl = document.querySelector(`template[data-template="${key}"]`);
    const box = document.querySelector(`[data-rows="${key}"]`);
    if (!tpl || !box) return;
    box.insertAdjacentHTML('beforeend', tpl.innerHTML.replace(/__i__/g, String(1000 + rowSeq++)));
    const first = box.lastElementChild && box.lastElementChild.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
    return;
  }
  const remove = e.target.closest('[data-remove-row]');
  if (remove) remove.closest('[data-row]').remove();
});

// Signup/settings: GSTIN + GST certificate for India, a tax ID for other countries.
document.querySelectorAll('select[data-tax-country]').forEach((sel) => {
  const form = sel.form;
  const sync = () => {
    const india = sel.value === 'India';
    form.querySelectorAll('[data-tax-india]').forEach((el) => { el.hidden = !india; });
    form.querySelectorAll('[data-tax-foreign]').forEach((el) => { el.hidden = india; });
  };
  sel.addEventListener('change', sync);
  sync();
});

// Keep the current page's sidebar link visible when the menu is taller than the screen.
const activeNav = document.querySelector('.sidebar .nav a.active');
if (activeNav) activeNav.scrollIntoView({ block: 'nearest' });

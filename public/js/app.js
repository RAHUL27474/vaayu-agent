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
    // Hidden fields must not block submit: the PAN card is required only in India.
    form.querySelectorAll('[data-required-india]').forEach((el) => { el.required = india && !el.dataset.onFile; });
  };
  sel.addEventListener('change', sync);
  sync();
});

// Document pickers: show the chosen file name, and a preview for the applicant photo.
document.addEventListener('change', (e) => {
  const input = e.target.closest('.doc-drop input[type=file]');
  if (!input) return;
  const box = input.closest('.doc-drop');
  const file = input.files && input.files[0];
  const name = box.querySelector('[data-file-name]');
  if (name) name.textContent = file ? file.name : 'Choose file';
  box.classList.toggle('has-file', Boolean(file));
  const preview = box.querySelector('[data-photo-preview]');
  if (preview) {
    preview.hidden = !(file && file.type.startsWith('image/'));
    if (!preview.hidden) preview.src = URL.createObjectURL(file);
  }
});

// Keep the current page's sidebar link visible when the menu is taller than the screen.
const activeNav = document.querySelector('.sidebar .nav a.active');
if (activeNav) activeNav.scrollIntoView({ block: 'nearest' });

// Sidebar drawer on small screens: toggle, backdrop / close button / Escape / link click close it.
const navToggle = document.querySelector('[data-nav-toggle]');
const setNav = (open) => {
  document.body.classList.toggle('nav-open', open);
  if (navToggle) navToggle.setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-nav-toggle]')) setNav(!document.body.classList.contains('nav-open'));
  else if (e.target.closest('[data-nav-close], .sidebar .nav a')) setNav(false);
});

// Public site menu on phones.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-site-menu]');
  const header = document.querySelector('.site-header');
  if (!header) return;
  if (btn) {
    const open = header.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  } else if (e.target.closest('.site-menu a')) header.classList.remove('open');
});

// Dropdowns (<details data-dropdown>) close on outside click; everything closes on Escape.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details[data-dropdown][open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  setNav(false);
  document.querySelectorAll('details[data-dropdown][open]').forEach((d) => { d.open = false; });
  const header = document.querySelector('.site-header.open');
  if (header) header.classList.remove('open');
});

// Phones: plain data tables are shown as stacked cards. Label each cell with its column heading.
// Tables with form fields, without a header, or marked .no-stack keep their layout (they scroll sideways).
document.querySelectorAll('table.table').forEach((table) => {
  const head = table.querySelector('thead tr');
  if (table.querySelector('input:not([type=hidden]), select, textarea')) { table.classList.add('edit'); return; }
  if (!head || table.classList.contains('no-stack')) return;
  const labels = [...head.children].map((th) => th.textContent.trim());
  if (labels.length < 2) return;
  table.querySelectorAll('tbody tr, tr').forEach((tr) => {
    if (tr.parentElement.tagName === 'THEAD') return;
    let col = 0;
    [...tr.children].forEach((td) => {
      if (td.tagName === 'TD' && !td.hasAttribute('data-label')) td.setAttribute('data-label', labels[col] || '');
      col += td.colSpan || 1;
    });
  });
  table.classList.add('stack');
});

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

// Forms (or the button pressed) with data-confirm ask before submitting.
document.addEventListener('submit', (e) => {
  const msg = (e.submitter && e.submitter.dataset.confirm) || e.target.dataset.confirm;
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

// Photos and scans are resized in the browser before upload: phone photos are often 3-5 MB each, and the
// live server accepts about 4 MB per form. Images become JPEGs of at most 2400 px on the long side.
const MAX_UPLOAD = 4 * 1024 * 1024;
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 300 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || (blob.size >= file.size && scale === 1)) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file; // the server still checks size and type
  }
}
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.dataset.resized || form.enctype !== 'multipart/form-data' || !window.DataTransfer) return;
  const inputs = [...form.querySelectorAll('input[type=file]')].filter((i) => i.files && i.files.length);
  if (!inputs.length) return;
  e.preventDefault();
  const button = e.submitter;
  if (button) button.disabled = true;
  for (const input of inputs) {
    const dt = new DataTransfer();
    for (const f of input.files) dt.items.add(await shrinkImage(f));
    input.files = dt.files;
  }
  if (button) button.disabled = false;
  const total = inputs.reduce((n, i) => n + [...i.files].reduce((m, f) => m + f.size, 0), 0);
  if (total > MAX_UPLOAD) {
    window.alert(`These files add up to ${(total / 1024 / 1024).toFixed(1)} MB; the limit is 4 MB per upload. Use smaller PDFs, or photos instead of scans.`);
    return;
  }
  form.dataset.resized = '1';
  if (form.requestSubmit) form.requestSubmit(button || undefined); else form.submit();
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
// Tables without a header, or marked .no-stack, keep their layout (they scroll sideways).
document.querySelectorAll('table.table').forEach((table) => {
  const head = table.querySelector('thead tr');
  // Tables with form fields (e.g. quote prices) stack too, so every field stays reachable without sideways scrolling.
  if (table.querySelector('input:not([type=hidden]), select, textarea')) table.classList.add('edit');
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

// Backend product form: show what agents will pay (cost + VaayuTrip's margin) as the cost is typed.
document.querySelectorAll('input[data-margin]').forEach((input) => {
  const out = document.querySelector(`[data-agent-price="${input.id}"]`);
  if (!out) return;
  const pct = Number(input.dataset.margin) || 0;
  const sync = () => {
    const v = parseFloat(input.value);
    out.textContent = Number.isFinite(v) ? `₹${Math.round(v * (1 + pct / 100)).toLocaleString('en-IN')} (+${pct}%)` : (input.placeholder || '—');
  };
  input.addEventListener('input', sync);
  sync();
});

// Package form hotels: a customer's own hotel has no cost or price.
const syncStaySource = (sel) => {
  const client = sel.value === 'client';
  sel.closest('[data-row]').querySelectorAll('[data-stay-priced]').forEach((input) => {
    input.disabled = client;
    if (client) input.value = '';
    input.placeholder = client ? 'Not charged' : input.name.endsWith('[cost]') ? 'Your cost' : 'Your price';
  });
};
document.addEventListener('change', (e) => { if (e.target.matches('select[data-stay-source]')) syncStaySource(e.target); });

// Catalogue on phones: filters fold behind a button.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter-toggle]');
  if (!btn) return;
  const form = document.getElementById(btn.getAttribute('aria-controls'));
  const open = form.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
  if (open) form.querySelector('input, select')?.focus();
});

// Messages after an action: a close button on each; success messages fade out after a few seconds.
document.querySelectorAll('[data-flash]').forEach((el) => {
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'alert-close';
  close.setAttribute('aria-label', 'Dismiss message');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.append(close);
  if (el.classList.contains('success')) setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 400); }, 6000);
});

// Submitting: the button shows it's working and repeat clicks are ignored, so nothing is sent twice.
// (The button isn't disabled: that would drop its name/value from the form data.)
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (e.defaultPrevented || form.method.toLowerCase() === 'get') return;
  if (form.dataset.submitting) { e.preventDefault(); return; }
  form.dataset.submitting = '1';
  const button = e.submitter || form.querySelector('button:not([type=button])');
  if (button) { button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); }
  // Downloads don't leave the page: let the form be used again after a while.
  setTimeout(() => { delete form.dataset.submitting; if (button) { button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); } }, 8000);
});
// Coming back with the browser's Back button restores the page as it was: reset busy forms.
window.addEventListener('pageshow', () => document.querySelectorAll('form[data-submitting]').forEach((f) => {
  delete f.dataset.submitting;
  f.querySelectorAll('.is-busy').forEach((b) => { b.classList.remove('is-busy'); b.removeAttribute('aria-busy'); });
}));

// Password fields get a Show/Hide button (handy on phones).
document.querySelectorAll('input[type=password]').forEach((input) => {
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.replaceWith(wrap);
  wrap.append(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  btn.textContent = 'Show';
  btn.setAttribute('aria-label', 'Show password');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });
  wrap.append(btn);
});

// Quote markup by service: "Default" ticked → own % / ₹ boxes are off; unticked → fill them in.
document.addEventListener('change', (e) => {
  const box = e.target.closest('[data-kind-default]');
  if (!box) return;
  const row = box.closest('[data-kind-row]');
  row.querySelectorAll('[data-kind-own]').forEach((el) => { el.disabled = box.checked; });
  if (!box.checked) row.querySelector('input[data-kind-own]').focus();
});

// "/" focuses the portal search box (unless already typing somewhere).
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  const box = document.querySelector('[data-search-key]');
  if (box && box.offsetParent) { e.preventDefault(); box.focus(); }
});

// Type-to-filter lists: <input data-filter-list="#list"> filters the rows (data-filter-text) inside #list.
document.addEventListener('input', (e) => {
  const input = e.target.closest('[data-filter-list]');
  if (!input) return;
  const list = document.querySelector(input.dataset.filterList);
  if (!list) return;
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const row of list.querySelectorAll('[data-filter-text]')) {
    const hit = !q || row.dataset.filterText.includes(q);
    row.hidden = !hit;
    if (hit) shown += 1;
  }
  const empty = list.querySelector('[data-filter-empty]');
  if (empty) empty.hidden = shown > 0;
});

// ---------- Home page: hero slideshow, count-up numbers, margin calculator, scroll reveal ----------
const calmMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const hero = document.querySelector('[data-hero]');
if (hero) {
  const slides = hero.querySelectorAll('.hx-slide');
  const dots = hero.querySelectorAll('[data-slide]');
  const word = hero.querySelector('[data-hero-word]');
  const line = hero.querySelector('[data-hero-line]');
  const MS = 6000;
  hero.style.setProperty('--slide-ms', `${MS}ms`);
  let at = 0;
  let timer;
  const show = (i) => {
    at = (i + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle('on', k === at));
    dots.forEach((d, k) => {
      d.classList.remove('on');
      if (k === at) { void d.offsetWidth; d.classList.add('on'); }
    });
    if (line) line.textContent = dots[at].dataset.line;
    if (word) {
      word.classList.add('out');
      setTimeout(() => { word.textContent = dots[at].querySelector('span').textContent; word.classList.remove('out'); }, 300);
    }
  };
  const play = () => { clearInterval(timer); if (!calmMotion) timer = setInterval(() => { if (!document.hidden) show(at + 1); }, MS); };
  dots.forEach((d) => d.addEventListener('click', () => { show(Number(d.dataset.slide)); play(); }));
  if (calmMotion) hero.setAttribute('data-paused', '');
  play();
}

const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    const el = e.target;
    io.unobserve(el);
    el.classList.add('in');
    if (el.dataset.count !== undefined && !calmMotion) {
      const end = Number(el.dataset.count) || 0;
      const t0 = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - t0) / 1400);
        el.textContent = Math.round(end * (1 - (1 - p) ** 3)).toLocaleString('en-IN');
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  });
}, { threshold: 0.15 }) : null;
// Siblings revealed together come in one after another.
document.querySelectorAll('[data-reveal]').forEach((el) => {
  const i = [...el.parentElement.children].filter((c) => c.hasAttribute('data-reveal')).indexOf(el);
  el.style.setProperty('--d', `${Math.min(i, 6) * 80}ms`);
  if (io) io.observe(el); else el.classList.add('in');
});
document.querySelectorAll('[data-count]').forEach((el) => io && io.observe(el));

const calc = document.querySelector('[data-calc]');
if (calc) {
  const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const slider = calc.querySelector('[data-calc-m]');
  const profitBox = calc.querySelector('.calc-profit');
  const render = () => {
    const trip = calc.querySelector('input[name="calc-trip"]:checked');
    const lines = JSON.parse(trip.dataset.lines);
    const net = lines.reduce((s, l) => s + l[1], 0);
    const m = Number(slider.value);
    calc.querySelector('[data-calc-lines]').innerHTML = lines.map((l) => `<tr><td>${l[0]}</td><td class="num">${inr(l[1])} <small class="muted">net</small></td></tr>`).join('');
    calc.querySelector('[data-calc-pct]').textContent = `${m}%`;
    calc.querySelector('[data-calc-total]').textContent = inr(net * (1 + m / 100));
    calc.querySelector('[data-calc-profit]').textContent = inr(net * m / 100);
    profitBox.classList.remove('bump'); void profitBox.offsetWidth; profitBox.classList.add('bump');
  };
  slider.addEventListener('input', render);
  calc.querySelectorAll('input[name="calc-trip"]').forEach((r) => r.addEventListener('change', render));
}

// Home: the header over the hero turns solid once the page scrolls.
const overlayHeader = document.querySelector('.site-header.overlay');
if (overlayHeader) {
  const sync = () => overlayHeader.classList.toggle('scrolled', window.scrollY > 40);
  window.addEventListener('scroll', sync, { passive: true });
  sync();
}

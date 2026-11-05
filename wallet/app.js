/* Pocket Wallet — demo-mode card wallet.
 *
 * Security model (demo mode):
 *  - The full card number and CVV only ever live in the form inputs while the user types.
 *    They are validated (Luhn, length, brand rules) and then cleared. They are never written
 *    to localStorage, never put into the saved card object and never sent anywhere.
 *  - Only display metadata is persisted: brand, last 4 digits, expiry, cardholder name,
 *    label, colour and timestamps. That is the same information printed on a receipt.
 *  - No card is enrolled with an issuer, and the app makes no payments. Real enrollment
 *    needs a PCI-compliant tokenization provider; until one is configured the UI says so.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STORE_KEY = 'pocketWallet.v1';
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

  /* ---------------- Brands ---------------- */
  const BRANDS = {
    amex:       { name: 'American Express', re: /^3[47]/, lengths: [15], cvv: 4, gaps: [4, 10] },
    diners:     { name: 'Diners Club', re: /^3(0[0-5]|[689])/, lengths: [14, 16, 19], cvv: 3, gaps: [4, 10] },
    jcb:        { name: 'JCB', re: /^35(2[89]|[3-8])/, lengths: [16, 17, 18, 19], cvv: 3, gaps: [4, 8, 12, 16] },
    discover:   { name: 'Discover', re: /^(6011|65|64[4-9]|622)/, lengths: [16, 19], cvv: 3, gaps: [4, 8, 12, 16] },
    mastercard: { name: 'Mastercard', re: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16], cvv: 3, gaps: [4, 8, 12] },
    visa:       { name: 'Visa', re: /^4/, lengths: [13, 16, 19], cvv: 3, gaps: [4, 8, 12, 16] },
    unionpay:   { name: 'UnionPay', re: /^62/, lengths: [16, 17, 18, 19], cvv: 3, gaps: [4, 8, 12, 16] },
  };
  const BRAND_ORDER = ['amex', 'diners', 'jcb', 'discover', 'mastercard', 'visa', 'unionpay'];
  const brandName = (b) => (BRANDS[b] ? BRANDS[b].name : 'Card');

  function detectBrand(d) {
    if (!d) return null;
    for (const k of BRAND_ORDER) if (BRANDS[k].re.test(d)) return k;
    return null;
  }
  const maxLen = (b) => (b ? Math.max(...BRANDS[b].lengths) : 19);
  const displayLen = (b) => (b === 'amex' ? 15 : b === 'diners' ? 14 : 16);
  const gapsOf = (b) => (b ? BRANDS[b].gaps : [4, 8, 12, 16]);

  function luhn(d) {
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = d.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }

  function formatDigits(d, b) {
    const gaps = gapsOf(b);
    let out = '';
    for (let i = 0; i < d.length; i++) { if (gaps.includes(i)) out += ' '; out += d[i]; }
    return out;
  }

  /* ---------------- Themes ---------------- */
  const THEMES = [
    ['midnight', 'Midnight'], ['sunset', 'Sunset'], ['graphite', 'Graphite'], ['ocean', 'Ocean'],
    ['lilac', 'Lilac'], ['forest', 'Forest'], ['gold', 'Gold'], ['pearl', 'Pearl'],
  ];
  const THEME_IDS = THEMES.map((t) => t[0]);

  /* ---------------- Utilities ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = new Intl.NumberFormat('en-IL', { style: 'currency', currency: 'ILS' });
  const fmtMoney = (n) => money.format(Math.abs(n));
  function newId() {
    const a = new Uint8Array(8);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
    return 'card_' + [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const raf = (fn) => { let q = false; return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(); }); }; };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* not supported */ } };

  function expiryState(exp) {
    const m = /^(\d{2})\/(\d{2})$/.exec(exp || '');
    if (!m) return 'unknown';
    const end = new Date(2000 + +m[2], +m[1], 1); // first day after the expiry month
    const now = new Date();
    if (end <= now) return 'expired';
    if (end - now < 1000 * 60 * 60 * 24 * 62) return 'soon';
    return 'ok';
  }

  /* ---------------- Storage (metadata only) ---------------- */
  const SAFE_FIELDS = ['id', 'brand', 'last4', 'holder', 'exp', 'nickname', 'theme', 'addedAt'];
  function sanitizeCard(c) {
    if (!c || typeof c !== 'object') return null;
    const out = {
      id: typeof c.id === 'string' && /^card_[a-z0-9]{6,32}$/.test(c.id) ? c.id : newId(),
      brand: BRANDS[c.brand] ? c.brand : 'unknown',
      last4: /^\d{4}$/.test(c.last4) ? c.last4 : null,
      holder: typeof c.holder === 'string' ? c.holder.slice(0, 40) : '',
      exp: /^\d{2}\/\d{2}$/.test(c.exp) ? c.exp : '',
      nickname: typeof c.nickname === 'string' ? c.nickname.slice(0, 24) : '',
      theme: THEME_IDS.includes(c.theme) ? c.theme : 'graphite',
      addedAt: Number.isFinite(c.addedAt) ? c.addedAt : Date.now(),
    };
    return out.last4 ? out : null;
  }
  const pickSafe = (c) => Object.fromEntries(SAFE_FIELDS.map((k) => [k, c[k]]));

  let storageWarned = false;
  function loadState() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { raw = null; }
    const cards = Array.isArray(raw && raw.cards) ? raw.cards.map(sanitizeCard).filter(Boolean) : [];
    const defaultId = raw && cards.some((c) => c.id === raw.defaultId) ? raw.defaultId : (cards[0] ? cards[0].id : null);
    let seeded = true;
    try { seeded = localStorage.getItem(STORE_KEY + '.demoSeeded') === '1'; localStorage.setItem(STORE_KEY + '.demoSeeded', '1'); } catch (e) { seeded = false; }
    return { cards, defaultId, fresh: !seeded && cards.length === 0 };
  }
  function persist() {
    const payload = { v: 1, cards: state.cards.map(pickSafe), defaultId: state.defaultId };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (e) {
      if (!storageWarned) { storageWarned = true; toast('Cards can’t be saved in this browser. They’ll reset when you close it.', 'error'); }
    }
  }

  const loaded = loadState();
  // First launch: start with a ready-made demo card so the wallet is usable before entering any details.
  if (loaded.fresh) {
    const y = new Date().getFullYear() % 100;
    const demo = sanitizeCard({ id: newId(), brand: 'visa', last4: '4242', holder: 'Itamar', exp: `08/${y + 3}`, nickname: 'Itamar\'s Friend', theme: 'sunset', addedAt: Date.now() });
    loaded.cards.push(demo);
    loaded.defaultId = demo.id;
  }
  const state = {
    cards: loaded.cards,
    defaultId: loaded.defaultId,
    activeId: loaded.defaultId,
    query: '',
    detailId: null,
    detailTab: 'tx',
  };
  persist(); // rewrites storage through the sanitizer, dropping any unexpected fields
  const byId = (id) => state.cards.find((c) => c.id === id);

  /* ---------------- Demo transactions ---------------- */
  const MERCHANTS = [
    ['Aroma Espresso Bar', 'Coffee', '#8a5a3b', 14, 42],
    ['Cofix', 'Coffee', '#d6336c', 6, 22],
    ['Shufersal', 'Groceries', '#d7262c', 60, 420],
    ['Rami Levy', 'Groceries', '#1f5fa8', 80, 540],
    ['Wolt', 'Food delivery', '#0097d6', 48, 168],
    ['Gett', 'Taxi', '#222428', 28, 96],
    ['Rav-Kav', 'Public transport', '#2f9e44', 5.5, 50],
    ['Super-Pharm', 'Health & beauty', '#c2255c', 25, 260],
    ['Paz', 'Fuel', '#e8590c', 120, 380],
    ['Yes Planet', 'Entertainment', '#5f3dc4', 48, 150],
    ['Spotify', 'Subscription', '#1c9a4b', 21.9, 21.9],
    ['Netflix', 'Subscription', '#c21f26', 54.9, 54.9],
    ['iCloud+', 'Subscription', '#3b7ddd', 11.9, 11.9],
    ['Castro', 'Clothing', '#343a40', 90, 460],
    ['IKEA', 'Home', '#1864ab', 60, 880],
    ['Ace', 'Home improvement', '#e03131', 30, 240],
    ['Burgers Bar', 'Restaurants', '#a61e4d', 62, 190],
  ];
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const txCache = new Map();
  function txFor(card) {
    if (txCache.has(card.id)) return txCache.get(card.id);
    const r = mulberry(hashStr(card.id));
    const list = [];
    let t = Date.now() - r() * 4 * 3600e3;
    for (let i = 0; i < 34; i++) {
      const m = MERCHANTS[Math.floor(r() * MERCHANTS.length)];
      const amt = m[3] === m[4] ? m[3] : Math.round((m[3] + (m[4] - m[3]) * Math.pow(r(), 1.7)) * 100) / 100;
      const refund = i > 3 && r() < 0.05;
      const status = i < 2 && r() < 0.55 ? 'Pending' : refund ? 'Refund' : '';
      list.push({ id: card.id + ':' + i, merchant: m[0], cat: m[1], color: m[2], amount: refund ? amt : -amt, time: t, status });
      t -= (3 + r() * 46) * 3600e3;
    }
    txCache.set(card.id, list);
    return list;
  }
  const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const diff = Math.round((sod(now) - sod(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  function shortWhen(ts) {
    const d = new Date(ts), now = new Date();
    const diff = Math.round((sod(now) - sod(d)) / 864e5);
    if (diff === 0) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function txRow(tx, withDate = true) {
    const credit = tx.amount > 0;
    const initials = tx.merchant.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    return `<div class="row tx indent">
      <span class="tx-ico" style="--c:${tx.color}" aria-hidden="true">${esc(initials)}</span>
      <span class="tx-main"><strong>${esc(tx.merchant)}</strong><span>${esc(tx.cat)}${withDate ? ' · ' + esc(shortWhen(tx.time)) : ''}</span></span>
      <span class="tx-amt${credit ? ' credit' : ''}">${credit ? '+' : ''}${fmtMoney(tx.amount)}${tx.status ? `<small>${tx.status}</small>` : ''}</span>
    </div>`;
  }

  /* ---------------- Card rendering ---------------- */
  function brandMark(b) {
    switch (b) {
      case 'visa': return '<span class="bm-visa" aria-label="Visa">VISA</span>';
      case 'mastercard': return '<svg class="bm-mc" viewBox="0 0 50 31" role="img" aria-label="Mastercard"><circle cx="15.5" cy="15.5" r="15.5" fill="#eb001b"/><circle cx="34.5" cy="15.5" r="15.5" fill="#f79e1b"/><path d="M25 3.4a15.5 15.5 0 0 1 0 24.2a15.5 15.5 0 0 1 0-24.2z" fill="#ff5f00"/></svg>';
      case 'amex': return '<span class="bm-amex" aria-label="American Express">AMEX</span>';
      case 'discover': return '<span class="bm-text bm-disc" aria-label="Discover">DISC<i></i>VER</span>';
      case 'diners': return '<span class="bm-text" style="font-size:3.6cqw">Diners Club</span>';
      case 'jcb': return '<span class="bm-text">JCB</span>';
      case 'unionpay': return '<span class="bm-text" style="font-size:4cqw">UnionPay</span>';
      default: return '<svg class="bm-generic" aria-hidden="true"><use href="#i-card"/></svg>';
    }
  }
  function maskedNumberHTML(c) {
    const len = displayLen(c.brand);
    const d = '•'.repeat(len - 4) + c.last4;
    return esc(formatDigits(d, c.brand)).replace(/ /g, '&ensp;');
  }
  function previewNumberHTML(d, b) {
    const len = Math.max(d.length, displayLen(b));
    const gaps = gapsOf(b);
    let out = '';
    for (let i = 0; i < len; i++) {
      if (gaps.includes(i)) out += '&ensp;';
      out += i < d.length ? d[i] : '<span class="ph">•</span>';
    }
    return out;
  }
  function cardLabel(c) { return c.nickname || (BRANDS[c.brand] ? brandName(c.brand) : 'Card'); }
  function cardHTML(c, opt = {}) {
    const title = opt.title ?? cardLabel(c);
    const sub = opt.sub ?? (c.nickname ? brandName(c.brand) : '');
    return `<div class="wcard t-${esc(c.theme || 'graphite')}">
      <span class="sheen"></span>
      <div class="wc-top"><div style="min-width:0"><div class="wc-name">${esc(title)}</div>${sub ? `<span class="wc-sub">${esc(sub)}</span>` : ''}</div><svg class="wc-nfc" aria-hidden="true"><use href="#i-nfc"/></svg></div>
      <div class="wc-chip"></div>
      <span class="wc-demo">DEMO</span>
      <div class="wc-num">${opt.numberHTML ?? maskedNumberHTML(c)}</div>
      <div class="wc-bottom">
        <div class="wc-field holder"><label>CARDHOLDER</label><span>${esc(c.holder || 'Your name')}</span></div>
        <div class="wc-field"><label>EXPIRES</label><span>${esc(c.exp || 'MM/YY')}</span></div>
        <div class="wc-brand">${brandMark(c.brand)}</div>
      </div>
    </div>`;
  }
  function cardBackHTML(theme, cvvLen, focused) {
    const dots = cvvLen ? '•'.repeat(cvvLen) : '<span style="opacity:.35">•••</span>';
    return `<div class="wcard back t-${esc(theme)}">
      <div class="stripe"></div><div class="sig"></div>
      <div class="cvv${focused ? ' focus' : ''}">${dots}</div>
      <div class="backnote">The security code is checked and then discarded. It is never saved.</div>
    </div>`;
  }

  /* ---------------- Elements ---------------- */
  const app = $('#app');
  const carousel = $('#carousel');
  const dotsEl = $('#dots');
  const panel = $('#panel');
  const walletView = $('#walletView');
  const emptyView = $('#emptyView');
  const noMatch = $('#noMatch');
  const scrim = $('#scrim');
  const addSheet = $('#addSheet');
  const detailSheet = $('#detailSheet');
  const manageSheet = $('#manageSheet');

  /* ---------------- Toast & dialog ---------------- */
  let toastTimer;
  function toast(msg, type = 'ok') {
    const el = $('#toast');
    el.classList.toggle('error', type === 'error');
    $('use', el).setAttribute('href', type === 'error' ? '#i-x' : '#i-check');
    $('#toastMsg').textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), type === 'error' ? 3600 : 2400);
  }

  let dialogResolve = null;
  function confirmDialog({ title, message, ok = 'OK', destructive = false }) {
    const wrap = $('#dialog');
    $('#dlgTitle').textContent = title;
    $('#dlgMsg').textContent = message;
    const okBtn = $('#dlgOk');
    okBtn.textContent = ok;
    okBtn.classList.toggle('destructive', destructive);
    wrap.classList.add('on');
    const prev = document.activeElement;
    setTimeout(() => $('#dlgCancel').focus(), 30);
    return new Promise((res) => {
      dialogResolve = (v) => { wrap.classList.remove('on'); dialogResolve = null; if (prev && prev.focus) prev.focus(); res(v); };
    });
  }
  $('#dlgCancel').addEventListener('click', () => dialogResolve && dialogResolve(false));
  $('#dlgOk').addEventListener('click', () => dialogResolve && dialogResolve(true));
  $('#dialog').addEventListener('click', (e) => { if (e.target.id === 'dialog' && dialogResolve) dialogResolve(false); });

  /* ---------------- Sheets ---------------- */
  const sheetStack = [];
  const focusReturn = new Map();
  function openSheet(sheet, focusSel) {
    if (sheetStack.includes(sheet)) return;
    focusReturn.set(sheet, document.activeElement);
    sheet.classList.remove('closing');
    sheet.classList.add('open');
    sheet.style.zIndex = 50 + sheetStack.length * 2;
    sheetStack.push(sheet);
    scrim.style.zIndex = 49 + (sheetStack.length - 1) * 2;
    scrim.classList.add('on');
    app.inert = true;
    sheetStack.slice(0, -1).forEach((s) => (s.inert = true));
    setTimeout(() => { const f = focusSel ? $(focusSel, sheet) : $('[data-close]', sheet); f && f.focus({ preventScroll: true }); }, reduceMotion ? 0 : 420);
  }
  function closeSheet(sheet) {
    const i = sheetStack.indexOf(sheet);
    if (i < 0) return;
    sheetStack.splice(i, 1);
    sheet.classList.remove('open');
    sheet.classList.add('closing');
    sheet.style.transform = '';
    setTimeout(() => sheet.classList.remove('closing'), 520);
    if (sheetStack.length) {
      const top = sheetStack[sheetStack.length - 1];
      top.inert = false;
      scrim.style.zIndex = 49 + (sheetStack.length - 1) * 2;
    } else {
      scrim.classList.remove('on');
      app.inert = false;
    }
    const f = focusReturn.get(sheet);
    if (f && f.isConnected && f.focus) f.focus({ preventScroll: true });
    sheet.dispatchEvent(new CustomEvent('sheetclose'));
  }
  scrim.addEventListener('click', () => sheetStack.length && closeSheet(sheetStack[sheetStack.length - 1]));
  $$('.sheet').forEach((sheet) => {
    $$('[data-close]', sheet).forEach((b) => b.addEventListener('click', () => closeSheet(sheet)));
    // drag down on the bar to dismiss
    const bar = $('.sheet-bar', sheet);
    let startY = 0, dy = 0, t0 = 0, dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; startY = e.clientY; dy = 0; t0 = performance.now();
      bar.setPointerCapture(e.pointerId);
      sheet.classList.add('dragging');
    });
    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      const v = dy / Math.max(1, performance.now() - t0);
      sheet.style.transform = '';
      if (dy > 130 || (dy > 40 && v > 0.6)) closeSheet(sheet);
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dialogResolve) { dialogResolve(false); return; }
    if (sheetStack.length) { closeSheet(sheetStack[sheetStack.length - 1]); return; }
    if ($('#searchBox').classList.contains('open')) toggleSearch(false);
  });

  /* ---------------- Wallet view ---------------- */
  function visibleCards() {
    const q = state.query.trim().toLowerCase();
    if (!q) return state.cards;
    const digits = q.replace(/[\s•*]/g, '');
    return state.cards.filter((c) =>
      [c.nickname, c.holder, brandName(c.brand), c.brand, THEMES.find((t) => t[0] === c.theme)?.[1]].some((s) => s && s.toLowerCase().includes(q)) ||
      (/^\d{1,4}$/.test(digits) && c.last4.includes(digits)));
  }

  function slideStep() {
    const s = carousel.children;
    if (s.length < 2) return s[0] ? s[0].offsetWidth : 1;
    return s[1].offsetLeft - s[0].offsetLeft;
  }
  function scrollToIndex(i, smooth) {
    const s = carousel.children[i];
    if (!s) return;
    carousel.scrollTo({ left: s.offsetLeft - carousel.children[0].offsetLeft, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
  }

  function renderWallet(opts = {}) {
    const has = state.cards.length > 0;
    emptyView.hidden = has;
    walletView.hidden = !has;
    $('#btnSearch').hidden = !has;
    $('#btnManage').hidden = !has;
    if (!has) { renderEmptyArt(); toggleSearch(false); return; }

    const list = visibleCards();
    if (!list.some((c) => c.id === state.activeId)) state.activeId = list[0] ? list[0].id : null;
    carousel.innerHTML = list.map((c) => `
      <div class="slide${opts.pop === c.id ? ' pop' : ''}" role="listitem" data-id="${c.id}" tabindex="0"
           aria-label="${esc(cardLabel(c))}, ${esc(brandName(c.brand))} ending ${c.last4}${c.id === state.defaultId ? ', default card' : ''}. Open details">
        <div class="cw">${cardHTML(c)}</div>
      </div>`).join('');
    dotsEl.innerHTML = list.length > 1 ? list.map((c, i) => `<button role="tab" aria-label="Card ${i + 1} of ${list.length}" data-i="${i}"></button>`).join('') : '';
    noMatch.hidden = list.length > 0;
    panel.hidden = list.length === 0;
    $('#searchMeta').textContent = state.query.trim() ? `${list.length} of ${state.cards.length} card${state.cards.length === 1 ? '' : 's'}` : '';

    const idx = Math.max(0, list.findIndex((c) => c.id === state.activeId));
    lastActive = null;
    requestAnimationFrame(() => {
      scrollToIndex(idx, !!opts.smooth);
      onScroll();
      if (!opts.smooth) updateFromScroll(true);
    });
  }

  let lastActive = null;
  function updateFromScroll(force) {
    const slides = carousel.children;
    if (!slides.length) return;
    const step = slideStep() || 1;
    const x = carousel.scrollLeft;
    let idx = Math.round(x / step);
    idx = Math.max(0, Math.min(slides.length - 1, idx));
    for (let i = 0; i < slides.length; i++) {
      const d = Math.min(1, Math.abs(i - x / step));
      slides[i].style.transform = reduceMotion ? '' : `scale(${1 - d * 0.07})`;
      slides[i].style.opacity = String(1 - d * 0.35);
    }
    const id = slides[idx].dataset.id;
    if (id !== lastActive || force) {
      lastActive = id;
      state.activeId = id;
      [...slides].forEach((s, i) => s.classList.toggle('active', i === idx));
      $$('button', dotsEl).forEach((b, i) => { b.classList.toggle('on', i === idx); b.setAttribute('aria-selected', i === idx); });
      renderPanel();
    }
  }
  const onScroll = raf(() => updateFromScroll(false));
  carousel.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', raf(() => { const i = [...carousel.children].findIndex((s) => s.dataset.id === state.activeId); scrollToIndex(Math.max(0, i), false); updateFromScroll(true); }));

  carousel.addEventListener('click', (e) => {
    const s = e.target.closest('.slide');
    if (!s) return;
    const i = [...carousel.children].indexOf(s);
    if (s.dataset.id !== state.activeId) { scrollToIndex(i, true); return; }
    openDetail(s.dataset.id, 'tx', $('.cw', s));
  });
  carousel.addEventListener('keydown', (e) => {
    const s = e.target.closest('.slide');
    if (!s) return;
    const i = [...carousel.children].indexOf(s);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(s.dataset.id, 'tx', $('.cw', s)); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const n = Math.max(0, Math.min(carousel.children.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      scrollToIndex(n, true);
      carousel.children[n].focus({ preventScroll: true });
    }
  });
  dotsEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) scrollToIndex(+b.dataset.i, true); });

  function sparkline(card) {
    const days = 14, buckets = new Array(days).fill(0);
    const start = sod(new Date()) - (days - 1) * 864e5;
    for (const t of txFor(card)) {
      if (t.amount >= 0 || t.time < start) continue;
      const i = Math.floor((t.time - start) / 864e5);
      if (i >= 0 && i < days) buckets[i] += -t.amount;
    }
    const max = Math.max(...buckets, 1);
    const pts = buckets.map((v, i) => [(i / (days - 1)) * 100, 24 - (v / max) * 20]);
    const line = pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="0,26 ${line} 100,26" fill="var(--accent)" opacity=".12"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="var(--accent)" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function monthStats(card) {
    const startMonth = new Date(); startMonth.setDate(1); startMonth.setHours(0, 0, 0, 0);
    const tx = txFor(card).filter((t) => t.time >= startMonth.getTime());
    const spent = tx.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
    return { spent, count: tx.length, pending: tx.filter((t) => t.status === 'Pending').length };
  }

  function statusPill(c) {
    if (c.id === state.defaultId) return '<span class="pill default"><svg><use href="#i-star"/></svg>Default</span>';
    const ex = expiryState(c.exp);
    if (ex === 'expired') return '<span class="pill warn">Expired</span>';
    if (ex === 'soon') return '<span class="pill warn">Expires soon</span>';
    return '';
  }

  function renderPanel() {
    const c = byId(state.activeId);
    if (!c) { panel.innerHTML = ''; return; }
    const tx = txFor(c).slice(0, 5);
    const st = monthStats(c);
    panel.innerHTML = `
      <div class="panel-head">
        <div><h2>${esc(cardLabel(c))}</h2><p>${esc(brandName(c.brand))} •••• ${c.last4} · Expires ${esc(c.exp)}</p></div>
        ${statusPill(c)}
      </div>
      <div class="stats">
        <div class="stat"><label>Spent this month</label><strong>${fmtMoney(st.spent)}</strong>${sparkline(c)}</div>
        <div class="stat"><label>Transactions</label><strong>${st.count}</strong><span style="display:block;margin-top:8px;font-size:13px;color:var(--mut)">${st.pending ? st.pending + ' pending' : 'All settled'}</span></div>
      </div>
      <div>
        <div class="section-title"><h3>Latest Transactions</h3><button class="link" id="seeAll">See All</button></div>
        <div class="group">${tx.map((t) => txRow(t)).join('')}</div>
        <p class="group-foot">Sample activity for demo mode.</p>
      </div>`;
    $('#seeAll').addEventListener('click', () => {
      const s = [...carousel.children].find((x) => x.dataset.id === c.id);
      openDetail(c.id, 'tx', s && $('.cw', s));
    });
  }

  function renderEmptyArt() {
    const y = (new Date().getFullYear() + 3) % 100;
    const art = [
      { theme: 'sunset', brand: 'mastercard', last4: '4444', holder: '', exp: `09/${y}`, nickname: '' },
      { theme: 'ocean', brand: 'amex', last4: '0005', holder: '', exp: `04/${y}`, nickname: '' },
      { theme: 'midnight', brand: 'visa', last4: '4242', holder: '', exp: `12/${y}`, nickname: '' },
    ];
    $('#emptyArt').innerHTML = art.map((c) => `<div class="cw">${cardHTML(c, { title: brandName(c.brand) })}</div>`).join('');
  }

  /* ---------------- Search ---------------- */
  function toggleSearch(open) {
    const box = $('#searchBox');
    const want = open ?? !box.classList.contains('open');
    box.classList.toggle('open', want);
    $('#btnSearch').setAttribute('aria-expanded', want);
    if (want) setTimeout(() => $('#searchInput').focus(), 60);
    else if (state.query) { state.query = ''; $('#searchInput').value = ''; renderWallet(); }
  }
  $('#btnSearch').addEventListener('click', () => toggleSearch());
  $('#searchInput').addEventListener('input', (e) => { state.query = e.target.value; renderWallet(); });

  /* ---------------- Detail sheet ---------------- */
  function renderDetail() {
    const c = byId(state.detailId);
    if (!c) return;
    $('#detailTitle').textContent = cardLabel(c);
    $('#detailCard').innerHTML = cardHTML(c);
    setTab(state.detailTab, false);
  }
  function setTab(tab, animate = true) {
    state.detailTab = tab;
    const tabs = $$('#detailTabs [role=tab]');
    tabs.forEach((b, i) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      if (on) $('#detailTabs .thumb').style.transform = `translateX(${i * 100}%)`;
    });
    renderPane();
    if (!animate) $('#detailPane').firstElementChild?.style.setProperty('animation', 'none');
  }
  $('#detailTabs').addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) setTab(b.dataset.tab); });
  $('#detailTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const order = ['tx', 'info', 'settings'];
    const i = (order.indexOf(state.detailTab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
    setTab(order[i]);
    $(`#detailTabs [data-tab=${order[i]}]`).focus();
  });

  function renderPane() {
    const c = byId(state.detailId);
    const pane = $('#detailPane');
    if (!c) { pane.innerHTML = ''; return; }
    if (state.detailTab === 'tx') {
      pane.innerHTML = `<div class="pane">
        <label class="search-field"><svg><use href="#i-search"/></svg><span class="sr">Search transactions</span><input id="txSearch" type="search" placeholder="Search transactions" autocomplete="off"></label>
        <div id="txList"></div>
        <p class="group-foot" style="margin-top:-12px">Sample activity for demo mode. No real purchases are shown.</p>
      </div>`;
      const draw = () => {
        const q = $('#txSearch').value.trim().toLowerCase();
        const items = txFor(c).filter((t) => !q || t.merchant.toLowerCase().includes(q) || t.cat.toLowerCase().includes(q));
        if (!items.length) { $('#txList').innerHTML = '<div class="no-match" style="padding:28px 0"><strong>No transactions</strong>Nothing matches that search.</div>'; return; }
        const groups = [];
        for (const t of items) {
          const k = dayLabel(t.time);
          if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, items: [] });
          groups[groups.length - 1].items.push(t);
        }
        $('#txList').innerHTML = groups.map((g) => {
          const total = g.items.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
          return `<div class="tx-day"><span>${esc(g.k)}</span><span style="font-variant-numeric:tabular-nums">${total ? fmtMoney(total) : ''}</span></div>
            <div class="group">${g.items.map((t) => txRow(t, false)).join('')}</div>`;
        }).join('');
      };
      $('#txSearch').addEventListener('input', draw);
      draw();
    } else if (state.detailTab === 'info') {
      const ex = expiryState(c.exp);
      const added = new Date(c.addedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      pane.innerHTML = `<div class="pane">
        <div><div class="group-label">Card</div><div class="group">
          <div class="row"><span class="k grow">Label</span><span class="v">${esc(cardLabel(c))}</span></div>
          <div class="row"><span class="k grow">Cardholder</span><span class="v">${esc(c.holder)}</span></div>
          <div class="row"><span class="k grow">Network</span><span class="v">${esc(brandName(c.brand))}</span></div>
          <div class="row"><span class="k grow">Card number</span><span class="v">•••• ${c.last4}</span></div>
          <div class="row"><span class="k grow">Expires</span><span class="v">${esc(c.exp)}${ex === 'expired' ? ' · <span style="color:var(--warn)">Expired</span>' : ex === 'soon' ? ' · <span style="color:var(--warn)">Soon</span>' : ''}</span></div>
          <div class="row"><span class="k grow">Default card</span><span class="v">${c.id === state.defaultId ? 'Yes' : 'No'}</span></div>
          <div class="row"><span class="k grow">Added</span><span class="v">${esc(added)}</span></div>
        </div></div>
        <div><div class="group-label">Security</div><div class="group">
          <div class="row"><span class="k grow">Status</span><span class="v" style="color:var(--warn)">Demo, not enrolled</span></div>
          <div class="row"><span class="k grow">Stored on</span><span class="v">This device only</span></div>
          <div class="row"><span class="k grow">Full number &amp; CVV</span><span class="v">Never stored</span></div>
          <div class="row"><span class="k grow">Reference</span><span class="v" style="font-size:13px">${esc(c.id.replace('card_', 'demo-').slice(0, 17))}</span></div>
        </div>
        <p class="group-foot">This card can’t make payments. Real enrollment needs a PCI-compliant tokenization provider and, for Apple Pay, Apple’s official entitlements.</p></div>
      </div>`;
    } else {
      pane.innerHTML = `<div class="pane">
        <div><div class="group-label">Label</div><div class="group">
          <div class="row"><label for="setNick" class="k">Name</label>
            <span class="inline-edit"><input id="setNick" maxlength="24" placeholder="${esc(brandName(c.brand))}" value="${esc(c.nickname)}" enterkeyhint="done"><button class="save-mini" id="saveNick" hidden>Save</button></span>
          </div></div>
          <p class="group-foot">Shown on the card and in your wallet. Leave it empty to use the network name.</p></div>
        <div><div class="group-label">Card color</div><div class="group"><div class="swatches" role="radiogroup" aria-label="Card color" id="setSwatches"></div></div></div>
        <div><div class="group">
          <div class="row"><label for="setDefault" class="k grow">Use as default card</label><span class="switch"><input type="checkbox" role="switch" id="setDefault" ${c.id === state.defaultId ? 'checked' : ''}><span></span></span></div>
        </div><p class="group-foot">Your default card is shown first when you open the wallet.</p></div>
        <div class="group"><button class="row btn danger" id="removeCard">Remove Card</button></div>
      </div>`;
      const nick = $('#setNick'), save = $('#saveNick');
      nick.addEventListener('input', () => { save.hidden = nick.value.trim() === c.nickname; });
      const commit = () => {
        const v = nick.value.trim().replace(/\s+/g, ' ');
        if (v === c.nickname) { save.hidden = true; return; }
        c.nickname = v;
        persist();
        refreshCard(c);
        save.hidden = true;
        toast(v ? 'Label updated' : 'Label removed');
      };
      save.addEventListener('click', commit);
      nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); nick.blur(); } });
      renderSwatches($('#setSwatches'), c.theme, (t) => { c.theme = t; persist(); refreshCard(c); });
      $('#setDefault').addEventListener('change', (e) => {
        if (e.target.checked) {
          state.defaultId = c.id;
          toast('Default card updated');
        } else {
          const other = state.cards.find((x) => x.id !== c.id);
          if (!other) { e.target.checked = true; toast('Your only card stays the default', 'error'); return; }
          state.defaultId = other.id;
          toast(`${cardLabel(other)} is now your default`);
        }
        persist();
        refreshCard(c);
      });
      $('#removeCard').addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Remove this card?', message: `${cardLabel(c)} •••• ${c.last4} will be removed from this wallet.`, ok: 'Remove', destructive: true });
        if (!ok) return;
        removeCard(c.id);
      });
    }
  }

  function refreshCard(c) {
    $('#detailTitle').textContent = cardLabel(c);
    $('#detailCard').innerHTML = cardHTML(c);
    const s = [...carousel.children].find((x) => x.dataset.id === c.id);
    if (s) {
      $('.cw', s).innerHTML = cardHTML(c);
      s.setAttribute('aria-label', `${cardLabel(c)}, ${brandName(c.brand)} ending ${c.last4}${c.id === state.defaultId ? ', default card' : ''}. Open details`);
    }
    renderPanel();
  }

  function removeCard(id) {
    const i = state.cards.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [gone] = state.cards.splice(i, 1);
    txCache.delete(id);
    if (state.defaultId === id) state.defaultId = state.cards[0] ? state.cards[0].id : null;
    const next = state.cards[Math.min(i, state.cards.length - 1)];
    state.activeId = next ? next.id : null;
    persist();
    closeSheet(detailSheet);
    renderWallet();
    renderManage();
    toast(`${cardLabel(gone)} removed`);
  }

  function openDetail(id, tab, srcEl) {
    state.detailId = id;
    state.detailTab = tab || 'tx';
    renderDetail();
    $('#detailBody').scrollTop = 0;
    const tgtEl = $('#detailCard');
    if (!srcEl || reduceMotion || !srcEl.animate) { openSheet(detailSheet); return; }

    // Shared-element transition: fly the tapped card into the sheet.
    const src = srcEl.getBoundingClientRect();
    detailSheet.style.transition = 'none';
    detailSheet.classList.add('open');
    const tgt = tgtEl.getBoundingClientRect();
    detailSheet.classList.remove('open');
    void detailSheet.offsetWidth;
    detailSheet.style.transition = '';

    const clone = document.createElement('div');
    clone.className = 'cw';
    clone.innerHTML = srcEl.innerHTML;
    Object.assign(clone.style, { position: 'fixed', left: src.left + 'px', top: src.top + 'px', width: src.width + 'px', zIndex: 70, pointerEvents: 'none', transformOrigin: '0 0', margin: 0 });
    document.body.appendChild(clone);
    srcEl.style.visibility = 'hidden';
    tgtEl.style.visibility = 'hidden';
    openSheet(detailSheet);
    const s = tgt.width / src.width;
    const anim = clone.animate([
      { transform: 'translate(0,0) scale(1)' },
      { transform: `translate(${tgt.left - src.left}px, ${tgt.top - src.top}px) scale(${s})` },
    ], { duration: 520, easing: EASE, fill: 'forwards' });
    const done = () => { tgtEl.style.visibility = ''; srcEl.style.visibility = ''; clone.remove(); };
    anim.onfinish = done;
    anim.oncancel = done;
  }
  detailSheet.addEventListener('sheetclose', () => { state.detailId = null; });

  /* ---------------- Swatches ---------------- */
  function renderSwatches(el, selected, onPick) {
    el.innerHTML = THEMES.map(([id, name]) => `<button type="button" class="swatch t-${id}" role="radio" aria-checked="${id === selected}" aria-label="${name}" tabindex="${id === selected ? 0 : -1}" data-t="${id}"></button>`).join('');
    const pick = (b, focus) => {
      $$('.swatch', el).forEach((x) => { x.setAttribute('aria-checked', x === b); x.tabIndex = x === b ? 0 : -1; });
      if (focus) b.focus();
      onPick(b.dataset.t);
    };
    el.onclick = (e) => { const b = e.target.closest('.swatch'); if (b) pick(b); };
    el.onkeydown = (e) => {
      const all = $$('.swatch', el);
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % all.length;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + all.length) % all.length;
      if (n !== null) { e.preventDefault(); pick(all[n], true); }
    };
  }

  /* ---------------- Add card ---------------- */
  const fName = $('#fName'), fNumber = $('#fNumber'), fExp = $('#fExp'), fCvv = $('#fCvv'), fNick = $('#fNick'), fDefault = $('#fDefault');
  const form = $('#addForm');
  let addTheme = 'midnight';
  let touched = new Set();
  let cvvFocused = false;

  function readForm() {
    const digits = fNumber.value.replace(/\D/g, '');
    return {
      name: fName.value.trim().replace(/\s+/g, ' '),
      digits,
      brand: detectBrand(digits),
      exp: fExp.value.trim(),
      cvv: fCvv.value.replace(/\D/g, ''),
      nick: fNick.value.trim().replace(/\s+/g, ' '),
    };
  }

  function validate(f) {
    const e = {};
    if (!f.name) e.name = 'Enter the name shown on the card.';
    else if (f.name.length < 2 || !/^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(f.name)) e.name = 'Use letters only. Spaces, hyphens and apostrophes are fine.';

    if (!f.digits) e.number = 'Enter the card number.';
    else if (f.brand && !BRANDS[f.brand].lengths.includes(f.digits.length)) {
      const L = BRANDS[f.brand].lengths;
      e.number = `${brandName(f.brand)} numbers have ${L.length > 1 ? L.slice(0, -1).join(', ') + ' or ' + L[L.length - 1] : L[0]} digits.`;
    } else if (!f.brand && (f.digits.length < 12 || f.digits.length > 19)) e.number = 'Card numbers have 12 to 19 digits.';
    else if (!luhn(f.digits)) e.number = 'This card number isn’t valid. Check it for typos.';

    const m = /^(\d{2})\/(\d{2})$/.exec(f.exp);
    if (!f.exp) e.exp = 'Enter the expiry date.';
    else if (!m) e.exp = 'Enter the expiry date as MM/YY.';
    else if (+m[1] < 1 || +m[1] > 12) e.exp = 'The expiry month must be 01 to 12.';
    else {
      const ex = expiryState(f.exp);
      const yy = new Date().getFullYear() % 100;
      if (ex === 'expired') e.exp = 'This card has expired.';
      else if (+m[2] > yy + 20) e.exp = 'Check the expiry year.';
    }

    const need = f.brand ? BRANDS[f.brand].cvv : null;
    if (!f.cvv) e.cvv = 'Enter the security code from the back of the card.';
    else if (need && f.cvv.length !== need) e.cvv = `${brandName(f.brand)} security codes have ${need} digits.`;
    else if (!need && (f.cvv.length < 3 || f.cvv.length > 4)) e.cvv = 'The security code has 3 or 4 digits.';

    if (!e.number && !e.exp) {
      const last4 = f.digits.slice(-4);
      const brand = f.brand || 'unknown';
      if (state.cards.some((c) => c.brand === brand && c.last4 === last4 && c.exp === f.exp)) e.number = 'This card is already in your wallet.';
    }
    return e;
  }

  function showErrors(errs, shake) {
    const order = ['name', 'number', 'exp', 'cvv'];
    const visible = order.filter((k) => errs[k] && touched.has(k));
    $$('#addForm .field-row[data-field]').forEach((row) => {
      const k = row.dataset.field;
      const bad = visible.includes(k);
      row.classList.toggle('invalid', bad);
      const inp = $('input', row);
      inp.setAttribute('aria-invalid', bad);
      if (bad && shake) { row.style.animation = 'none'; void row.offsetWidth; row.style.animation = ''; }
    });
    $('#formErrors').innerHTML = visible.map((k) => `<p id="err-${k}">${esc(errs[k])}</p>`).join('');
    order.forEach((k) => {
      const inp = $(`#addForm [data-field=${k}] input`);
      if (visible.includes(k)) inp.setAttribute('aria-describedby', `err-${k}`); else inp.removeAttribute('aria-describedby');
    });
    return visible;
  }

  function renderPreview() {
    const f = readForm();
    const b = f.brand;
    const pseudo = {
      theme: addTheme, brand: b || 'unknown', last4: '', holder: f.name, exp: fExp.value, nickname: f.nick,
    };
    $('#pvFront').innerHTML = cardHTML(pseudo, {
      title: f.nick || (b ? brandName(b) : 'New Card'),
      sub: f.nick && b ? brandName(b) : '',
      numberHTML: previewNumberHTML(f.digits, b),
    });
    $('#pvBack').innerHTML = cardBackHTML(addTheme, f.cvv.length, cvvFocused);
    const tag = $('#brandTag');
    tag.hidden = !b;
    tag.textContent = b ? brandName(b) : '';
    fCvv.maxLength = b ? BRANDS[b].cvv : 4;
    $('#flip').classList.toggle('flipped', cvvFocused);
  }

  function liveValidate() { if (touched.size) showErrors(validate(readForm()), false); }

  fNumber.addEventListener('input', () => {
    const el = fNumber;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret).replace(/\D/g, '').length;
    let d = el.value.replace(/\D/g, '');
    const b = detectBrand(d);
    d = d.slice(0, maxLen(b));
    const f = formatDigits(d, b);
    el.value = f;
    let pos = 0, cnt = 0;
    while (pos < f.length && cnt < before) { if (/\d/.test(f[pos])) cnt++; pos++; }
    if (document.activeElement === el) el.setSelectionRange(pos, pos);
    if (fCvv.value.length > (b ? BRANDS[b].cvv : 4)) fCvv.value = fCvv.value.slice(0, b ? BRANDS[b].cvv : 4);
    renderPreview();
    liveValidate();
    // jump to expiry once a complete, valid number is in
    if (b && d.length === displayLen(b) && luhn(d) && !fExp.value) fExp.focus();
  });

  fExp.addEventListener('input', (e) => {
    let d = fExp.value.replace(/\D/g, '').slice(0, 4);
    if (d.length === 1 && +d > 1) d = '0' + d;
    const deleting = (e.inputType || '').startsWith('delete');
    fExp.value = d.length >= 3 ? d.slice(0, 2) + '/' + d.slice(2) : d.length === 2 && !deleting ? d + '/' : d;
    renderPreview();
    liveValidate();
    if (d.length === 4 && !fCvv.value) fCvv.focus();
  });
  fCvv.addEventListener('input', () => { fCvv.value = fCvv.value.replace(/\D/g, ''); renderPreview(); liveValidate(); });
  fCvv.addEventListener('focus', () => { cvvFocused = true; renderPreview(); });
  fCvv.addEventListener('blur', () => { cvvFocused = false; renderPreview(); });
  fName.addEventListener('input', () => { renderPreview(); liveValidate(); });
  fNick.addEventListener('input', renderPreview);
  [['name', fName], ['number', fNumber], ['exp', fExp], ['cvv', fCvv]].forEach(([k, el]) => {
    el.addEventListener('blur', () => { if (el.value) { touched.add(k); showErrors(validate(readForm()), false); } });
  });

  function resetForm() {
    form.reset();
    fNumber.value = ''; fCvv.value = '';
    touched = new Set();
    cvvFocused = false;
    addTheme = THEME_IDS[state.cards.length % THEME_IDS.length];
    fDefault.checked = state.cards.length === 0;
    renderSwatches($('#addSwatches'), addTheme, (t) => { addTheme = t; renderPreview(); });
    showErrors({}, false);
    renderPreview();
  }

  function openAdd() {
    resetForm();
    openSheet(addSheet, '#fName');
  }
  // Wipe sensitive inputs whenever the sheet closes, saved or not.
  addSheet.addEventListener('sheetclose', () => { fNumber.value = ''; fCvv.value = ''; setTimeout(resetForm, 520); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    ['name', 'number', 'exp', 'cvv'].forEach((k) => touched.add(k));
    const f = readForm();
    const errs = validate(f);
    const bad = showErrors(errs, true);
    if (bad.length) {
      buzz([20, 40, 20]);
      $(`#addForm [data-field=${bad[0]}] input`).focus();
      return;
    }
    const card = sanitizeCard({
      id: newId(),
      brand: f.brand || 'unknown',
      last4: f.digits.slice(-4),
      holder: f.name,
      exp: f.exp,
      nickname: f.nick,
      theme: addTheme,
      addedAt: Date.now(),
    });
    // Discard the sensitive values immediately.
    fNumber.value = ''; fCvv.value = '';
    f.digits = ''; f.cvv = '';

    state.cards.push(card);
    if (fDefault.checked || !state.defaultId) state.defaultId = card.id;
    state.activeId = card.id;
    state.query = ''; $('#searchInput').value = '';
    persist();
    closeSheet(addSheet);
    renderWallet({ pop: card.id, smooth: true });
    buzz(15);
    toast(`${cardLabel(card)} added to Wallet`);
  });

  /* ---------------- Manage (reorder + default) ---------------- */
  function renderManage() {
    const list = $('#manageList');
    if (!state.cards.length) { list.innerHTML = '<div class="row"><span class="grow" style="color:var(--mut)">No cards yet.</span></div>'; return; }
    list.innerHTML = state.cards.map((c) => `
      <div class="mrow" role="listitem" data-id="${c.id}">
        <div class="mthumb cw">${cardHTML(c)}</div>
        <div class="grow"><strong>${esc(cardLabel(c))}</strong><span>${esc(brandName(c.brand))} •••• ${c.last4}</span></div>
        <button class="star" aria-pressed="${c.id === state.defaultId}" aria-label="${c.id === state.defaultId ? 'Default card' : 'Make ' + esc(cardLabel(c)) + ' the default card'}"><svg><use href="${c.id === state.defaultId ? '#i-star' : '#i-star-o'}"/></svg></button>
        <button class="handle" aria-label="Reorder ${esc(cardLabel(c))}. Use the up and down arrow keys."><svg><use href="#i-grip"/></svg></button>
      </div>`).join('');
  }

  function moveCard(from, to) {
    if (to < 0 || to >= state.cards.length || from === to) return false;
    const [c] = state.cards.splice(from, 1);
    state.cards.splice(to, 0, c);
    persist();
    return true;
  }

  $('#manageList').addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (!star) return;
    const id = star.closest('.mrow').dataset.id;
    if (state.defaultId === id) return;
    state.defaultId = id;
    persist();
    renderManage();
    renderWallet();
    $(`.mrow[data-id="${id}"] .star`).focus();
    toast(`${cardLabel(byId(id))} is now your default`);
  });

  $('#manageList').addEventListener('keydown', (e) => {
    const h = e.target.closest('.handle');
    if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const id = h.closest('.mrow').dataset.id;
    const i = state.cards.findIndex((c) => c.id === id);
    if (moveCard(i, i + (e.key === 'ArrowUp' ? -1 : 1))) {
      renderManage();
      renderWallet();
      $(`.mrow[data-id="${id}"] .handle`).focus();
    }
  });

  // Pointer drag reordering
  (() => {
    const list = $('#manageList');
    let drag = null;
    list.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.handle');
      if (!h) return;
      e.preventDefault();
      const row = h.closest('.mrow');
      const rows = $$('.mrow', list);
      drag = { row, rows, start: rows.indexOf(row), y0: e.clientY, h: row.offsetHeight, to: rows.indexOf(row), id: row.dataset.id };
      h.setPointerCapture(e.pointerId);
      row.classList.add('drag');
      buzz(8);
    });
    list.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      const minDy = -drag.start * drag.h, maxDy = (drag.rows.length - 1 - drag.start) * drag.h;
      const cdy = Math.max(minDy, Math.min(maxDy, dy));
      drag.row.style.transform = `translateY(${cdy}px) scale(1.02)`;
      const to = Math.max(0, Math.min(drag.rows.length - 1, drag.start + Math.round(cdy / drag.h)));
      if (to !== drag.to) buzz(5);
      drag.to = to;
      drag.rows.forEach((r, i) => {
        if (r === drag.row) return;
        let shift = 0;
        if (drag.start < to && i > drag.start && i <= to) shift = -drag.h;
        if (drag.start > to && i < drag.start && i >= to) shift = drag.h;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    });
    const end = () => {
      if (!drag) return;
      const { start, to, id } = drag;
      drag = null;
      const moved = moveCard(start, to);
      renderManage();
      if (moved) { renderWallet(); }
      const h = $(`.mrow[data-id="${id}"] .handle`);
      h && h.focus({ preventScroll: true });
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
  })();

  /* ---------------- Sample data ---------------- */
  function loadSamples() {
    const y = new Date().getFullYear() % 100;
    const samples = [
      { brand: 'visa', last4: '4242', holder: 'Alex Morgan', exp: `08/${y + 3}`, nickname: 'Everyday', theme: 'midnight' },
      { brand: 'mastercard', last4: '4444', holder: 'Alex Morgan', exp: `03/${y + 2}`, nickname: 'Travel', theme: 'sunset' },
      { brand: 'amex', last4: '0005', holder: 'Alex Morgan', exp: `11/${y + 4}`, nickname: '', theme: 'graphite' },
      { brand: 'discover', last4: '1117', holder: 'Alex Morgan', exp: `06/${y + 1}`, nickname: 'Groceries', theme: 'pearl' },
    ];
    const now = Date.now();
    samples.forEach((s, i) => state.cards.push(sanitizeCard({ ...s, id: newId(), addedAt: now - (i + 1) * 864e5 * 40 })));
    state.defaultId = state.cards[0].id;
    state.activeId = state.defaultId;
    persist();
    renderWallet({ pop: state.activeId });
    toast('Sample cards added');
  }

  /* ---------------- Wire up ---------------- */
  $('#btnAdd').addEventListener('click', openAdd);
  $('#emptyAdd').addEventListener('click', openAdd);
  $('#emptySample').addEventListener('click', loadSamples);
  $('#btnManage').addEventListener('click', () => { renderManage(); openSheet(manageSheet); });

  // Open on the default card first.
  if (state.defaultId) state.activeId = state.defaultId;
  renderWallet();
})();

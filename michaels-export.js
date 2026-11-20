// Michaels Canada order history -> CSV, with a small panel on the page.
// Run on canada.michaels.com while logged in: paste into the DevTools Console,
// or load it from a bookmarklet. Running it again just re-opens the panel.
(() => {
  const PANEL_ID = 'michaels-export-panel';
  const existing = document.getElementById(PANEL_ID);
  if (existing) { existing.style.display = 'block'; return; }

  const API = 'https://www.michaels.com/api/moh';
  const ORDERS_URL = 'https://canada.michaels.com/buyertools/order-history';
  class LoginError extends Error {}
  const PAGE_SIZE = 10;   // the site uses 10
  const DELAY_MS = 300;   // pause between requests, to be polite to the site

  // The site replaces console.log with a no-op, so borrow a clean console from a blank iframe.
  const log = (() => {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f);
    return f.contentWindow.console.log.bind(console);
  })();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wrap ID-like values as ="..." so Excel/Sheets keep them as text:
  // otherwise 16-digit order numbers lose their last digits and codes like 06192640 lose the leading 0.
  const asText = (v) => (v == null || v === '' ? '' : `="${v}"`);
  const money = (n) => (n == null || n === '' ? '' : Number(n).toFixed(2));
  const fmtDate = (ms) =>
    ms ? new Date(Number(ms)).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
  const todayStr = () => new Date().toLocaleDateString('en-CA');

  // ---------- Auth ----------
  // The API needs the same "Authorization: Bearer <token>" header the site sends.
  // The site keeps it in localStorage (MIK_AUTH_TOKEN); fall back to any JWT-looking value.
  function findToken() {
    const jwt = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
    for (const key of ['MIK_AUTH_TOKEN', 'AUTH_TOKEN']) {
      const m = String(localStorage.getItem(key) || '').match(jwt);
      if (m) return m[0];
    }
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const m = String(store.getItem(store.key(i))).match(jwt);
        if (m) return m[0];
      }
    }
    for (const c of document.cookie.split('; ')) {
      const m = decodeURIComponent(c.split('=').slice(1).join('=')).match(jwt);
      if (m) return m[0];
    }
    return null;
  }

  // ---------- API ----------
  let cancelled = false;

  async function getJson(url, headers) {
    if (cancelled) throw new Error('Cancelled');
    const res = await fetch(url, { credentials: 'include', headers });
    if (res.status === 401 || res.status === 403) throw new LoginError('Your Michaels login has expired.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (String(body.code) !== '200') throw new Error(`API error ${body.code}: ${body.message}`);
    return body.data;
  }

  const listUrl = (page) =>
    `${API}/search/order/buyer/list/page?` +
    new URLSearchParams({
      keyWords: '', sortField: 'createdTime', isAsc: 'false',
      pageNum: page, pageSize: PAGE_SIZE, timeRange: 'customized', toAggregate: 'true',
    });

  const detailUrl = (num) =>
    `${API}/order/v5.1/buyer/parentOrderList/single?` +
    new URLSearchParams({ parentOrderNumber: num, parentOrderNumberList: '' });

  // ---------- Export ----------
  const HEADER = [
    'Order date', 'Order number', 'Status', 'Product', 'Color', 'SKU', 'Qty',
    'Regular price', 'Discount', 'Price paid (before tax)', 'Coupon code', 'Coupon',
    'Item tax', 'Item total', 'Order GST', 'Order PST', 'Order total', 'Pickup store', 'Note',
  ];

  // range: null for all orders, or { start, end } as ms timestamps (inclusive)
  async function runExport(range, ui) {
    const token = findToken();
    if (!token) throw new LoginError('You are not logged in to Michaels.');
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${token}`,
      lang: 'en_CA',
      region: 'CA',
    };
    const inRange = (ms) => !range || (ms >= range.start && ms <= range.end);

    // 1. Collect order summaries. Orders come newest first, so for a date range
    //    we can stop as soon as a page reaches orders older than the start date.
    ui.progress(null, 'Finding orders…');
    const summaries = [];
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1) await sleep(DELAY_MS);
      const data = await getJson(listUrl(page), headers);
      totalPages = data.totalPages;
      const content = data.content || [];
      summaries.push(...content.filter((s) => inRange(Number(s.createdTime))));
      ui.progress(null, `Finding orders… page ${page} of ${totalPages} (${summaries.length} found)`);
      const oldest = content.length ? Number(content[content.length - 1].createdTime) : 0;
      if (range && oldest < range.start) break;
    }
    log(`${summaries.length} orders to export`);
    if (!summaries.length) throw new Error('No orders found in that date range.');

    // 2. Fetch each order's details and flatten to one row per item.
    const rows = [];
    const failures = [];
    for (const [i, s] of summaries.entries()) {
      ui.progress(i / summaries.length, `Order ${i + 1} of ${summaries.length}`);
      await sleep(DELAY_MS);
      const base = [fmtDate(s.createdTime), asText(s.parentOrderNumber), s.statusString];
      try {
        const d = await getJson(detailUrl(s.parentOrderNumber), headers);
        const tax = (prefix) =>
          (d.taxDetails || [])
            .filter((t) => t.name.toUpperCase().startsWith(prefix))
            .reduce((sum, t) => sum + Number(t.amount), 0);
        const gst = money(tax('GST'));
        const pst = money(tax('PST'));

        for (const sub of d.subOrders || []) {
          const store = sub.orderPickup?.pickupStoreName ?? '';
          for (const line of sub.orderLines || []) {
            const qty = line.quantity ?? 1;
            const coupons = line.orderItemCoupons || [];
            rows.push([
              ...base,
              line.productName || line.shortDescription,
              (line.variance || []).find((v) => v.varianceName === 'Color')?.varianceValue ?? '',
              asText(line.skuNumber), qty,
              money(line.originalPrice),
              money(line.originalPrice * qty - line.itemSubtotal),
              money(line.itemSubtotal),
              asText(coupons.map((c) => c.code).join(' | ')),
              coupons.map((c) => c.salesRule).join(' | '),
              money(line.estimatedTax),
              money(line.itemGrandTotalCollected),
              gst, pst, money(s.grandTotal), store, '',
            ]);
          }
        }
      } catch (err) {
        if (cancelled) throw err;
        failures.push(s.parentOrderNumber);
        rows.push([...base, '', '', '', '', '', '', '', '', '', '', '', '', '', money(s.grandTotal), '', `Details failed: ${err.message}`]);
      }
    }
    ui.progress(1, 'Building file…');

    // 3. Build the CSV and download it.
    const cell = (v) => {
      const str = v == null ? '' : String(v);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = [HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }); // BOM so Excel reads ® etc.
    const name = range
      ? `michaels-orders-${fmtDate(range.start)}-to-${fmtDate(range.end)}.csv`
      : `michaels-orders-all-${todayStr()}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    window.michaelsRows = rows; // inspect in the console if needed
    log(`Done: ${rows.length} rows from ${summaries.length} orders.`, failures.length ? `Failed: ${failures.join(', ')}` : '');
    return { orders: summaries.length, rows: rows.length, failures, name };
  }

  // ---------- Panel ----------
  const host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); // keeps the site's CSS out

  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };
  const defaultFrom = daysAgo(30);
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel { font: 14px/1.4 system-ui, sans-serif; color: #222; background: #fff; width: 300px;
               border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 14px 16px; }
      h2 { font-size: 16px; margin: 0 0 10px; display: flex; justify-content: space-between; align-items: center; }
      .close { border: 0; background: none; font-size: 20px; cursor: pointer; color: #666; line-height: 1; }
      label { display: flex; align-items: center; gap: 6px; margin: 4px 0; cursor: pointer; }
      .dates { display: grid; grid-template-columns: 40px 1fr; gap: 6px 8px; align-items: center;
               margin: 6px 0 4px 24px; }
      .dates input { font: inherit; padding: 3px 4px; }
      .presets { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0 24px; }
      .presets button { font: inherit; font-size: 12px; padding: 3px 8px; border: 1px solid #bbb;
                        border-radius: 999px; background: #fff; cursor: pointer; }
      .presets button.active { background: #c8102e; border-color: #c8102e; color: #fff; }
      .range-label { margin: 2px 0 0 24px; font-weight: 600; font-size: 13px; }
      .off { opacity: .45; pointer-events: none; }
      .buttons { display: flex; gap: 8px; margin-top: 12px; }
      button.main { flex: 1; font: inherit; font-weight: 600; padding: 7px; border: 0; border-radius: 6px;
                    background: #c8102e; color: #fff; cursor: pointer; }
      button.secondary { font: inherit; padding: 7px 12px; border: 1px solid #bbb; border-radius: 6px;
                         background: #fff; cursor: pointer; }
      button:disabled { opacity: .5; cursor: default; }
      progress { width: 100%; height: 10px; margin-top: 12px; accent-color: #c8102e; }
      .status { font-size: 13px; color: #555; margin-top: 4px; min-height: 18px; }
      .status.error { color: #b00020; }
      .status a { color: #c8102e; font-weight: 600; }
      [hidden] { display: none !important; }
    </style>
    <div class="panel">
      <h2>Export Michaels orders <button class="close" title="Close">×</button></h2>
      <div class="controls">
      <label><input type="radio" name="mode" value="all" checked> All orders</label>
      <label><input type="radio" name="mode" value="range"> Date range</label>
      <div class="presets off">
        <button data-preset="7">Last 7 days</button>
        <button data-preset="30" class="active">Last 30 days</button>
        <button data-preset="thisMonth">This month</button>
        <button data-preset="lastMonth">Last month</button>
        <button data-preset="thisYear">This year</button>
      </div>
      <div class="dates off">
        <span>From</span><input type="date" class="from" value="${defaultFrom}">
        <span>To</span><input type="date" class="to" value="${todayStr()}">
      </div>
      <div class="range-label off"></div>
      <div class="buttons">
        <button class="main">Download CSV</button>
        <button class="secondary cancel" hidden>Cancel</button>
      </div>
      <progress hidden></progress>
      </div>
      <div class="status"></div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const dates = $('.dates');
  const fromInput = $('.from');
  const toInput = $('.to');
  const downloadBtn = $('.main');
  const cancelBtn = $('.cancel');
  const bar = $('progress');
  const status = $('.status');
  const controls = $('.controls');
  const radios = [...root.querySelectorAll('input[name=mode]')];

  const presets = $('.presets');
  const rangeLabel = $('.range-label');
  const presetBtns = [...presets.querySelectorAll('button')];

  const mode = () => radios.find((r) => r.checked).value;
  const parseDay = (str) => { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); };
  const pretty = (str) =>
    str ? parseDay(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
  const ymd = (d) => d.toLocaleDateString('en-CA');

  function updateRangeUi() {
    const isRange = mode() === 'range';
    [presets, dates, rangeLabel].forEach((el) => el.classList.toggle('off', !isRange));
    rangeLabel.textContent = `${pretty(fromInput.value)} – ${pretty(toInput.value)}`;
  }

  function applyPreset(name) {
    const now = new Date();
    let from = now, to = now;
    if (name === '7' || name === '30') { from = new Date(now); from.setDate(now.getDate() - Number(name)); }
    else if (name === 'thisMonth') from = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (name === 'lastMonth') {
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 0); // last day of last month
    } else if (name === 'thisYear') from = new Date(now.getFullYear(), 0, 1);
    fromInput.value = ymd(from);
    toInput.value = ymd(to);
    presetBtns.forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
    updateRangeUi();

  }

  radios.forEach((r) => r.addEventListener('change', updateRangeUi));
  presetBtns.forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  [fromInput, toInput].forEach((el) => el.addEventListener('input', () => {
    presetBtns.forEach((b) => b.classList.remove('active')); // custom dates
    updateRangeUi();
  }));
  updateRangeUi();
  $('.close').addEventListener('click', () => { cancelled = true; host.remove(); });

  const setStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };

  // Login problems get a message with a link to the order history page
  // (it sends you to sign in first if you aren't logged in).
  function showLoginHelp(reason) {
    controls.hidden = true;
    status.classList.add('error');
    status.innerHTML = '';
    status.append(
      `${reason} Log in at `,
      Object.assign(document.createElement('a'), { href: ORDERS_URL, textContent: 'canada.michaels.com', target: '_top' }),
      ', go to your order history, then click the bookmark again.',
    );
  }

  const ui = {
    // fraction null = indeterminate (bar animates)
    progress(fraction, text) {
      bar.hidden = false;
      if (fraction == null) bar.removeAttribute('value');
      else { bar.max = 1; bar.value = fraction; }
      setStatus(text);
    },
  };

  const setBusy = (busy) => {
    downloadBtn.disabled = busy;
    cancelBtn.hidden = !busy;
    radios.forEach((r) => (r.disabled = busy));
    fromInput.disabled = toInput.disabled = busy;
    presetBtns.forEach((b) => (b.disabled = busy));
  };

  cancelBtn.addEventListener('click', () => { cancelled = true; setStatus('Cancelling…'); });

  downloadBtn.addEventListener('click', async () => {
    let range = null;
    if (mode() === 'range') {
      if (!fromInput.value || !toInput.value) return setStatus('Pick both dates.', true);
      const [fy, fm, fd] = fromInput.value.split('-').map(Number);
      const [ty, tm, td] = toInput.value.split('-').map(Number);
      range = { start: new Date(fy, fm - 1, fd).getTime(), end: new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime() };
      if (range.start > range.end) return setStatus('"From" must be on or before "To".', true);
    }
    cancelled = false;
    setBusy(true);
    try {
      const r = await runExport(range, ui);
      bar.value = 1;
      setStatus(
        `Done: ${r.orders} orders, ${r.rows} rows → ${r.name}` +
        (r.failures.length ? ` (${r.failures.length} orders failed; see Note column)` : ''),
      );
    } catch (err) {
      bar.hidden = true;
      if (err instanceof LoginError) showLoginHelp(err.message);
      else setStatus(cancelled ? 'Cancelled.' : err.message, !cancelled);
    } finally {
      setBusy(false);
    }
  });

  // Check up front: right site, and logged in.
  if (location.hostname !== 'canada.michaels.com') {
    controls.hidden = true;
    status.classList.add('error');
    status.append(
      'This only works on the Michaels Canada website. Open ',
      Object.assign(document.createElement('a'), { href: ORDERS_URL, textContent: 'your order history', target: '_top' }),
      ', then click the bookmark again.',
    );
  } else if (!findToken()) {
    showLoginHelp('You are not logged in to Michaels.');
  }

})();

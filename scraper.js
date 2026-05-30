/**
 * TapTouch Scraper v4
 * 抓取:
 *   1. Dashboard (KPI + 每小时图表)
 *   2. 全部订单列表 (分页)
 *   3. 每笔订单详情 (菜品明细)
 *   4. 销售报告 (本周/本月汇总)
 */
'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key || process.env[key]) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadLocalEnvFile('.env.local');
loadLocalEnvFile('.env');

const CREDS = {
  email:    process.env.TAPTOUCH_EMAIL    || '',
  password: process.env.TAPTOUCH_PASSWORD || '',
};
const BASE = 'https://backoffice.taptouch.net';
const wait = ms => new Promise(r => setTimeout(r, ms));
const MAX_ORDER_PAGES = 15;
const DETAIL_CONCURRENCY = Math.max(1, Number(process.env.TAPTOUCH_DETAIL_CONCURRENCY || 4));
const DETAIL_SAVE_EVERY = Math.max(1, Number(process.env.TAPTOUCH_DETAIL_SAVE_EVERY || 10));
const SCRAPE_RESULT_PATH = 'scrape-result.json';
const PREFETCH_DETAILS = /^(1|true|yes)$/i.test(process.env.TAPTOUCH_PREFETCH_DETAILS || '');

function formatQueryDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getCurrentWeekRange(referenceDate = new Date()) {
  const ref = new Date(referenceDate);
  const day = ref.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const start = new Date(ref);
  start.setDate(ref.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 0);

  return { start, end };
}

function buildOrdersReportUrl({ label, start, end } = {}) {
  const url = new URL(`${BASE}/store/report/orders`);
  if (label) url.searchParams.set('label', label);
  if (start) url.searchParams.set('startdt', formatQueryDate(start));
  if (end) url.searchParams.set('enddt', formatQueryDate(end));
  return url.toString();
}

function buildDashboardUrl({ label, start, end, sid } = {}) {
  const url = new URL(`${BASE}/store/dashboard`);
  if (sid) url.searchParams.set('sid', sid);
  if (label) url.searchParams.set('label', label);
  if (start) url.searchParams.set('startdt', formatQueryDate(start));
  if (end) url.searchParams.set('enddt', formatQueryDate(end));
  return url.toString();
}

function buildReceiptUrl(txId) {
  const url = new URL(`${BASE}/store/report/order/${txId}`);
  url.searchParams.set('cloud', '1');
  url.searchParams.set('process', '0');
  url.searchParams.set('modalframe', '1');
  return url.toString();
}

function normalizeReceiptText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function extractReceiptMoney(text, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escapedLabel}\\s+\\$?([\\d.]+)\\s*$`, 'im'));
  return match ? parseFloat(match[1]) : 0;
}

function parseReceiptItems(bodyText) {
  const normalized = normalizeReceiptText(bodyText);
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const itemHeaderIndex = lines.findIndex(line => /^Item Name\b/i.test(line));
  if (itemHeaderIndex === -1) return [];

  const itemLines = [];
  for (let i = itemHeaderIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^Sub-Total\b/i.test(line)) break;
    if (!line || /^Price\(\$\)$/i.test(line)) continue;
    itemLines.push(line.replace(/\s+/g, ' ').trim());
  }

  const items = [];
  for (const line of itemLines) {
    if (!line || /^\*/.test(line)) continue;

    if (/^\+/.test(line)) {
      const previousItem = items[items.length - 1];
      if (!previousItem) continue;

      let addonName = line.replace(/^\+\s*/, '').trim();
      let addonQty = 1;
      let addonAmount = 0;

      const addonMatch = line.match(/^\+\s*(.+?)\s+x\s*(\d+)\s+\$?([\d.]+)$/i);
      if (addonMatch) {
        addonName = addonMatch[1].trim();
        addonQty = parseInt(addonMatch[2], 10) || 1;
        addonAmount = parseFloat(addonMatch[3]) || 0;
      } else {
        const fallbackMatch = line.match(/^\+\s*(.+?)\s+\$?([\d.]+)$/);
        if (fallbackMatch) {
          addonName = fallbackMatch[1].trim();
          addonAmount = parseFloat(fallbackMatch[2]) || 0;
          const embeddedQty = addonName.match(/(.+?)\s+x\s*(\d+)$/i);
          if (embeddedQty) {
            addonName = embeddedQty[1].trim();
            addonQty = parseInt(embeddedQty[2], 10) || 1;
          }
        }
      }

      const addonLabel = `${addonName}${addonQty > 1 ? ` x ${addonQty}` : ''}${addonAmount > 0 ? ` (+${formatMoney(addonAmount)})` : ''}`;
      previousItem.note = previousItem.note ? `${previousItem.note}\n${addonLabel}` : addonLabel;
      continue;
    }

    let match = line.match(/^(.*?)\s+(\d+)\s+\$?([\d.]+)$/);
    let name = '';
    let qty = 1;
    let amount = 0;

    if (match) {
      name = match[1].trim();
      qty = parseInt(match[2], 10) || 1;
      amount = parseFloat(match[3]) || 0;
    } else {
      match = line.match(/^(.*?)\s+\$?([\d.]+)$/);
      if (!match) continue;
      name = match[1].trim();
      amount = parseFloat(match[2]) || 0;
    }

    if (!name) continue;
    items.push({
      name,
      qty: String(qty),
      price: formatMoney(qty > 0 ? amount / qty : amount),
      subtotal: formatMoney(amount),
      note: '',
    });
  }

  return items;
}

function parseReceiptPaymentMethods(bodyText) {
  const normalized = normalizeReceiptText(bodyText);
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const subtotalIndex = lines.findIndex(line => /^Sub-Total\b/i.test(line));
  if (subtotalIndex === -1) return [];

  const ignoredLabels = new Set(['Sub-Total', 'Total', 'GST Included In Total', 'Surcharge', 'Total Paid']);
  return lines
    .slice(subtotalIndex + 1)
    .map(line => {
      const match = line.match(/^(.*?)\s+\$?([\d.]+)$/);
      if (!match) return null;
      const label = match[1].replace(/^\*\s*/, '').trim();
      const amount = parseFloat(match[2]) || 0;
      if (!label || ignoredLabels.has(label) || /^Indicates Tax Free Items$/i.test(label)) {
        return null;
      }
      return { label, amount };
    })
    .filter(Boolean);
}

function parseReceiptDetail(bodyText, order, url) {
  const normalized = normalizeReceiptText(bodyText);
  const items = parseReceiptItems(normalized);
  const paymentMethods = parseReceiptPaymentMethods(normalized);

  const subtotal = extractReceiptMoney(normalized, 'Sub-Total');
  const total = extractReceiptMoney(normalized, 'Total');
  const gst = extractReceiptMoney(normalized, 'GST Included In Total');
  const surcharge = extractReceiptMoney(normalized, 'Surcharge');
  const totalPaid = extractReceiptMoney(normalized, 'Total Paid');
  const fulfillment = (normalized.match(/^Fulfillment:\s*(.+)$/im) || [])[1] || order.type || '';
  const orderTime = (normalized.match(/^Order Time:\s*(.+)$/im) || [])[1] || order.date || '';
  const transactionId = (normalized.match(/^Transaction Id:\s*(\d+)$/im) || [])[1] || order.txId || '';

  const cardTotal = paymentMethods
    .filter(method => /mastercard|visa|eftpos|amex|card/i.test(method.label))
    .reduce((sum, method) => sum + method.amount, 0);
  const cashTotal = paymentMethods
    .filter(method => /cash/i.test(method.label))
    .reduce((sum, method) => sum + method.amount, 0);

  return {
    orderId: order.id || order.txId || '',
    txId: transactionId,
    url,
    bodyText: normalized.substring(0, 5000),
    receipt: {
      fulfillment,
      orderTime,
      transactionId,
    },
    items,
    totals: {
      subtotal,
      total,
      gst,
      surcharge,
      totalPaid,
    },
    payment: {
      cash: cashTotal,
      card: cardTotal,
      total: totalPaid || total,
      tax: gst,
      surcharge,
      methods: paymentMethods,
    },
  };
}

async function collectOrdersList(page, url, scopeLabel) {
  console.log(`[Scraper] Loading ${scopeLabel} orders list...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await wait(2000);

  try {
    await page.select('select[name="orders_list_length"]', '100');
    await wait(1500);
  } catch {}

  const orders = [];
  let pageNum = 1;

  while (pageNum <= MAX_ORDER_PAGES) {
    console.log(`[Scraper] ${scopeLabel} orders page ${pageNum}...`);
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table tbody tr')).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length < 8 || !cells[0]) return null;

        const link = row.querySelector('a');
        const detailUrl = link?.href || '';

        return {
          id:        cells[0]  || '',
          txId:      cells[1]  || '',
          source:    cells[2]  || '',
          type:      cells[3]  || '',
          date:      cells[4]  || '',
          cashier:   cells[5]  || '-',
          customer:  cells[6]  || '-',
          tax:       cells[7]  || '$0',
          amount:    cells[8]  || '$0',
          discount:  cells[9]  || '$0',
          redeem:    cells[10] || '$0',
          rounding:  cells[11] || '$0',
          status:    cells[12] || 'paid',
          detailUrl,
        };
      }).filter(r => r && r.id && r.amount);
    });

    if (rows.length === 0) break;
    orders.push(...rows);
    console.log(`[Scraper] ${scopeLabel} page ${pageNum}: ${rows.length} orders (total: ${orders.length})`);

    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector('#orders_list_next');
      return btn && !btn.classList.contains('disabled');
    });
    if (!hasNext) break;

    await page.click('#orders_list_next');
    await wait(1500);
    pageNum++;
  }

  console.log(`[Scraper] ✅ ${scopeLabel} orders: ${orders.length}`);
  return orders;
}

function loadExistingResult() {
  try {
    return JSON.parse(fs.readFileSync(SCRAPE_RESULT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function buildSyncState({
  phase,
  message,
  coreReady,
  detailReady = 0,
  detailTotal = 0,
  detailFetchedThisRun = 0,
  detailMissing = 0,
}) {
  return {
    phase,
    message,
    coreReady,
    detailReady,
    detailTotal,
    detailFetchedThisRun,
    detailMissing,
    detailPercent: detailTotal > 0 ? Math.round(detailReady / detailTotal * 100) : 100,
    updatedAt: new Date().toISOString(),
  };
}

function buildResultSnapshot({
  capturedAt,
  dashData,
  weeklyDashData,
  salesReport,
  allOrders,
  weeklyOrders,
  orderDetails,
  syncState,
}) {
  return {
    loginSuccess: true,
    timestamp: capturedAt,
    dashData,
    weeklyDashData,
    salesReport,
    allOrders,
    weeklyOrders,
    orderDetails,
    syncState,
    apiCalls: [],
    scrapedPages: {
      '/store/report': {
        tables: [{
          headers: ['Number','Transaction ID','Source','Fulfillment Type','Date','Cashier','Customer','Tax','Total Sales','Discount','Redeem Points','Rounding','Status'],
          firstRows: allOrders.slice(0, 100).map(o =>
            [o.id,o.txId,o.source,o.type,o.date,o.cashier,o.customer,o.tax,o.amount,o.discount,o.redeem,o.rounding,o.status]
          ),
        }],
      },
    },
  };
}

function saveResultSnapshot(snapshot) {
  fs.writeFileSync(SCRAPE_RESULT_PATH, JSON.stringify(snapshot, null, 2));
}

async function createWorkerPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  await page.setViewport({ width: 1440, height: 900 });
  return page;
}

async function loginToTapTouch(page) {
  if (!CREDS.email || !CREDS.password) {
    throw new Error('Missing TapTouch credentials. Set TAPTOUCH_EMAIL and TAPTOUCH_PASSWORD in .env.local or your shell environment.');
  }

  console.log('[Scraper] Logging in...');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('input[name="account"]', { timeout: 10000 });
  await page.type('input[name="account"]', CREDS.email,    { delay: 50 });
  await page.type('input[name="password"]', CREDS.password, { delay: 50 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await wait(1500);

  if (page.url().includes('/auth') && !page.url().includes('dashboard')) {
    throw new Error('Login failed: ' + page.url());
  }
  console.log('[Scraper] ✅ Login OK');
}

async function ensureStoreContext(page, sid) {
  console.log('[Scraper] Preparing store context...');
  await page.goto(buildDashboardUrl({ sid }), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await wait(1500);
  return new URL(page.url()).searchParams.get('sid') || sid || null;
}

async function readReceiptDetail(page, order, expectedUrl = '') {
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return /Transaction Receipt|Receipt|Total Paid|Sub-Total/i.test(text);
      },
      { timeout: 6000 }
    );
  } catch {}

  await wait(500);

  const currentUrl = page.url();
  if (currentUrl.includes('404') || currentUrl.includes('login')) {
    console.log(`[Scraper] Receipt redirect for ${order.txId || order.id}: ${currentUrl}`);
    return null;
  }

  const bodyText = await page.evaluate(() => {
    const markers = /Transaction Receipt|Receipt|Total Paid|Sub-Total/i;
    const candidateTexts = Array.from(document.querySelectorAll('body *'))
      .map(element => (element.innerText || '').trim())
      .filter(text => text.length > 50 && markers.test(text))
      .sort((left, right) => left.length - right.length);

    return candidateTexts[0] || document.body?.innerText || '';
  });
  if (!/Transaction Receipt|Receipt|Total Paid|Sub-Total/i.test(bodyText)) {
    console.log(`[Scraper] Receipt body missing markers for ${order.txId || order.id}: ${currentUrl}`);
    return null;
  }

  const receiptUrl = currentUrl.includes('/store/report/order/') ? currentUrl : (expectedUrl || currentUrl);
  return parseReceiptDetail(bodyText, order, receiptUrl);
}

async function fetchOrderDetail(page, order) {
  const candidateUrls = Array.from(new Set([
    order.detailUrl,
    order.txId ? buildReceiptUrl(order.txId) : null,
  ].filter(Boolean)));

  for (const detailUrl of candidateUrls) {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const detail = await readReceiptDetail(page, order, detailUrl);
    if (detail) return detail;
  }

  return null;
}

async function fetchOrderDetailFromOrdersList(page, order) {
  const lookupKey = order.txId || order.id;
  if (!lookupKey) return null;

  await page.goto(`${BASE}/store/report/orders`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await wait(2000);

  try {
    await page.select('select[name="orders_list_length"]', '100');
    await wait(1200);
  } catch {}

  try {
    const searchSelector = '#orders_list_filter input';
    await page.waitForSelector(searchSelector, { timeout: 5000 });
    await page.click(searchSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(searchSelector, lookupKey, { delay: 30 });
    await wait(1200);
  } catch {}

  const receiptHref = await page.evaluate((value) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find(currentRow => currentRow.innerText.includes(value));
    return row?.querySelector('a')?.href || '';
  }, lookupKey);

  const linkHandle = await page.evaluateHandle((value) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find(currentRow => currentRow.innerText.includes(value));
    return row?.querySelector('a') || null;
  }, lookupKey);

  const linkElement = linkHandle.asElement();
  if (!linkElement) {
    console.log(`[Scraper] Receipt link not found in orders list for ${lookupKey}`);
    await linkHandle.dispose();
    return null;
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
    linkElement.click(),
  ]);
  await linkHandle.dispose();

  return readReceiptDetail(page, order, receiptHref);
}

async function fetchSingleOrderDetail(order, options = {}) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  try {
    const page = await createWorkerPage(browser);
    await loginToTapTouch(page);
    await ensureStoreContext(page, options.sid);
    let detail = await fetchOrderDetail(page, order);

    if (!detail) {
      console.log(`[Scraper] Receipt fallback via orders list for ${order.txId || order.id}...`);
      detail = await fetchOrderDetailFromOrdersList(page, order);
    }

    await page.close();
    return detail;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────
async function scrapeTapTouch() {
  console.log('[Scraper] Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  await page.setViewport({ width: 1440, height: 900 });

  try {
    const previousRaw = loadExistingResult();
    const weekRange = getCurrentWeekRange();

    // ══ 1. Login ══════════════════════════════════════════════
    await loginToTapTouch(page);

    // ══ 2. Dashboard ══════════════════════════════════════════
    console.log('[Scraper] Loading dashboard...');
    await page.goto(`${BASE}/store/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await wait(3000);
    const dashHTML  = await page.content();
    const dashBody  = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    fs.writeFileSync('debug-dashboard.html', dashHTML);

    // Extract embedded Chart.js data block
    const chartBlock = dashHTML.match(/\$\(document\)\.ready\(function \(\) \{[\s\S]*?"label":"Offline Sales"[\s\S]*?\}\);/)?.[0] || '';
    console.log('[Scraper] Dashboard chart block found:', chartBlock.length > 0);

    const dashboardSid = new URL(page.url()).searchParams.get('sid');

    console.log('[Scraper] Loading weekly dashboard...');
    await page.goto(buildDashboardUrl({
      sid:   dashboardSid,
      label: 'This Week',
      start: weekRange.start,
      end:   weekRange.end,
    }), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await wait(3000);

    const weeklyDashHTML = await page.content();
    const weeklyDashBody = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    const weeklyChartBlock = weeklyDashHTML.match(/\$\(document\)\.ready\(function \(\) \{[\s\S]*?"label":"Offline Sales"[\s\S]*?\}\);/)?.[0] || '';
    console.log('[Scraper] Weekly dashboard chart block found:', weeklyChartBlock.length > 0);

    // ══ 3. Sales Report ═══════════════════════════════════════
    const salesReport = {};

    // ══ 4. Orders: today + current week ══════════════════════
    const allOrders = await collectOrdersList(page, `${BASE}/store/report/orders`, 'today');

    let weeklyOrders = allOrders;
    try {
      const weeklyUrl = buildOrdersReportUrl({
        label: 'This Week',
        start: weekRange.start,
        end:   weekRange.end,
      });
      weeklyOrders = await collectOrdersList(page, weeklyUrl, 'weekly');
    } catch (err) {
      console.log('[Scraper] Weekly orders fallback:', err.message);
    }

    const capturedAt = new Date().toISOString();
    const dashData = {
      sid:      dashboardSid,
      bodyText: dashBody,
      cards:    [chartBlock],
    };
    const weeklyDashData = {
      sid:      dashboardSid,
      bodyText: weeklyDashBody,
      cards:    [weeklyChartBlock],
    };

    const seededOrderDetails = {};
    for (const order of allOrders) {
      const key = order.txId || order.id;
      if (previousRaw.orderDetails?.[key]) {
        seededOrderDetails[key] = previousRaw.orderDetails[key];
      }
    }

    const detailTargets = allOrders.filter(order => !seededOrderDetails[order.txId || order.id]);
    const totalDetails = allOrders.length;
    let detailReadyCount = Object.keys(seededOrderDetails).length;
    let detailFetchedThisRun = 0;

    const saveSnapshot = (phase, message) => {
      const snapshot = buildResultSnapshot({
        capturedAt,
        dashData,
        weeklyDashData,
        salesReport,
        allOrders,
        weeklyOrders,
        orderDetails: seededOrderDetails,
        syncState: buildSyncState({
          phase,
          message,
          coreReady: true,
          detailReady: detailReadyCount,
          detailTotal: totalDetails,
          detailFetchedThisRun,
          detailMissing: Math.max(totalDetails - detailReadyCount, 0),
        }),
      });
      saveResultSnapshot(snapshot);
      return snapshot;
    };

    if (!PREFETCH_DETAILS) {
      const finalResult = saveSnapshot(
        'complete',
        `⚡ 核心数据已更新，订单详情按需加载（已缓存 ${detailReadyCount}/${totalDetails}）`
      );
      const sizeMB = (fs.statSync(SCRAPE_RESULT_PATH).size / 1024 / 1024).toFixed(2);
      console.log(`\n[Scraper] ✅ Done! scrape-result.json (${sizeMB} MB)`);
      console.log(`  Orders:          ${allOrders.length}`);
      console.log(`  Order details:   on-demand (${detailReadyCount}/${totalDetails} cached)`);
      console.log(`  Sales reports:   ${Object.keys(salesReport).length}`);

      await browser.close();
      return finalResult;
    }

    saveSnapshot(
      detailTargets.length > 0 ? 'core_ready' : 'complete',
      detailTargets.length > 0
        ? `核心数据已更新，订单详情后台补齐中（${detailReadyCount}/${totalDetails}）`
        : '核心数据与订单详情已全部更新'
    );
    console.log(`[Scraper] ⚡ Core data saved (${detailReadyCount}/${totalDetails} details ready)`);

    // ══ 5. Order Details (items per order) ═══════════════════
    console.log(`[Scraper] Fetching missing order details with ${Math.min(DETAIL_CONCURRENCY, Math.max(detailTargets.length, 1))} workers...`);

    let nextIndex = 0;
    const workerCount = Math.min(DETAIL_CONCURRENCY, Math.max(detailTargets.length, 1));

    const workerTasks = Array.from({ length: workerCount }, async () => {
      if (detailTargets.length === 0) return;

      const workerPage = await createWorkerPage(browser);
      try {
        while (nextIndex < detailTargets.length) {
          const order = detailTargets[nextIndex++];
          if (!order) break;

          try {
            const detail = await fetchOrderDetail(workerPage, order);
            if (detail) {
              seededOrderDetails[order.txId || order.id] = detail;
              detailReadyCount++;
            }
          } catch {}

          detailFetchedThisRun++;
          if (
            detailFetchedThisRun % DETAIL_SAVE_EVERY === 0 ||
            detailFetchedThisRun === detailTargets.length
          ) {
            console.log(`[Scraper] Order details ready: ${detailReadyCount}/${totalDetails}`);
            saveSnapshot(
              detailFetchedThisRun === detailTargets.length ? 'details_finalizing' : 'details',
              `核心数据已更新，订单详情补齐中（${detailReadyCount}/${totalDetails}）`
            );
          }
        }
      } finally {
        await workerPage.close();
      }
    });

    await Promise.all(workerTasks);

    const finalResult = saveSnapshot('complete', `✅ 数据更新成功（${detailReadyCount}/${totalDetails} 详情就绪）`);
    const sizeMB = (fs.statSync(SCRAPE_RESULT_PATH).size / 1024 / 1024).toFixed(2);
    console.log(`\n[Scraper] ✅ Done! scrape-result.json (${sizeMB} MB)`);
    console.log(`  Orders:          ${allOrders.length}`);
    console.log(`  Order details:   ${detailReadyCount}/${totalDetails}`);
    console.log(`  Cached reused:   ${Object.keys(seededOrderDetails).length - detailFetchedThisRun}`);
    console.log(`  Sales reports:   ${Object.keys(salesReport).length}`);

    await browser.close();
    return finalResult;

  } catch (err) {
    console.error('[Scraper] ❌', err.message);
    try { await page.screenshot({ path: 'debug-error.png' }); } catch {}
    await browser.close();
    throw err;
  }
}

module.exports = {
  scrapeTapTouch,
  fetchSingleOrderDetail,
  parseReceiptDetail,
};

// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeTapTouch()
    .then(r => console.log('\n✅ Complete! Orders:', r.allOrders?.length, '| Details:', Object.keys(r.orderDetails || {}).length))
    .catch(err => { console.error('Failed:', err.message); process.exit(1); });
}

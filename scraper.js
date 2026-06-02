/**
 * TapTouch Scraper v4
 * 抓取:
 *   1. Dashboard (KPI + 每小时图表)
 *   2. 全部订单列表 (分页)
 *   3. 每笔订单详情 (菜品明细)
 *   4. 销售报告 (本周/本月汇总)
 */
'use strict';

const fs        = require('fs');
const { launchBrowser } = require('./browser');

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
const ORDER_PAGE_SIZE = Math.max(25, Number(process.env.TAPTOUCH_ORDER_PAGE_SIZE || 1000));
const DETAIL_CONCURRENCY = Math.max(1, Number(process.env.TAPTOUCH_DETAIL_CONCURRENCY || 4));
const DETAIL_SAVE_EVERY = Math.max(1, Number(process.env.TAPTOUCH_DETAIL_SAVE_EVERY || 10));
const DETAIL_PRIME_COUNT = Math.max(0, Number(process.env.TAPTOUCH_DETAIL_PRIME_COUNT || 8));
const SCRAPE_RESULT_PATH = 'scrape-result.json';
const PREFETCH_DETAILS = /^(1|true|yes)$/i.test(process.env.TAPTOUCH_PREFETCH_DETAILS || '');

function hasConfiguredTapTouchCredentials() {
  const email = String(CREDS.email || '').trim();
  const password = String(CREDS.password || '').trim();

  if (!email || !password) return false;
  if (email === 'your-email@example.com') return false;
  if (password === 'your-password') return false;

  return true;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractSidFromUrl(url) {
  try {
    return new URL(url).searchParams.get('sid') || null;
  } catch {
    return null;
  }
}

function extractChartBlockFromHtml(html) {
  return String(html || '').match(/\$\(document\)\.ready\(function \(\) \{[\s\S]*?"label":"Offline Sales"[\s\S]*?\}\);/)?.[0] || '';
}

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

function buildDayRange(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  const [, year, month, day] = match;
  const start = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  const end = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 0);
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

function buildProductReportUrl({ label, start, end, sid } = {}) {
  const url = new URL(`${BASE}/store/report/product`);
  if (sid) url.searchParams.set('sid', sid);
  if (label) url.searchParams.set('label', label);
  if (start) url.searchParams.set('startdt', formatQueryDate(start));
  if (end) url.searchParams.set('enddt', formatQueryDate(end));
  return url.toString();
}

function parseProductsFromHtml(html) {
  const rowMatches = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const products = [];

  for (const rowHtml of rowMatches) {
    const cellMatches = rowHtml.match(/<td[\s\S]*?<\/td>/gi) || [];
    const cells = cellMatches.map(cell => decodeHtmlEntities(
      cell
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    ));

    if (cells.length < 8) continue;

    const name = cells[1] || '';
    const code = cells[2] || '';
    const category = cells[3] || '未分类';
    const onlineQtyStr = cells[4] || '0';
    const onlineAmountStr = cells[5] || '$0';
    const qtyStr = cells[6] || '0';
    const amountStr = cells[7] || '$0';
    const shareStr = cells[8] || '0%';
    const costStr = cells[9] || '$0';
    const profitStr = cells[10] || '$0';

    const onlineQty = parseInt(onlineQtyStr.replace(/,/g, ''), 10) || 0;
    const onlineAmount = parseFloat(onlineAmountStr.replace(/[$,]/g, '')) || 0.0;
    const qty = parseInt(qtyStr.replace(/,/g, ''), 10) || 0;
    const amount = parseFloat(amountStr.replace(/[$,]/g, '')) || 0.0;
    const sharePct = parseFloat(String(shareStr).replace(/[^0-9.-]/g, '')) || 0.0;
    const cost = parseFloat(costStr.replace(/[$,]/g, '')) || 0.0;
    const profit = parseFloat(profitStr.replace(/[$,]/g, '')) || amount;

    if (!name || qty <= 0) continue;
    if (name.toLowerCase().includes('total') || name.toLowerCase().includes('summary')) continue;

    products.push({
      rank: products.length + 1,
      name,
      code,
      category,
      onlineQty,
      onlineAmount,
      qty,
      amount,
      sharePct,
      cost,
      profit,
    });
  }

  return products
    .sort((a, b) => (b.qty - a.qty) || (b.amount - a.amount))
    .map((product, index) => ({
      ...product,
      rank: index + 1,
    }));
}

function buildPagedReportUrl(url, pageNum, perPage = ORDER_PAGE_SIZE) {
  const pageUrl = new URL(url);
  pageUrl.searchParams.set('per_page', String(perPage));
  pageUrl.searchParams.set('page', String(pageNum));
  return pageUrl.toString();
}

function buildReceiptUrl(txId) {
  const url = new URL(`${BASE}/store/report/order/${txId}`);
  url.searchParams.set('cloud', '1');
  url.searchParams.set('process', '0');
  url.searchParams.set('modalframe', '1');
  return url.toString();
}

function isSummaryOrderRow(order) {
  const id = String(order?.id || '').trim();
  const idKey = id.toLowerCase().replace(/[\s:]/g, '');
  const txId = String(order?.txId || '').trim();
  const amount = String(order?.amount || '').trim();

  if (!id) return true;
  if (/^(total|subtotal|grandtotal|合计|总计)$/i.test(idKey)) return true;

  const hasRealTxId = /\d{6,}/.test(txId);
  const hasMoney = /^\$?\d[\d,]*(\.\d+)?$/.test(amount.replace(/\s+/g, ''));
  if (!hasRealTxId && !hasMoney) return true;

  return false;
}

function parseOrderRowsFromHtml(html) {
  const rowMatches = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const rows = [];

  for (const rowHtml of rowMatches) {
    const cells = (rowHtml.match(/<td[\s\S]*?<\/td>/gi) || [])
      .map(cell => decodeHtmlEntities(
        cell
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      ));

    if (cells.length < 9 || !cells[0]) continue;
    const hrefMatch = rowHtml.match(/href="([^"]*\/store\/report\/order\/[^"]+)"/i);
    const detailUrl = hrefMatch?.[1]
      ? new URL(hrefMatch[1], BASE).toString()
      : (cells[1] ? buildReceiptUrl(cells[1]) : '');

    const parsedRow = {
      id: cells[0] || '',
      txId: cells[1] || '',
      source: cells[2] || '',
      type: cells[3] || '',
      date: cells[4] || '',
      cashier: cells[5] || '-',
      customer: cells[6] || '-',
      tax: cells[7] || '$0',
      amount: cells[8] || '$0',
      discount: cells[9] || '$0',
      redeem: cells[10] || '$0',
      rounding: cells[11] || '$0',
      status: cells[12] || 'paid',
      detailUrl,
    };

    if (isSummaryOrderRow(parsedRow)) continue;
    rows.push(parsedRow);
  }

  return rows;
}

function hasNextOrdersPage(html, pageNum) {
  const linkMatches = String(html || '').match(/href="[^"]*page=\d+[^"]*"/gi) || [];
  const nextPage = pageNum + 1;
  return linkMatches.some(link => {
    const match = link.match(/page=(\d+)/i);
    return match && Number(match[1]) === nextPage;
  });
}

function getOrderLookupKeys(order) {
  return Array.from(new Set([
    order?.txId,
    order?.id,
    order?.receipt?.transactionId,
  ].filter(Boolean).map(value => String(value).trim()).filter(Boolean)));
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
  const ordersByKey = new Map();
  let pageNum = 1;
  let lastPageSignature = '';

  while (pageNum <= MAX_ORDER_PAGES) {
    const pageUrl = buildPagedReportUrl(url, pageNum);
    console.log(`[Scraper] ${scopeLabel} orders page ${pageNum}...`);
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await wait(1500);

    const { rows, nextPages } = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr')).map(row => {
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

      const nextPages = Array.from(document.querySelectorAll('a.page-link'))
        .map(link => {
          const href = link.getAttribute('href') || '';
          if (!href || href.startsWith('javascript')) return null;
          try {
            const parsed = new URL(href, location.origin);
            const targetPage = Number(parsed.searchParams.get('page'));
            return Number.isFinite(targetPage) ? targetPage : null;
          } catch {
            return null;
          }
        })
        .filter(Number.isFinite);

      return { rows, nextPages };
    });

    const dataRows = rows.filter(order => !isSummaryOrderRow(order));
    if (dataRows.length === 0) break;

    const pageSignature = dataRows.slice(0, 5).map(order => order.txId || order.id).join('|');
    if (pageNum > 1 && pageSignature && pageSignature === lastPageSignature) break;
    lastPageSignature = pageSignature;

    let addedThisPage = 0;
    for (const order of dataRows) {
      const key = order.txId || order.id;
      if (!key || ordersByKey.has(key)) continue;
      ordersByKey.set(key, order);
      addedThisPage++;
    }

    console.log(`[Scraper] ${scopeLabel} page ${pageNum}: ${dataRows.length} rows, +${addedThisPage} new (total: ${ordersByKey.size})`);

    const hasNextPage = nextPages.includes(pageNum + 1);
    if (!hasNextPage && dataRows.length < ORDER_PAGE_SIZE) break;
    if (addedThisPage === 0) break;

    pageNum++;
  }

  const orders = Array.from(ordersByKey.values());
  console.log(`[Scraper] ✅ ${scopeLabel} orders: ${orders.length}`);
  return orders;
}

async function collectOrdersListFromFetcher(fetchHtml, url, scopeLabel) {
  console.log(`[Scraper] Loading ${scopeLabel} orders list via URL+cookie...`);
  const ordersByKey = new Map();
  let pageNum = 1;
  let lastPageSignature = '';

  while (pageNum <= MAX_ORDER_PAGES) {
    const pageUrl = buildPagedReportUrl(url, pageNum);
    const html = await fetchHtml(pageUrl);
    const rows = parseOrderRowsFromHtml(html);
    if (rows.length === 0) break;

    const pageSignature = rows.slice(0, 5).map(order => order.txId || order.id).join('|');
    if (pageNum > 1 && pageSignature && pageSignature === lastPageSignature) break;
    lastPageSignature = pageSignature;

    let addedThisPage = 0;
    for (const order of rows) {
      const key = order.txId || order.id;
      if (!key || ordersByKey.has(key)) continue;
      ordersByKey.set(key, order);
      addedThisPage++;
    }

    console.log(`[Scraper] ${scopeLabel} page ${pageNum}: ${rows.length} rows, +${addedThisPage} new (total: ${ordersByKey.size})`);
    const hasNextPage = hasNextOrdersPage(html, pageNum);
    if (!hasNextPage && rows.length < ORDER_PAGE_SIZE) break;
    if (addedThisPage === 0) break;
    pageNum++;
  }

  const orders = Array.from(ordersByKey.values());
  console.log(`[Scraper] ✅ ${scopeLabel} orders: ${orders.length}`);
  return orders;
}

async function createSessionByLogin(options = {}) {
  const browser = await launchBrowser();

  try {
    const page = await createWorkerPage(browser);
    await loginToTapTouch(page);
    const sid = await ensureStoreContext(page, options.sid || null);
    const cookies = await page.cookies(BASE);
    await page.close();

    const cookieHeader = cookies
      .filter(cookie => cookie?.name && cookie?.value)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');

    return {
      sid: sid || null,
      cookies,
      cookieHeader,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

async function fetchHtmlWithCookie(session, url) {
  if (!session?.cookieHeader) {
    const error = new Error('TapTouch session cookie is missing');
    error.code = 'SESSION_MISSING';
    throw error;
  }

  const response = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-AU,en;q=0.9,zh-CN;q=0.8',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'cookie': session.cookieHeader,
      'referer': `${BASE}/store/dashboard`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    method: 'GET',
    redirect: 'follow',
  });

  const html = await response.text();
  const finalUrl = response.url || url;
  const hasLoginForm = /<input[^>]+name=["']account["'][^>]*>/i.test(html)
    && /<input[^>]+name=["']password["'][^>]*>/i.test(html);
  const looksLoggedOut = hasLoginForm
    || /\/auth(?:\/|["'])/i.test(finalUrl)
    || (/login/i.test(finalUrl) && !/\/store\//i.test(finalUrl));

  if (looksLoggedOut) {
    const error = new Error('TapTouch session expired');
    error.code = 'SESSION_EXPIRED';
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`TapTouch fetch failed (${response.status})`);
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    throw error;
  }

  return { html, finalUrl, status: response.status };
}

async function fetchCoreDataWithSession(session, options = {}) {
  const weekRange = getCurrentWeekRange();
  const dashboardRes = await fetchHtmlWithCookie(
    session,
    buildDashboardUrl({ sid: session.sid || options.sid || null })
  );
  const sid = extractSidFromUrl(dashboardRes.finalUrl) || session.sid || options.sid || null;

  const weeklyDashRes = await fetchHtmlWithCookie(session, buildDashboardUrl({
    sid,
    label: 'This Week',
    start: weekRange.start,
    end: weekRange.end,
  }));

  const productReportUrl = buildProductReportUrl({
    sid,
    label: 'Today',
    start: new Date(new Date().setHours(0, 0, 0, 0)),
    end: new Date(new Date().setHours(23, 59, 59, 999)),
  });

  const [todayOrders, weeklyOrders, productReportRes] = await Promise.all([
    collectOrdersListFromFetcher(
      async url => (await fetchHtmlWithCookie(session, url)).html,
      buildOrdersReportUrl({}),
      'today'
    ),
    collectOrdersListFromFetcher(
      async url => (await fetchHtmlWithCookie(session, url)).html,
      buildOrdersReportUrl({
        label: 'This Week',
        start: weekRange.start,
        end: weekRange.end,
      }),
      'weekly'
    ),
    fetchHtmlWithCookie(session, productReportUrl),
  ]);

  const products = parseProductsFromHtml(productReportRes.html);

  return {
    capturedAt: new Date().toISOString(),
    sid,
    dashData: {
      sid,
      bodyText: htmlToText(dashboardRes.html).substring(0, 5000),
      cards: [extractChartBlockFromHtml(dashboardRes.html)],
    },
    weeklyDashData: {
      sid,
      bodyText: htmlToText(weeklyDashRes.html).substring(0, 5000),
      cards: [extractChartBlockFromHtml(weeklyDashRes.html)],
    },
    allOrders: todayOrders,
    weeklyOrders,
    products,
  };
}

async function fetchProductsForRangeWithSession(session, options = {}) {
  const sid = session?.sid || options.sid || null;
  const response = await fetchHtmlWithCookie(session, buildProductReportUrl({
    sid,
    label: options.label || null,
    start: options.start || null,
    end: options.end || null,
  }));

  return {
    fetchedAt: new Date().toISOString(),
    sid,
    products: parseProductsFromHtml(response.html),
  };
}

async function fetchOrdersForDateWithSession(session, dateKey, options = {}) {
  const { start, end } = buildDayRange(dateKey);
  const sid = session?.sid || options.sid || null;
  const orders = await collectOrdersListFromFetcher(
    async url => (await fetchHtmlWithCookie(session, url)).html,
    buildOrdersReportUrl({ start, end }),
    dateKey
  );

  return {
    date: dateKey,
    sid,
    fetchedAt: new Date().toISOString(),
    orders,
  };
}

async function fetchSingleOrderDetailWithSession(session, order, options = {}) {
  const sid = session?.sid || options.sid || null;
  const candidateUrls = Array.from(new Set([
    order?.detailUrl,
    order?.txId ? buildReceiptUrl(order.txId) : null,
  ].filter(Boolean)));

  if (!candidateUrls.length) {
    return null;
  }

  for (const detailUrl of candidateUrls) {
    const response = await fetchHtmlWithCookie(session, detailUrl);
    const bodyText = htmlToText(response.html);
    if (!/Transaction Receipt|Receipt|Total Paid|Sub-Total/i.test(bodyText)) {
      continue;
    }

    return parseReceiptDetail(bodyText, order, detailUrl);
  }

  return null;
}

async function fetchProductsForRange(options = {}) {
  const browser = await launchBrowser();

  try {
    const page = await createWorkerPage(browser);
    await loginToTapTouch(page);
    const sid = await ensureStoreContext(page, options.sid || null);

    const productUrl = buildProductReportUrl({
      sid,
      label: options.label || null,
      start: options.start || null,
      end: options.end || null,
    });

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await wait(1200);

    const html = await page.content();
    await page.close();

    return {
      fetchedAt: new Date().toISOString(),
      sid,
      products: parseProductsFromHtml(html),
    };
  } finally {
    await browser.close();
  }
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
  products,
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
    products: products || [],
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
  if (!hasConfiguredTapTouchCredentials()) {
    throw new Error('Missing TapTouch credentials. Set real TAPTOUCH_EMAIL and TAPTOUCH_PASSWORD values in .env.local or your shell environment.');
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
  const lookupKeys = getOrderLookupKeys(order);
  if (!lookupKeys.length) return null;

  let receiptHref = '';
  let rowFound = false;
  const maxFallbackPages = Math.min(MAX_ORDER_PAGES, 4);

  for (let pageNum = 1; pageNum <= maxFallbackPages && !rowFound; pageNum++) {
    await page.goto(buildPagedReportUrl(`${BASE}/store/report/orders`, pageNum), {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await wait(1200);

    const rowHandle = await page.evaluateHandle((keys) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      for (const row of rows) {
        const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim();
        if (!keys.some(key => rowText.includes(key))) continue;
        return row.querySelector('a[href*="/store/report/order/"]') || null;
      }
      return null;
    }, lookupKeys);

    const rowLink = rowHandle.asElement();
    if (!rowLink) {
      await rowHandle.dispose();
      continue;
    }

    rowFound = true;
    receiptHref = await rowLink.getProperty('href').then(handle => handle.jsonValue()).catch(() => '');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      rowLink.click(),
    ]);
    await rowHandle.dispose();
    return readReceiptDetail(page, order, receiptHref);
  }

  if (!rowFound) {
    console.log(`[Scraper] Receipt link not found in paged orders list for ${lookupKeys[0]}`);
    return null;
  }
  return null;
}

async function primeRecentOrderDetails(browser, orders, seededOrderDetails, options = {}) {
  const sid = options.sid || null;
  const count = Math.max(0, options.count || DETAIL_PRIME_COUNT);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const targets = orders
    .filter(order => !seededOrderDetails[order.txId || order.id])
    .slice(0, count);

  if (!targets.length) return 0;

  console.log(`[Scraper] Warming up ${targets.length} recent order receipts...`);
  const page = await createWorkerPage(browser);
  let primed = 0;

  try {
    await ensureStoreContext(page, sid);

    for (const order of targets) {
      let detail = null;

      try {
        detail = await fetchOrderDetail(page, order);
        if (!detail) {
          console.log(`[Scraper] Warm-up fallback via paged orders list for ${order.txId || order.id}...`);
          detail = await fetchOrderDetailFromOrdersList(page, order);
        }
      } catch (error) {
        console.log(`[Scraper] Warm-up failed for ${order.txId || order.id}: ${error.message}`);
      }

      if (detail) {
        seededOrderDetails[order.txId || order.id] = detail;
        primed++;
      }

      if (onProgress) onProgress({ order, detail, primed, total: targets.length });
    }
  } finally {
    await page.close();
  }

  return primed;
}

async function fetchSingleOrderDetail(order, options = {}) {
  const browser = await launchBrowser();

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

async function fetchOrdersForDate(dateKey, options = {}) {
  const browser = await launchBrowser();

  try {
    const page = await createWorkerPage(browser);
    await loginToTapTouch(page);
    const sid = await ensureStoreContext(page, options.sid);
    const { start, end } = buildDayRange(dateKey);
    const orders = await collectOrdersList(
      page,
      buildOrdersReportUrl({ start, end }),
      dateKey
    );
    await page.close();

    return {
      date: dateKey,
      sid,
      fetchedAt: new Date().toISOString(),
      orders,
    };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────
async function scrapeTapTouch() {
  console.log('[Scraper] Launching browser...');
  const browser = await launchBrowser();
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

    // ══ 5. Product Report: popular dishes ════════════════════
    let products = [];
    try {
      console.log('[Scraper] Loading product report...');
      const productUrl = buildProductReportUrl({
        sid: dashboardSid,
        label: 'Today',
        start: new Date(new Date().setHours(0, 0, 0, 0)),
        end: new Date(new Date().setHours(23, 59, 59, 999)),
      });
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await wait(3000);
      const productHTML = await page.content();
      products = parseProductsFromHtml(productHTML);
      console.log('[Scraper] Scraped products count:', products.length);
    } catch (err) {
      console.log('[Scraper] Products report scraping failed:', err.message);
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
        products,
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
      saveSnapshot(
        'core_ready',
        DETAIL_PRIME_COUNT > 0
          ? `⚡ 核心数据已更新，正在预热最近订单收据（已缓存 ${detailReadyCount}/${totalDetails}）`
          : `⚡ 核心数据已更新，订单详情按需加载（已缓存 ${detailReadyCount}/${totalDetails}）`
      );

      if (DETAIL_PRIME_COUNT > 0) {
        await primeRecentOrderDetails(browser, allOrders, seededOrderDetails, {
          sid: dashboardSid,
          count: DETAIL_PRIME_COUNT,
          onProgress: ({ primed, total }) => {
            detailReadyCount = Object.keys(seededOrderDetails).length;
            saveSnapshot(
              'details',
              `⚡ 核心数据已更新，最近订单收据预热中（${primed}/${total}，已缓存 ${detailReadyCount}/${totalDetails}）`
            );
          },
        });
        detailReadyCount = Object.keys(seededOrderDetails).length;
      }

      const finalResult = saveSnapshot(
        'complete',
        `⚡ 核心数据已更新，最近订单详情已就绪（已缓存 ${detailReadyCount}/${totalDetails}）`
      );
      const sizeMB = (fs.statSync(SCRAPE_RESULT_PATH).size / 1024 / 1024).toFixed(2);
      console.log(`\n[Scraper] ✅ Done! scrape-result.json (${sizeMB} MB)`);
      console.log(`  Orders:          ${allOrders.length}`);
      console.log(`  Order details:   on-demand + warm (${detailReadyCount}/${totalDetails} cached)`);
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
  createSessionByLogin,
  fetchCoreDataWithSession,
  fetchProductsForRangeWithSession,
  fetchOrdersForDateWithSession,
  fetchSingleOrderDetailWithSession,
  fetchProductsForRange,
  fetchOrdersForDate,
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

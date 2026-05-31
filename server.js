/**
 * RESTAURANT DASHBOARD — SERVER.JS
 * Serves real TapTouch data scraped from backoffice.taptouch.net
 * Run: node server.js
 */
'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { spawn } = require('child_process');
const {
  createSessionByLogin,
  fetchCoreDataWithSession,
  fetchOrdersForDateWithSession,
  fetchSingleOrderDetailWithSession,
  fetchOrdersForDate,
  fetchSingleOrderDetail,
  parseReceiptDetail,
} = require('./scraper');

const app  = express();
const PORT = 3001;
const COOKIE_REFRESH_MS = 30 * 60 * 1000;
const AUTO_FETCH_MS = 5 * 60 * 1000;
const DETAIL_PREFETCH_WORKERS = Math.max(1, Number(process.env.DETAIL_PREFETCH_WORKERS || 2));

app.use(cors());
app.use(express.json());

// Disable caching for development
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname)));

// ============================================================
// PARSE REAL TAPTOUCH DATA FROM scrape-result.json
// ============================================================
const WEEKDAY_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round2(value) {
  return Number((value || 0).toFixed(2));
}

function parseMoneyValue(value) {
  return parseFloat(String(value || '').replace(/[^0-9.-]/g, '')) || 0;
}

function parseLocalDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function formatDateKey(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfWeekMonday(date) {
  const start = new Date(date);
  const day = start.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatRangeLabel(start, end) {
  const startMonth = MONTH_SHORT[start.getMonth()];
  const endMonth = MONTH_SHORT[end.getMonth()];
  if (startMonth === endMonth) {
    return `${startMonth} ${start.getDate()} - ${end.getDate()}`;
  }
  return `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}`;
}

function getTodayDateKey(referenceDate = new Date()) {
  return formatDateKey(referenceDate);
}

function isSummaryLikeOrder(order) {
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

function mapRawOrdersToApiOrders(orders = [], orderDetails = {}) {
  const mappedOrders = [];

  for (const order of orders) {
    if (!order) continue;
    if (isSummaryLikeOrder(order)) continue;
    const detailKey = order.txId || order.id;
    mappedOrders.push({
      id:           order.id       || '',
      txId:         order.txId     || '',
      source:       order.source   || '',
      type:         order.type     || '',
      date:         (order.date    || '').replace(/^\d{4}-\d{2}-\d{2} /, ''),
      dateTime:     order.date     || '',
      cashier:      order.cashier  || '-',
      customer:     order.customer || '-',
      tax:          order.tax      || '$0',
      amount:       order.amount   || '$0',
      status:       (order.status  || 'paid').toLowerCase(),
      detailUrl:    order.detailUrl || '',
      detailCached: !!(detailKey && orderDetails?.[detailKey]),
    });
  }

  return mappedOrders;
}

function buildOrdersDataset(orders = [], meta = {}) {
  const mappedOrders = mapRawOrdersToApiOrders(orders, cache.raw?.orderDetails || {});
  const derivedDateKey = mappedOrders[0]?.dateTime?.slice(0, 10) || meta.dateKey || getTodayDateKey();
  const totalRevenue = round2(mappedOrders.reduce((sum, order) => sum + parseMoneyValue(order.amount), 0));
  const totalOrders = mappedOrders.length;

  return {
    dateKey: derivedDateKey,
    label: meta.label || (derivedDateKey === getTodayDateKey() ? '今天' : derivedDateKey),
    isToday: derivedDateKey === getTodayDateKey(),
    source: meta.source || 'live',
    fetchedAt: meta.fetchedAt || null,
    totalOrders,
    totalRevenue,
    avgTicket: totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0,
    cachedDetails: mappedOrders.filter(order => order.detailCached).length,
    orders: mappedOrders,
  };
}

function extractOfflineChart(card = '') {
  const labelsMatch = card.match(/"labels":\[([^\]]+)\]/);
  const salesMatch  = card.match(/"label":"Offline Sales".*?"data":\[([^\]]+)\]/);
  const ordMatch    = card.match(/"label":"Offline Orders".*?"data":\[([^\]]+)\]/);

  if (!labelsMatch || !salesMatch) {
    return { labels: [], revenues: [], orders: [] };
  }

  return {
    labels:   labelsMatch[1].replace(/"/g, '').split(',').map(s => s.trim()),
    revenues: salesMatch[1].split(',').map(Number),
    orders:   ordMatch ? ordMatch[1].split(',').map(Number) : [],
  };
}

function buildWeeklyOverview(raw) {
  const weeklyDashCard = (raw.weeklyDashData?.cards || [])[0] || '';
  const weeklyChart = extractOfflineChart(weeklyDashCard);
  const weeklyOrdersSource =
    Array.isArray(raw.weeklyOrders) && raw.weeklyOrders.length > 0
      ? raw.weeklyOrders
      : Array.isArray(raw.allOrders)
        ? raw.allOrders
        : [];

  const orderStatsByDay = new Map();
  let latestOrderDate = null;

  for (const order of weeklyOrdersSource) {
    const dateObj = parseLocalDateTime(order.date);
    if (!dateObj) continue;

    if (!latestOrderDate || dateObj > latestOrderDate) latestOrderDate = dateObj;

    const key = formatDateKey(dateObj);
    const existing = orderStatsByDay.get(key) || { revenue: 0, orders: 0 };
    existing.revenue += parseMoneyValue(order.amount);
    existing.orders += 1;
    orderStatsByDay.set(key, existing);
  }

  const referenceDate = latestOrderDate || parseLocalDateTime(raw.timestamp) || new Date();
  const weekStart = startOfWeekMonday(referenceDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const daily = WEEKDAY_MON.map((weekday, index) => {
    const dateObj = new Date(weekStart);
    dateObj.setDate(weekStart.getDate() + index);

    const key = formatDateKey(dateObj);
    const orderStats = orderStatsByDay.get(key) || { revenue: 0, orders: 0 };
    const chartRevenue = Number.isFinite(weeklyChart.revenues[index]) ? weeklyChart.revenues[index] : null;
    const chartOrders = Number.isFinite(weeklyChart.orders[index]) ? weeklyChart.orders[index] : null;
    const revenue = chartRevenue ?? orderStats.revenue;
    const orders = chartOrders ?? orderStats.orders;
    const avgTicket = orderStats.orders > 0
      ? orderStats.revenue / orderStats.orders
      : orders > 0
        ? revenue / orders
        : 0;

    return {
      label:      weekday,
      chartLabel: weeklyChart.labels[index] || weekday,
      weekday,
      fullLabel:  `${weekday} ${dateObj.getDate()} ${MONTH_SHORT[dateObj.getMonth()]}`,
      dateKey:    key,
      revenue:    round2(revenue),
      orders:     orders || 0,
      avgTicket:  round2(avgTicket),
      hasData:    revenue > 0 || orders > 0,
      isToday:    key === formatDateKey(referenceDate),
    };
  });

  const totalRevenue = round2(daily.reduce((sum, day) => sum + day.revenue, 0));
  const totalOrders = daily.reduce((sum, day) => sum + day.orders, 0);
  const avgTicket = totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0;
  const activeDays = daily.filter(day => day.hasData).length;
  const bestDay = daily
    .filter(day => day.hasData)
    .reduce((best, day) => !best || day.revenue > best.revenue ? day : best, null);

  return {
    dateRangeLabel: formatRangeLabel(weekStart, weekEnd),
    totalRevenue,
    totalOrders,
    avgTicket,
    activeDays,
    bestDay: bestDay ? {
      label:     bestDay.weekday,
      fullLabel: bestDay.fullLabel,
      revenue:   bestDay.revenue,
      orders:    bestDay.orders,
      avgTicket: bestDay.avgTicket,
    } : null,
    daily,
  };
}

function parseTapTouchData(raw) {
  const dash = raw.dashData || {};
  const body = dash.bodyText || '';
  const card = (dash.cards || [])[0] || '';

  // ── KPI figures from body text ───────────────────────────────
  const totalRevenue = parseFloat((body.match(/Offline Sales\s*\$([\d.]+)/) || [])[1]) || 0;
  const totalOrders  = parseInt((body.match(/Offline Orders\s*(\d+)/)      || [])[1]) || 0;
  const avgTicket    = parseFloat((body.match(/Offline Average\s*\$([\d.]+)/) || [])[1]) || 0;

  // ── Hourly data from embedded Chart.js JSON ──────────────────
  const chart = extractOfflineChart(card);
  let hourlySales = [];
  if (chart.labels.length && chart.revenues.length) {
    const labels = chart.labels;
    const revenues = chart.revenues;
    const orders = chart.orders;

    // Find last hour with data
    const lastIdx = revenues.reduce((last, v, i) => v > 0 ? i : last, -1);

    hourlySales = labels.map((label, i) => ({
      hour:      label.trim(),
      revenue:   revenues[i] || 0,
      orders:    orders[i]   || 0,
      isCurrent: i === lastIdx,
      isFuture:  i > lastIdx,
    }));
  }

  // ── Payment breakdown ────────────────────────────────────────
  const PAY_COLORS = {
    'Card':           '#10b981',
    'Cash':           '#f59e0b',
    'Charge Account': '#8b5cf6',
    'Third Party':    '#06b6d4',
    'Other Pay':      '#3b82f6',
    'Deposit':        '#f43f5e',
  };
  const payments = [];
  const payPatterns = [
    ['Cash',           /Cash\s*\$([\d.]+)/],
    ['Card',           /Card\s*\$([\d.]+)/],
    ['Charge Account', /Charge Account\s*\$([\d.]+)/],
    ['Third Party',    /Third Party\s*\$([\d.]+)/],
    ['Other Pay',      /Other Pay\s*\$([\d.]+)/],
    ['Deposit',        /Deposit\s*\$([\d.]+)/],
  ];
  const payTotal = totalRevenue || 1;
  for (const [label, rx] of payPatterns) {
    const val = parseFloat((body.match(rx) || [])[1]) || 0;
    if (val > 0) payments.push({
      label,
      value: val,
      pct:   Math.round(val / payTotal * 100),
      color: PAY_COLORS[label] || '#8899bb',
    });
  }

  // ── All orders from /store/report/orders (all pages) ────────
  let recentOrders = [];

  if (Array.isArray(raw.allOrders) && raw.allOrders.length > 0) {
    recentOrders = mapRawOrdersToApiOrders(raw.allOrders, raw.orderDetails);
  } else {
    const ordersPage = (raw.scrapedPages || {})['/store/report'];
    if (ordersPage?.tables?.[0]?.firstRows) {
      recentOrders = mapRawOrdersToApiOrders(
        ordersPage.tables[0].firstRows.map(row => ({
          id: row[0] || '',
          txId: row[1] || '',
          source: row[2] || '',
          type: row[3] || '',
          date: row[4] || '',
          cashier: row[5] || '-',
          customer: row[6] || '-',
          tax: row[7] || '$0',
          amount: row[8] || '$0',
          status: row[12] || 'paid',
        })),
        raw.orderDetails
      );
    }
  }

  const ordersDateKey = recentOrders[0]?.dateTime?.slice(0, 10)
    || formatDateKey(parseLocalDateTime(raw.timestamp) || new Date());

  return {
    storeName:    'PROSPERITY XH',
    brandName:    '食集-重庆小面',
    totalRevenue,
    totalOrders,
    avgTicket,
    hourlySales,
    payments,
    recentOrders,
    ordersDateKey,
    weeklyOverview: buildWeeklyOverview(raw),
    syncState: raw.syncState || null,
    orderDetails: raw.orderDetails || {},
    salesReport:  raw.salesReport  || {},
    scrapedAt:    raw.timestamp,
    products:     raw.products     || [],
  };
}

// ============================================================
// CACHE
// ============================================================
let cache = { data: null, raw: null, lastUpdated: null, syncState: null };
const inflightDetailFetches = new Map();
const inflightDateFetches = new Map();
const detailPrefetchQueue = [];
const detailPrefetchQueuedSet = new Set();
let detailPrefetchActive = 0;
let tapTouchSession = null;
let cookieRefreshPromise = null;
const autoSyncState = {
  cookieLastRefreshedAt: null,
  dataLastFetchedAt: null,
  running: false,
  cookieRefreshing: false,
  lastError: null,
};

function findOrderInRaw(raw, key) {
  const datedPools = Object.values(raw?.ordersByDate || {})
    .map(entry => entry?.orders)
    .filter(Array.isArray);
  const pools = [raw?.allOrders, raw?.weeklyOrders, ...datedPools];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const found = pool.find(order => order.txId === key || order.id === key);
    if (found) return found;
  }
  return null;
}

function normalizeCachedOrderDetails(raw) {
  if (!raw || !raw.orderDetails || typeof raw.orderDetails !== 'object') return;

  for (const [key, detail] of Object.entries(raw.orderDetails)) {
    const bodyText = detail?.bodyText || '';
    if (!/Transaction Receipt|Total Paid|Sub-Total/i.test(bodyText)) continue;

    const order = findOrderInRaw(raw, key) || {
      id: detail.orderId || '',
      txId: detail.txId || key,
      date: detail.receipt?.orderTime || '',
      type: detail.receipt?.fulfillment || '',
    };

    raw.orderDetails[key] = {
      ...detail,
      ...parseReceiptDetail(bodyText, order, detail.url || order.detailUrl || ''),
    };
  }
}

function loadData() {
  try {
    const filePath = path.join(__dirname, 'scrape-result.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    normalizeCachedOrderDetails(raw);
    cache.raw  = raw;
    cache.data = parseTapTouchData(raw);
    cache.syncState = raw.syncState || null;
    cache.lastUpdated = new Date().toISOString();
    const d = cache.data;
    console.log(`[Server] ✅ Loaded: $${d.totalRevenue} / ${d.totalOrders} orders / ${d.hourlySales.filter(h=>h.revenue>0).length} active hours`);
    return true;
  } catch (e) {
    console.error('[Server] ❌ Failed to load scrape-result.json:', e.message);
    return false;
  }
}

function findRawOrderByKey(key) {
  return findOrderInRaw(cache.raw, key);
}

function persistOrderDetail(key, detail) {
  if (!cache.raw) cache.raw = {};
  if (!cache.raw.orderDetails) cache.raw.orderDetails = {};
  cache.raw.orderDetails[key] = detail;

  const filePath = path.join(__dirname, 'scrape-result.json');
  fs.writeFileSync(filePath, JSON.stringify(cache.raw, null, 2));
  loadData();
}

function persistOrdersForDate(dateKey, entry) {
  if (!cache.raw) cache.raw = {};
  if (!cache.raw.ordersByDate) cache.raw.ordersByDate = {};
  cache.raw.ordersByDate[dateKey] = entry;

  const filePath = path.join(__dirname, 'scrape-result.json');
  fs.writeFileSync(filePath, JSON.stringify(cache.raw, null, 2));
  loadData();
}

function persistCoreSnapshotFromCookie(coreData, sourceLabel = 'URL+cookie 同步完成') {
  if (!coreData) return;
  if (!cache.raw) cache.raw = {};

  const existingDetails = cache.raw.orderDetails || {};
  const orders = Array.isArray(coreData.allOrders) ? coreData.allOrders : [];
  const detailReady = orders.reduce((count, order) => {
    const key = order?.txId || order?.id;
    return key && existingDetails[key] ? count + 1 : count;
  }, 0);
  const detailTotal = orders.length;

  cache.raw.timestamp = coreData.capturedAt || new Date().toISOString();
  cache.raw.dashData = coreData.dashData || cache.raw.dashData || {};
  cache.raw.weeklyDashData = coreData.weeklyDashData || cache.raw.weeklyDashData || {};
  cache.raw.allOrders = orders;
  cache.raw.weeklyOrders = Array.isArray(coreData.weeklyOrders) ? coreData.weeklyOrders : cache.raw.weeklyOrders || [];
  cache.raw.orderDetails = existingDetails;
  cache.raw.salesReport = cache.raw.salesReport || {};
  cache.raw.ordersByDate = cache.raw.ordersByDate || {};
  cache.raw.syncState = {
    phase: 'complete',
    message: `⚡ ${sourceLabel}`,
    coreReady: true,
    detailReady,
    detailTotal,
    detailFetchedThisRun: 0,
    detailMissing: Math.max(detailTotal - detailReady, 0),
    detailPercent: detailTotal > 0 ? Math.round((detailReady / detailTotal) * 100) : 100,
    updatedAt: cache.raw.timestamp,
  };

  const filePath = path.join(__dirname, 'scrape-result.json');
  fs.writeFileSync(filePath, JSON.stringify(cache.raw, null, 2));
  loadData();
  applyCacheSyncStateToScrapeStatus();
}

function getWeeklyOrdersForDate(dateKey) {
  const targetDate = parseLocalDateTime(`${dateKey} 00:00:00`);
  if (!targetDate || !Array.isArray(cache.raw?.weeklyOrders)) return null;

  const referenceDate = parseLocalDateTime(cache.raw?.timestamp) || new Date();
  const weekStart = startOfWeekMonday(referenceDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  if (targetDate < weekStart || targetDate > weekEnd) return null;
  return cache.raw.weeklyOrders.filter(order => String(order.date || '').startsWith(dateKey));
}

async function refreshTapTouchSession(force = false) {
  if (cookieRefreshPromise) return cookieRefreshPromise;

  const sessionAge = tapTouchSession?.createdAt
    ? Date.now() - new Date(tapTouchSession.createdAt).getTime()
    : Infinity;
  if (!force && tapTouchSession?.cookieHeader && sessionAge < COOKIE_REFRESH_MS) {
    return tapTouchSession;
  }

  autoSyncState.cookieRefreshing = true;
  cookieRefreshPromise = (async () => {
    try {
      const session = await createSessionByLogin({
        sid: tapTouchSession?.sid || cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
      });
      tapTouchSession = session;
      autoSyncState.cookieLastRefreshedAt = new Date().toISOString();
      autoSyncState.lastError = null;
      return session;
    } finally {
      autoSyncState.cookieRefreshing = false;
      cookieRefreshPromise = null;
    }
  })();

  return cookieRefreshPromise;
}

async function fetchOrdersForDateLive(dateKey) {
  const sid = tapTouchSession?.sid || cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null;
  let fetched = null;

  if (tapTouchSession?.cookieHeader) {
    try {
      fetched = await fetchOrdersForDateWithSession(tapTouchSession, dateKey, { sid });
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_MISSING') {
        await refreshTapTouchSession(true);
        fetched = await fetchOrdersForDateWithSession(tapTouchSession, dateKey, { sid: tapTouchSession?.sid || sid });
      } else {
        throw error;
      }
    }
  } else {
    await refreshTapTouchSession(true);
    fetched = await fetchOrdersForDateWithSession(tapTouchSession, dateKey, { sid: tapTouchSession?.sid || sid });
  }

  return fetched;
}

async function runAutoCookieSync(trigger = 'interval') {
  if (autoSyncState.running || scrapeStatus.running) return false;
  autoSyncState.running = true;

  try {
    await syncCoreDataWithCookie({
      trigger,
      ensureSession: true,
      allowRelogin: true,
    });
    return true;
  } catch (error) {
    autoSyncState.lastError = error.message || 'Auto sync failed';
    console.error('[Server] Auto cookie sync failed:', error.message);
    return false;
  } finally {
    autoSyncState.running = false;
  }
}

async function syncCoreDataWithCookie(options = {}) {
  const trigger = options.trigger || 'manual';
  const ensureSession = !!options.ensureSession;
  const allowRelogin = !!options.allowRelogin;

  if (ensureSession) {
    await refreshTapTouchSession(false);
  }
  if (!tapTouchSession?.cookieHeader) {
    const error = new Error('当前没有可用 cookie，请使用「从 TapTouch 同步」重新登录');
    error.code = 'SESSION_MISSING';
    throw error;
  }

  let coreData = null;
  try {
    coreData = await fetchCoreDataWithSession(tapTouchSession, { sid: tapTouchSession.sid });
  } catch (error) {
    const canRelogin = allowRelogin && (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_MISSING');
    if (!canRelogin) throw error;
    await refreshTapTouchSession(true);
    coreData = await fetchCoreDataWithSession(tapTouchSession, { sid: tapTouchSession?.sid || null });
  }

  tapTouchSession.sid = coreData.sid || tapTouchSession.sid || null;
  persistCoreSnapshotFromCookie(coreData, `URL+cookie ${trigger}刷新`);
  autoSyncState.dataLastFetchedAt = new Date().toISOString();
  autoSyncState.lastError = null;
  return true;
}

async function runCookieRefreshNow() {
  if (autoSyncState.running || scrapeStatus.running) {
    const error = new Error('同步任务正在运行，请稍后再试');
    error.code = 'SYNC_BUSY';
    throw error;
  }

  autoSyncState.running = true;
  try {
    return await syncCoreDataWithCookie({
      trigger: '手动',
      ensureSession: false,
      allowRelogin: false,
    });
  } finally {
    autoSyncState.running = false;
  }
}

async function getOrdersForDatePayload(dateKey) {
  const todayKey = cache.data?.ordersDateKey || getTodayDateKey();
  if (cache.data && dateKey === todayKey) {
    return buildOrdersDataset(cache.raw?.allOrders || [], {
      dateKey,
      source: 'today_live',
      fetchedAt: cache.data.scrapedAt || cache.lastUpdated,
    });
  }

  const cachedDateEntry = cache.raw?.ordersByDate?.[dateKey];
  if (Array.isArray(cachedDateEntry?.orders)) {
    return buildOrdersDataset(cachedDateEntry.orders, {
      dateKey,
      source: 'date_cache',
      fetchedAt: cachedDateEntry.fetchedAt || cache.lastUpdated,
    });
  }

  const weeklyOrders = getWeeklyOrdersForDate(dateKey);
  if (Array.isArray(weeklyOrders)) {
    return buildOrdersDataset(weeklyOrders, {
      dateKey,
      source: 'weekly_cache',
      fetchedAt: cache.raw?.timestamp || cache.lastUpdated,
    });
  }

  if (inflightDateFetches.has(dateKey)) {
    return inflightDateFetches.get(dateKey);
  }

  const promise = (async () => {
    let fetched = null;
    try {
      fetched = await fetchOrdersForDateLive(dateKey);
    } catch (error) {
      fetched = await fetchOrdersForDate(dateKey, {
        sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
      });
    }

    persistOrdersForDate(dateKey, {
      orders: fetched.orders,
      fetchedAt: fetched.fetchedAt,
      sid: fetched.sid || null,
    });

    return buildOrdersDataset(fetched.orders, {
      dateKey,
      source: 'live_fetch',
      fetchedAt: fetched.fetchedAt,
    });
  })();

  inflightDateFetches.set(dateKey, promise);
  try {
    return await promise;
  } finally {
    inflightDateFetches.delete(dateKey);
  }
}

function resolveOrderKey(rawOrder, fallbackKey = '') {
  return rawOrder?.txId || rawOrder?.id || fallbackKey;
}

function normalizePrefetchKeys(keys = []) {
  const normalized = [];
  for (const key of keys) {
    const trimmed = String(key || '').trim();
    if (!trimmed) continue;
    if (cache.data?.orderDetails?.[trimmed]) continue;
    if (inflightDetailFetches.has(trimmed)) continue;
    if (detailPrefetchQueuedSet.has(trimmed)) continue;
    normalized.push(trimmed);
  }
  return normalized;
}

function enqueueDetailPrefetch(keys = [], options = {}) {
  const normalized = normalizePrefetchKeys(keys);
  if (!normalized.length) return 0;

  if (options.highPriority) {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      const key = normalized[i];
      detailPrefetchQueue.unshift(key);
      detailPrefetchQueuedSet.add(key);
    }
  } else {
    for (const key of normalized) {
      detailPrefetchQueue.push(key);
      detailPrefetchQueuedSet.add(key);
    }
  }

  scheduleDetailPrefetchWorkers();
  return normalized.length;
}

function scheduleDetailPrefetchWorkers() {
  while (detailPrefetchActive < DETAIL_PREFETCH_WORKERS && detailPrefetchQueue.length > 0) {
    const key = detailPrefetchQueue.shift();
    detailPrefetchQueuedSet.delete(key);
    detailPrefetchActive += 1;

    getOrFetchOrderDetail(key, { background: true })
      .catch(() => null)
      .finally(() => {
        detailPrefetchActive = Math.max(0, detailPrefetchActive - 1);
        scheduleDetailPrefetchWorkers();
      });
  }
}

async function getOrFetchOrderDetail(key, options = {}) {
  const cached = cache.data?.orderDetails?.[key];
  if (cached) return cached;

  const rawOrder = findRawOrderByKey(key);
  const canonicalKey = rawOrder?.txId || rawOrder?.id || key;
  const canonicalCached = cache.data?.orderDetails?.[canonicalKey];
  if (canonicalCached) return canonicalCached;

  if (inflightDetailFetches.has(key)) {
    return inflightDetailFetches.get(key);
  }

  const promise = (async () => {
    const order = rawOrder;
    if (!order) {
      const error = new Error('Order not found');
      error.code = 404;
      throw error;
    }

    const sid = cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null;
    let detail = null;

    if (tapTouchSession?.cookieHeader) {
      try {
        detail = await fetchSingleOrderDetailWithSession(tapTouchSession, order, { sid });
      } catch (error) {
        const shouldRelogin = error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_MISSING';
        if (shouldRelogin) {
          await refreshTapTouchSession(true);
          detail = await fetchSingleOrderDetailWithSession(tapTouchSession, order, {
            sid: tapTouchSession?.sid || sid,
          });
        } else if (!options.background) {
          console.error('[Server] Cookie receipt fetch failed, fallback to browser:', error.message);
        }
      }
    }

    if (!detail) {
      detail = await fetchSingleOrderDetail(order, { sid });
    }

    if (!detail) {
      const error = new Error('Detail fetch failed');
      error.code = 502;
      throw error;
    }

    persistOrderDetail(canonicalKey, detail);
    return cache.data?.orderDetails?.[canonicalKey] || detail;
  })();

  inflightDetailFetches.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightDetailFetches.delete(key);
  }
}

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/status', (req, res) => res.json({
  ok:          true,
  dataSource:  cache.data ? 'taptouch_live' : 'no_data',
  storeName:   cache.data?.storeName || 'Unknown',
  lastUpdated: cache.lastUpdated,
  scrapedAt:   cache.data?.scrapedAt || null,
  autoSync: {
    cookieLastRefreshedAt: autoSyncState.cookieLastRefreshedAt,
    dataLastFetchedAt: autoSyncState.dataLastFetchedAt,
    running: autoSyncState.running,
    cookieRefreshing: autoSyncState.cookieRefreshing,
    lastError: autoSyncState.lastError,
  },
  detailPrefetch: {
    queueSize: detailPrefetchQueue.length,
    activeWorkers: detailPrefetchActive,
  },
}));

app.get('/api/sales/hourly', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data — click 从TapTouch同步' });
  res.json(cache.data.hourlySales);
});

app.get('/api/sales/summary', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });
  const d = cache.data;
  res.json({
    storeName:    d.storeName,
    brandName:    d.brandName,
    ordersDateKey: d.ordersDateKey,
    totalRevenue: d.totalRevenue,
    totalOrders:  d.totalOrders,
    avgTicket:    d.avgTicket,
    payments:     d.payments,
    weeklyOverview: d.weeklyOverview,
    lastUpdated:  cache.lastUpdated,
    scrapedAt:    d.scrapedAt,
    products:     d.products,
  });
});

app.get('/api/orders/recent', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });
  res.json(cache.data.recentOrders);
});

app.get('/api/orders/by-date', async (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });

  const dateKey = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
  }

  try {
    const payload = await getOrdersForDatePayload(dateKey);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load orders for date', dateKey });
  }
});

app.post('/api/orders/prefetch', (req, res) => {
  if (!cache.data) return res.status(503).json({ ok: false, error: 'No data' });

  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  const queued = enqueueDetailPrefetch(keys, { highPriority: false });
  res.json({
    ok: true,
    queued,
    queueSize: detailPrefetchQueue.length,
    activeWorkers: detailPrefetchActive,
  });
});

// Single order detail (items breakdown)
app.get('/api/orders/detail/:key', async (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });
  const key = req.params.key;

  try {
    const detail = await getOrFetchOrderDetail(key);
    res.json(detail);
  } catch (error) {
    const status = error.code || 500;
    res.status(status).json({ error: error.message || 'Detail not found', key });
  }
});

// Proxy receipt web pages with cookies
app.get('/api/receipt-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (tapTouchSession?.cookieHeader) {
      headers['Cookie'] = tapTouchSession.cookieHeader;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch receipt: HTTP ${response.status}`);
    }

    let html = await response.text();
    
    const responsiveStyles = `
<style>
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
    box-sizing: border-box !important;
    background: #ffffff !important;
  }
  * {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  div, table, section, article {
    max-width: 100% !important;
  }
  /* Normalize centered POS print boxes to adapt to narrow screens */
  .receipt, .receipt-container, .print-box, .paper, [class*="receipt"], [class*="print"], [class*="container"] {
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 auto !important;
    padding: 12px !important;
    box-shadow: none !important;
    box-sizing: border-box !important;
  }
</style>
    `;

    const injectContent = `<base href="https://backoffice.taptouch.net/">` + responsiveStyles;
    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + injectContent);
    } else if (html.includes('<HEAD>')) {
      html = html.replace('<HEAD>', '<HEAD>' + injectContent);
    } else {
      html = injectContent + html;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('[Receipt Proxy] Error:', error.message);
    res.status(500).send(`Receipt proxy error: ${error.message}`);
  }
});

// All order details map
app.get('/api/orders/details', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });
  res.json(cache.data.orderDetails || {});
});

// Sales report data
app.get('/api/sales/report', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });
  res.json(cache.data.salesReport || {});
});

// ── Scrape trigger & status ────────────────────────────────────
function createScrapeStatus(overrides = {}) {
  return {
    running: false,
    lastStarted: null,
    lastLog: '',
    error: null,
    phase: 'idle',
    coreReady: false,
    detailReady: 0,
    detailTotal: 0,
    detailFetchedThisRun: 0,
    detailMissing: 0,
    detailPercent: 0,
    ...overrides,
  };
}

let scrapeStatus = createScrapeStatus();

function applyCacheSyncStateToScrapeStatus() {
  const sync = cache.syncState;
  if (!sync) return;

  scrapeStatus.phase = sync.phase || scrapeStatus.phase;
  scrapeStatus.coreReady = !!sync.coreReady;
  scrapeStatus.detailReady = sync.detailReady || 0;
  scrapeStatus.detailTotal = sync.detailTotal || 0;
  scrapeStatus.detailFetchedThisRun = sync.detailFetchedThisRun || 0;
  scrapeStatus.detailMissing = sync.detailMissing || 0;
  scrapeStatus.detailPercent = sync.detailPercent || 0;
  if (sync.message) scrapeStatus.lastLog = sync.message;
}

app.get('/api/scrape/status', (req, res) => res.json({
  ...scrapeStatus,
  dataReady:   !!cache.data,
  lastUpdated: cache.lastUpdated,
}));

app.get('/api/auto-sync/status', (req, res) => res.json({
  ...autoSyncState,
  hasSession: !!tapTouchSession?.cookieHeader,
  sessionCreatedAt: tapTouchSession?.createdAt || null,
  sessionSid: tapTouchSession?.sid || null,
}));

app.post('/api/auto-sync/run', async (req, res) => {
  try {
    await runCookieRefreshNow();
    res.json({ ok: true, message: '已使用当前 cookie 刷新数据' });
  } catch (error) {
    const status = error.code === 'SYNC_BUSY' ? 409 : 400;
    res.status(status).json({
      ok: false,
      error: error.message || 'Cookie refresh failed',
      needRelogin: error.code === 'SESSION_MISSING' || error.code === 'SESSION_EXPIRED',
    });
  }
});

app.post('/api/scrape/run', (req, res) => {
  if (scrapeStatus.running) {
    return res.json({ ok: false, message: '爬虫正在运行中，请稍候...' });
  }

  scrapeStatus = createScrapeStatus({
    running: true,
    lastStarted: new Date().toISOString(),
    lastLog: '启动 Chrome...',
    phase: 'starting',
  });
  res.json({ ok: true, message: '已启动，约30秒后完成' });

  const child = spawn('node', ['scraper.js'], { cwd: __dirname, env: process.env });

  child.stdout.on('data', d => {
    const line = d.toString().trim().split('\n').pop();
    console.log('[Scraper]', line);
    scrapeStatus.lastLog = line;
  });
  child.stderr.on('data', d => { scrapeStatus.lastLog = d.toString().trim().split('\n').pop(); });

  child.on('close', code => {
    scrapeStatus.running = false;
    if (code === 0) {
      loadData();
      applyCacheSyncStateToScrapeStatus();
      scrapeStatus.lastLog = cache.syncState?.message || '✅ 数据更新成功！';
      scrapeStatus.error   = null;
    } else {
      scrapeStatus.lastLog = `❌ 失败 (exit ${code})`;
      scrapeStatus.error   = `Exit code ${code}`;
      scrapeStatus.phase   = 'failed';
    }
  });
});

// ============================================================
// START
// ============================================================
const loaded = loadData();
applyCacheSyncStateToScrapeStatus();

setTimeout(() => {
  refreshTapTouchSession(true).catch(error => {
    autoSyncState.lastError = error.message || 'Cookie refresh failed';
    console.error('[Server] Initial cookie refresh failed:', error.message);
  });
}, 1000);

setTimeout(() => {
  runAutoCookieSync('startup').catch(error => {
    autoSyncState.lastError = error.message || 'Startup auto sync failed';
    console.error('[Server] Startup auto sync failed:', error.message);
  });
}, 3000);

setInterval(() => {
  refreshTapTouchSession(true).catch(error => {
    autoSyncState.lastError = error.message || 'Cookie refresh failed';
    console.error('[Server] Cookie refresh failed:', error.message);
  });
}, COOKIE_REFRESH_MS);

setInterval(() => {
  runAutoCookieSync('interval').catch(error => {
    autoSyncState.lastError = error.message || 'Auto sync failed';
    console.error('[Server] Auto sync failed:', error.message);
  });
}, AUTO_FETCH_MS);

// Auto-reload when scrape-result.json changes
fs.watchFile(path.join(__dirname, 'scrape-result.json'), { interval: 3000 }, () => {
  console.log('[Server] scrape-result.json changed — reloading...');
  if (loadData()) {
    applyCacheSyncStateToScrapeStatus();
  }
});

app.listen(PORT, () => {
  console.log(`\n🍜  PROSPERITY XH Dashboard Server`);
  console.log(`    Dashboard: http://localhost:${PORT}`);
  console.log(`    Data:      ${loaded ? `✅ TapTouch 真实数据 ($${cache.data?.totalRevenue})` : '❌ 请先点击同步按钮'}\n`);
});

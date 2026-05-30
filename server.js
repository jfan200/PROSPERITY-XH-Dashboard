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
const { fetchSingleOrderDetail, parseReceiptDetail } = require('./scraper');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
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
  const recentOrders = [];

  // New scraper format: raw allOrders array
  if (Array.isArray(raw.allOrders) && raw.allOrders.length > 0) {
    for (const o of raw.allOrders) {
      recentOrders.push({
        id:       o.id       || '',
        txId:     o.txId     || '',
        source:   o.source   || '',
        type:     o.type     || '',
        date:     (o.date    || '').replace(/^\d{4}-\d{2}-\d{2} /, ''),
        cashier:  o.cashier  || '-',
        customer: o.customer || '-',
        tax:      o.tax      || '$0',
        amount:   o.amount   || '$0',
        status:   (o.status  || 'paid').toLowerCase(),
      });
    }
  }
  // Fallback: old scraper format (firstRows from table)
  else {
    const ordersPage = (raw.scrapedPages || {})['/store/report'];
    if (ordersPage?.tables?.[0]?.firstRows) {
      for (const row of ordersPage.tables[0].firstRows) {
        recentOrders.push({
          id:       row[0]  || '',
          txId:     row[1]  || '',
          source:   row[2]  || '',
          type:     row[3]  || '',
          date:     (row[4] || '').replace(/^\d{4}-\d{2}-\d{2} /, ''),
          cashier:  row[5]  || '-',
          customer: row[6]  || '-',
          tax:      row[7]  || '$0',
          amount:   row[8]  || '$0',
          status:   (row[12] || 'paid').toLowerCase(),
        });
      }
    }
  }

  return {
    storeName:    'PROSPERITY XH',
    brandName:    '食集-重庆小面',
    totalRevenue,
    totalOrders,
    avgTicket,
    hourlySales,
    payments,
    recentOrders,
    weeklyOverview: buildWeeklyOverview(raw),
    syncState: raw.syncState || null,
    orderDetails: raw.orderDetails || {},
    salesReport:  raw.salesReport  || {},
    scrapedAt:    raw.timestamp,
  };
}

// ============================================================
// CACHE
// ============================================================
let cache = { data: null, raw: null, lastUpdated: null, syncState: null };
const inflightDetailFetches = new Map();

function findOrderInRaw(raw, key) {
  const pools = [raw?.allOrders, raw?.weeklyOrders];
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

async function getOrFetchOrderDetail(key) {
  const cached = cache.data?.orderDetails?.[key];
  if (cached) return cached;

  if (inflightDetailFetches.has(key)) {
    return inflightDetailFetches.get(key);
  }

  const promise = (async () => {
    const order = findRawOrderByKey(key);
    if (!order) {
      const error = new Error('Order not found');
      error.code = 404;
      throw error;
    }

    const detail = await fetchSingleOrderDetail(order, {
      sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
    });
    if (!detail) {
      const error = new Error('Detail fetch failed');
      error.code = 502;
      throw error;
    }

    persistOrderDetail(order.txId || order.id || key, detail);
    return cache.data?.orderDetails?.[order.txId || order.id || key] || detail;
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
    totalRevenue: d.totalRevenue,
    totalOrders:  d.totalOrders,
    avgTicket:    d.avgTicket,
    payments:     d.payments,
    weeklyOverview: d.weeklyOverview,
    lastUpdated:  cache.lastUpdated,
    scrapedAt:    d.scrapedAt,
  });
});

app.get('/api/orders/recent', (req, res) => {
  if (!cache.data) return res.status(503).json({ error: 'No data' });
  res.json(cache.data.recentOrders);
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

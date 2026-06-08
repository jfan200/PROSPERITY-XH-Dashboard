/**
 * RESTAURANT DASHBOARD — SERVER.JS
 * Serves real TapTouch data scraped from backoffice.taptouch.net
 * Run: node server.js
 */
'use strict';

const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyStatic = require('@fastify/static');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createDailySalesReport, persistDailySalesReport } = require('./report-agent');
const {
  createSessionByLogin,
  fetchCoreDataWithSession,
  fetchProductsForRangeWithSession,
  fetchOrdersForDateWithSession,
  fetchSingleOrderDetailWithSession,
  fetchProductsForRange,
  fetchOrdersForDate,
  fetchSingleOrderDetail,
  parseReceiptDetail,
  scrapeTapTouch,
} = require('./scraper');
const {
  APP_ROOT,
  LEGACY_SCRAPE_RESULT_PATH,
  SCRAPE_RESULT_PATH,
  REPORTS_DIR,
  DEPLOY_TARGET,
  SCRAPER_EXECUTION_MODE,
  isServerless,
  ENABLE_BACKGROUND_JOBS,
  ENABLE_FILE_WATCH,
  ENABLE_SCRAPER_API,
  ensureRuntimeDirectories,
} = require('./runtime-config');

const STATIC_ROOT = fs.existsSync(path.join(APP_ROOT, 'dist', 'index.html'))
  ? path.join(APP_ROOT, 'dist')
  : APP_ROOT;

function enhanceReply(reply) {
  reply.status = function status(code) {
    reply.code(code);
    return reply;
  };

  reply.json = function json(payload) {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return reply.send(payload);
  };

  reply.sendStatus = function sendStatus(code) {
    reply.code(code);
    return reply.send(code);
  };

  return reply;
}

function createLegacyAppAdapter(server, readyPromise) {
  const wrap = handler => async (request, reply) => handler(request, enhanceReply(reply));

  return {
    get(route, handler) {
      server.get(route, wrap(handler));
    },
    post(route, handler) {
      server.post(route, wrap(handler));
    },
    listen(port, callback) {
      return readyPromise
        .then(() => server.listen({ port, host: '0.0.0.0' }))
        .then(() => {
          if (typeof callback === 'function') callback();
        });
    },
  };
}

async function configureFastify(server) {
  await server.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  server.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    return payload;
  });

  await server.register(fastifyStatic, {
    root: STATIC_ROOT,
    prefix: '/',
  });
}

const fastify = Fastify({
  logger: false,
  bodyLimit: 10 * 1024 * 1024,
});
const fastifyReady = configureFastify(fastify);
const app = createLegacyAppAdapter(fastify, fastifyReady);
const PORT = Number(process.env.PORT || 3001);
const COOKIE_REFRESH_MS = Math.max(5 * 60 * 1000, Number(process.env.TAPTOUCH_COOKIE_REFRESH_MS || 30 * 60 * 1000));
const AUTO_FETCH_MS = Math.max(60 * 1000, Number(process.env.TAPTOUCH_AUTO_FETCH_MS || 5 * 60 * 1000));
const DETAIL_PREFETCH_WORKERS = Math.max(1, Number(process.env.TAPTOUCH_DETAIL_PREFETCH_WORKERS || process.env.DETAIL_PREFETCH_WORKERS || 2));
const ANALYTICS_CONTEXT_PATH = path.join(APP_ROOT, 'analytics-context.json');
const REPORT_AGENT_MODE = String(process.env.REPORT_AGENT_MODE || 'rules').trim().toLowerCase();
const REPORT_AGENT_OPENAI_MODEL = String(process.env.REPORT_AGENT_OPENAI_MODEL || 'gpt-4.1-mini').trim();
const AUTO_DAILY_REPORT_ENABLED = /^(1|true|yes)$/i.test(process.env.REPORT_AGENT_AUTO_GENERATE || 'true');
const REPORT_AGENT_TIMEZONE = String(process.env.REPORT_AGENT_TIMEZONE || 'Australia/Melbourne').trim() || 'Australia/Melbourne';
const REPORT_AGENT_OPEN_HOUR = Number(process.env.REPORT_AGENT_OPEN_HOUR || 10);
const REPORT_AGENT_CLOSE_HOUR = Number(process.env.REPORT_AGENT_CLOSE_HOUR || 22);
const REPORT_AGENT_SNAPSHOT_INTERVAL_MS = Math.max(30 * 60 * 1000, Number(process.env.REPORT_AGENT_SNAPSHOT_INTERVAL_MS || 2 * 60 * 60 * 1000));
const REPORT_AGENT_SCHEDULER_TICK_MS = Math.max(60 * 1000, Number(process.env.REPORT_AGENT_SCHEDULER_TICK_MS || 5 * 60 * 1000));
const REPORT_AGENT_HISTORY_DAYS = Math.max(3, Number(process.env.REPORT_AGENT_HISTORY_DAYS || 7));

function hasConfiguredTapTouchCredentials() {
  const email = String(process.env.TAPTOUCH_EMAIL || '').trim();
  const password = String(process.env.TAPTOUCH_PASSWORD || '').trim();

  if (!email || !password) return false;
  if (email === 'your-email@example.com') return false;
  if (password === 'your-password') return false;

  return true;
}

const AUTO_SYNC_ENABLED = /^(1|true|yes)$/i.test(process.env.TAPTOUCH_AUTO_SYNC || 'true')
  && hasConfiguredTapTouchCredentials();

ensureRuntimeDirectories();

// ============================================================
// PARSE REAL TAPTOUCH DATA FROM cached snapshot
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

function buildDayRange(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  const [, year, month, day] = match;
  const start = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  const end = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);
  return { start, end };
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

function readAnalyticsContextConfig() {
  try {
    return JSON.parse(fs.readFileSync(ANALYTICS_CONTEXT_PATH, 'utf8'));
  } catch (error) {
    return {
      area: 'PROSPERITY XH store operations',
      coverageLevel: 'Limited',
      keyMetrics: [],
      sourceInventory: [],
      dimensions: [],
      queryPatterns: [],
      gotchas: ['analytics-context.json is missing or unreadable'],
      futurePrompts: [],
    };
  }
}

function buildAnalyticsContextPayload() {
  const base = readAnalyticsContextConfig();
  const data = cache.data || {};
  const runtimeOrderDetails = cache.data?.orderDetails || cache.raw?.orderDetails || {};
  const runtimeOrdersByDate = cache.raw?.ordersByDate || {};

  return {
    ...base,
    runtime: {
      hasLiveData: !!cache.hasLiveData,
      dataSource: cache.hasLiveData ? 'taptouch_live' : 'cache_or_empty',
      storeName: data.storeName || 'PROSPERITY XH',
      brandName: data.brandName || '',
      lastUpdated: cache.lastUpdated || null,
      scrapedAt: data.scrapedAt || null,
      ordersDateKey: data.ordersDateKey || null,
      availableData: {
        products: Array.isArray(data.products) ? data.products.length : 0,
        recentOrders: Array.isArray(data.recentOrders) ? data.recentOrders.length : 0,
        cachedOrderDetails: Object.keys(runtimeOrderDetails).length,
        historicalDateCaches: Object.keys(runtimeOrdersByDate).length,
      },
    },
  };
}

function buildProductInsights(products = []) {
  const normalized = Array.isArray(products) ? products : [];
  const totalQty = normalized.reduce((sum, product) => sum + (Number(product.qty) || 0), 0);
  const totalRevenue = round2(normalized.reduce((sum, product) => sum + (Number(product.amount) || 0), 0));
  const totalProfit = round2(normalized.reduce((sum, product) => sum + (Number(product.profit) || 0), 0));
  const uniqueProducts = normalized.length;
  const avgRevenuePerItem = totalQty > 0 ? round2(totalRevenue / totalQty) : 0;
  const topProduct = normalized[0] || null;
  const topShare = topProduct && totalRevenue > 0
    ? round2((Number(topProduct.amount || 0) / totalRevenue) * 100)
    : 0;

  const concentrationTop5 = totalRevenue > 0
    ? round2((normalized.slice(0, 5).reduce((sum, product) => sum + (Number(product.amount) || 0), 0) / totalRevenue) * 100)
    : 0;

  const tailShare = round2(Math.max(0, 100 - concentrationTop5));

  return {
    totalQty,
    totalRevenue,
    totalProfit,
    uniqueProducts,
    avgRevenuePerItem,
    topProduct: topProduct ? {
      rank: topProduct.rank || 1,
      name: topProduct.name || '',
      qty: Number(topProduct.qty) || 0,
      amount: Number(topProduct.amount) || 0,
      sharePct: topShare,
    } : null,
    concentrationTop5,
    tailShare,
  };
}

function buildProductReportDataset(products = [], meta = {}) {
  const normalized = Array.isArray(products)
    ? products
        .map((product, index) => ({
          rank: index + 1,
          name: product.name || '',
          code: product.code || '',
          category: product.category || '未分类',
          onlineQty: Number(product.onlineQty) || 0,
          onlineAmount: round2(Number(product.onlineAmount) || 0),
          qty: Number(product.qty) || 0,
          amount: round2(Number(product.amount) || 0),
          sharePct: round2(Number(product.sharePct) || 0),
          cost: round2(Number(product.cost) || 0),
          profit: round2(Number(product.profit) || 0),
          marginPct: round2((Number(product.amount) || 0) > 0 ? ((Number(product.profit) || 0) / Number(product.amount)) * 100 : 0),
        }))
        .filter(product => product.name && product.qty > 0)
        .sort((a, b) => (b.qty - a.qty) || (b.amount - a.amount))
        .map((product, index) => ({ ...product, rank: index + 1 }))
    : [];

  return {
    mode: meta.mode || 'today',
    label: meta.label || '今天',
    dateKey: meta.dateKey || null,
    weekStart: meta.weekStart || null,
    weekEnd: meta.weekEnd || null,
    fetchedAt: meta.fetchedAt || null,
    source: meta.source || 'live',
    products: normalized,
    insights: buildProductInsights(normalized),
  };
}

function calcChangePct(current, previous) {
  const currentVal = Number(current) || 0;
  const previousVal = Number(previous) || 0;
  if (previousVal === 0) return currentVal === 0 ? 0 : 100;
  return round2(((currentVal - previousVal) / previousVal) * 100);
}

function compareProductsByName(currentProducts = [], previousProducts = []) {
  const previousMap = new Map(previousProducts.map(product => [product.name, product]));
  return currentProducts.map(product => {
    const previous = previousMap.get(product.name) || null;
    return {
      ...product,
      previousQty: Number(previous?.qty) || 0,
      previousAmount: Number(previous?.amount) || 0,
      previousProfit: Number(previous?.profit) || 0,
      qtyChangePct: calcChangePct(product.qty, previous?.qty),
      amountChangePct: calcChangePct(product.amount, previous?.amount),
      profitChangePct: calcChangePct(product.profit, previous?.profit),
    };
  });
}

function summarizeCategoryStats(products = [], totalRevenue = 0, totalProfit = 0, totalQty = 0) {
  const bucket = new Map();

  for (const product of products) {
    const category = product.category || '未分类';
    const current = bucket.get(category) || { category, qty: 0, amount: 0, profit: 0, skuCount: 0 };
    current.qty += Number(product.qty) || 0;
    current.amount += Number(product.amount) || 0;
    current.profit += Number(product.profit) || 0;
    current.skuCount += 1;
    bucket.set(category, current);
  }

  return Array.from(bucket.values())
    .map(item => ({
      ...item,
      amount: round2(item.amount),
      profit: round2(item.profit),
      revenueSharePct: totalRevenue > 0 ? round2((item.amount / totalRevenue) * 100) : 0,
      profitSharePct: totalProfit > 0 ? round2((item.profit / totalProfit) * 100) : 0,
      qtySharePct: totalQty > 0 ? round2((item.qty / totalQty) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function buildMenuEngineering(products = []) {
  const qtyMedian = median(products.map(product => Number(product.qty) || 0));
  const profitMedian = median(products.map(product => Number(product.profit) || 0));

  const quadrants = {
    stars: [],
    traffic: [],
    potential: [],
    weak: [],
  };

  for (const product of products) {
    const highQty = (Number(product.qty) || 0) >= qtyMedian;
    const highProfit = (Number(product.profit) || 0) >= profitMedian;

    if (highQty && highProfit) quadrants.stars.push(product);
    else if (highQty && !highProfit) quadrants.traffic.push(product);
    else if (!highQty && highProfit) quadrants.potential.push(product);
    else quadrants.weak.push(product);
  }

  const sortQuadrant = list => list
    .slice()
    .sort((a, b) => (Number(b.profit) - Number(a.profit)) || (Number(b.qty) - Number(a.qty)))
    .slice(0, 5);

  return {
    qtyMedian: round2(qtyMedian),
    profitMedian: round2(profitMedian),
    quadrants: {
      stars: sortQuadrant(quadrants.stars),
      traffic: sortQuadrant(quadrants.traffic),
      potential: sortQuadrant(quadrants.potential),
      weak: sortQuadrant(quadrants.weak),
    },
  };
}

function buildConcentrationStats(products = [], totalRevenue = 0) {
  const top5Revenue = round2(products.slice(0, 5).reduce((sum, product) => sum + (Number(product.amount) || 0), 0));
  const otherRevenue = round2(Math.max(0, totalRevenue - top5Revenue));
  const top5SharePct = totalRevenue > 0 ? round2((top5Revenue / totalRevenue) * 100) : 0;
  const otherSharePct = round2(Math.max(0, 100 - top5SharePct));

  return {
    top5Revenue,
    otherRevenue,
    top5SharePct,
    otherSharePct,
    riskLevel: top5SharePct >= 60 ? 'high' : top5SharePct >= 45 ? 'medium' : 'low',
  };
}

function buildProfitLeaders(products = []) {
  return products
    .slice()
    .sort((a, b) => (Number(b.profit) - Number(a.profit)) || (Number(b.amount) - Number(a.amount)))
    .slice(0, 5);
}

function buildChangeLeaders(currentProducts = [], previousProducts = []) {
  const compared = compareProductsByName(currentProducts, previousProducts)
    .filter(product => product.previousQty > 0 || product.qty > 0);

  const growth = compared
    .filter(product => product.qtyChangePct > 0)
    .sort((a, b) => b.qtyChangePct - a.qtyChangePct)[0] || null;

  const decline = compared
    .filter(product => product.qtyChangePct < 0)
    .sort((a, b) => a.qtyChangePct - b.qtyChangePct)[0] || null;

  return { growth, decline, compared };
}

function buildTrendSeries(timeline = [], productNames = [], metric = 'qty') {
  return productNames.map(name => ({
    name,
    data: timeline.map(entry => {
      const matched = (entry.products || []).find(product => product.name === name);
      const value = matched ? Number(matched[metric]) || 0 : 0;
      return round2(value);
    }),
  }));
}

function buildTrendPackage(timeline = [], currentProducts = []) {
  const labels = timeline.map(entry => entry.label);
  const topNames = currentProducts.slice(0, 5).map(product => product.name);
  return {
    labels,
    topNames,
    qty: buildTrendSeries(timeline, topNames, 'qty'),
    revenue: buildTrendSeries(timeline, topNames, 'amount'),
    profit: buildTrendSeries(timeline, topNames, 'profit'),
  };
}

function getWeekRangeForDateKey(dateKey) {
  const referenceDate = parseLocalDateTime(`${dateKey} 00:00:00`) || new Date();
  const weekStart = startOfWeekMonday(referenceDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  return { weekStart, weekEnd };
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

function buildEmptyWeeklyOverview(referenceDate = new Date()) {
  const weekStart = startOfWeekMonday(referenceDate);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  return {
    dateRangeLabel: formatRangeLabel(weekStart, weekEnd),
    totalRevenue: 0,
    totalOrders: 0,
    avgTicket: 0,
    activeDays: 0,
    bestDay: null,
    daily: WEEKDAY_MON.map((weekday, index) => {
      const dateObj = new Date(weekStart);
      dateObj.setDate(weekStart.getDate() + index);
      const key = formatDateKey(dateObj);

      return {
        label: weekday,
        chartLabel: weekday,
        weekday,
        fullLabel: `${weekday} ${dateObj.getDate()} ${MONTH_SHORT[dateObj.getMonth()]}`,
        dateKey: key,
        revenue: 0,
        orders: 0,
        avgTicket: 0,
        hasData: false,
        isToday: key === formatDateKey(referenceDate),
      };
    }),
  };
}

function buildEmptyDashboardData(referenceDate = new Date()) {
  return {
    storeName: 'PROSPERITY XH',
    brandName: '食集-重庆小面',
    totalRevenue: 0,
    totalOrders: 0,
    avgTicket: 0,
    hourlySales: [],
    payments: [],
    recentOrders: [],
    ordersDateKey: formatDateKey(referenceDate),
    weeklyOverview: buildEmptyWeeklyOverview(referenceDate),
    syncState: null,
    orderDetails: {},
    salesReport: {},
    scrapedAt: null,
    products: [],
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
let cache = {
  data: buildEmptyDashboardData(),
  raw: null,
  lastUpdated: null,
  syncState: null,
  hasLiveData: false,
};
const inflightDetailFetches = new Map();
const inflightDateFetches = new Map();
const detailPrefetchQueue = [];
const detailPrefetchQueuedSet = new Set();
let detailPrefetchActive = 0;
let tapTouchSession = null;
let cookieRefreshPromise = null;
let dailyReportPromise = null;
const autoSyncState = {
  cookieLastRefreshedAt: null,
  dataLastFetchedAt: null,
  running: false,
  cookieRefreshing: false,
  lastError: null,
};
const dailyReportState = {
  running: false,
  lastGeneratedAt: null,
  lastDateKey: null,
  lastHtmlPath: null,
  lastStage: null,
  agentMode: REPORT_AGENT_MODE,
  lastError: null,
  nextScheduledAt: null,
  latestAvailableDateKey: null,
  latestAvailableStage: null,
  historyDays: REPORT_AGENT_HISTORY_DAYS,
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
    if (!fs.existsSync(SCRAPE_RESULT_PATH)) {
      if (fs.existsSync(LEGACY_SCRAPE_RESULT_PATH)) {
        fs.copyFileSync(LEGACY_SCRAPE_RESULT_PATH, SCRAPE_RESULT_PATH);
        console.log(`[Server] Migrated legacy snapshot to ${SCRAPE_RESULT_PATH}`);
      } else {
        console.log(`[Server] ℹ️ Snapshot not found yet: ${SCRAPE_RESULT_PATH}`);
        return false;
      }
    }

    const raw = JSON.parse(fs.readFileSync(SCRAPE_RESULT_PATH, 'utf8'));
    normalizeCachedOrderDetails(raw);
    cache.raw  = raw;
    cache.data = parseTapTouchData(raw);
    cache.syncState = raw.syncState || null;
    cache.hasLiveData = true;
    cache.lastUpdated = new Date().toISOString();
    const d = cache.data;
    console.log(`[Server] ✅ Loaded: $${d.totalRevenue} / ${d.totalOrders} orders / ${d.hourlySales.filter(h=>h.revenue>0).length} active hours`);
    return true;
  } catch (e) {
    console.error(`[Server] ❌ Failed to load snapshot (${SCRAPE_RESULT_PATH}):`, e.message);
    return false;
  }
}

function findRawOrderByKey(key) {
  return findOrderInRaw(cache.raw, key);
}

function readLatestDailyReportMeta() {
  const latestPath = path.join(REPORTS_DIR, 'daily', 'latest.json');
  if (!fs.existsSync(latestPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function readDailyReportIndex(dateKey) {
  const metaPath = path.join(REPORTS_DIR, 'daily', dateKey, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function getReportPathFromMeta(meta, key) {
  const relativePath = String(meta?.[key] || '').replace(/^\//, '');
  return relativePath ? path.join(APP_ROOT, relativePath) : '';
}

function buildDailyReportHistory(limit = REPORT_AGENT_HISTORY_DAYS) {
  const dailyRoot = path.join(REPORTS_DIR, 'daily');
  if (!fs.existsSync(dailyRoot)) return [];

  return fs.readdirSync(dailyRoot)
    .filter(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, Math.max(1, Number(limit) || REPORT_AGENT_HISTORY_DAYS))
    .map(dateKey => {
      const meta = readDailyReportIndex(dateKey);
      const legacyJsonPath = path.join(dailyRoot, dateKey, 'report.json');
      let legacyReport = null;
      if (!meta && fs.existsSync(legacyJsonPath)) {
        try {
          legacyReport = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8'));
        } catch {
          legacyReport = null;
        }
      }

      const fallbackStage = fs.existsSync(path.join(dailyRoot, dateKey, 'report.final.json'))
        ? 'final'
        : (legacyReport?.lifecycle?.stage || 'snapshot');
      const stage = meta?.latestStage || fallbackStage;
      const variant = meta?.[stage] || null;
      const htmlPath = variant?.htmlPath
        || (fs.existsSync(path.join(dailyRoot, dateKey, 'report.final.html'))
          ? `/reports/daily/${dateKey}/report.final.html`
          : `/reports/daily/${dateKey}/report.html`);

      return {
        dateKey,
        stage,
        generatedAt: variant?.generatedAt || meta?.latestGeneratedAt || legacyReport?.generatedAt || null,
        htmlPath,
        agentMode: variant?.agentMode || meta?.agentMode || legacyReport?.agent?.mode || REPORT_AGENT_MODE,
        hasFinal: !!meta?.final || fs.existsSync(path.join(dailyRoot, dateKey, 'report.final.json')),
        hasSnapshot: !!meta?.snapshot || fs.existsSync(path.join(dailyRoot, dateKey, 'report.snapshot.json')) || (!!legacyReport && !fs.existsSync(path.join(dailyRoot, dateKey, 'report.final.json'))),
      };
    });
}

function cleanupOldDailyReports(maxDays = REPORT_AGENT_HISTORY_DAYS) {
  const dailyRoot = path.join(REPORTS_DIR, 'daily');
  if (!fs.existsSync(dailyRoot)) return;

  const datedEntries = fs.readdirSync(dailyRoot)
    .filter(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry))
    .sort((left, right) => right.localeCompare(left));

  datedEntries.slice(Math.max(1, Number(maxDays) || REPORT_AGENT_HISTORY_DAYS)).forEach(dateKey => {
    fs.rmSync(path.join(dailyRoot, dateKey), { recursive: true, force: true });
  });
}

function getReportClock(referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_AGENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(referenceDate);

  const lookup = type => parts.find(part => part.type === type)?.value || '';
  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  const hour = Number(lookup('hour') || 0);
  const minute = Number(lookup('minute') || 0);
  const second = Number(lookup('second') || 0);

  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    minute,
    second,
    isoLocal: `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
  };
}

function isReportStoreOpen(clock = getReportClock()) {
  return clock.hour >= REPORT_AGENT_OPEN_HOUR && clock.hour < REPORT_AGENT_CLOSE_HOUR;
}

function buildNextSnapshotDueAt(isoString) {
  const timestamp = Date.parse(isoString);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + REPORT_AGENT_SNAPSHOT_INTERVAL_MS).toISOString();
}

function buildNextOpenTime(clock = getReportClock()) {
  const [year, month, day] = clock.dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}T${String(REPORT_AGENT_OPEN_HOUR).padStart(2, '0')}:00:00`;
}

function readLatestDailyReportBundle() {
  const latestMeta = readLatestDailyReportMeta();
  if (!latestMeta?.jsonPath) return null;

  const relativeJsonPath = String(latestMeta.jsonPath || '').replace(/^\//, '');
  const absoluteJsonPath = path.join(APP_ROOT, relativeJsonPath);
  if (!fs.existsSync(absoluteJsonPath)) return null;

  try {
    const report = JSON.parse(fs.readFileSync(absoluteJsonPath, 'utf8'));
    return {
      meta: latestMeta,
      report,
    };
  } catch (error) {
    return null;
  }
}

function hydrateDailyReportStateFromDisk() {
  const latestMeta = readLatestDailyReportMeta();
  if (!latestMeta) return;

  dailyReportState.lastGeneratedAt = latestMeta.generatedAt || dailyReportState.lastGeneratedAt;
  dailyReportState.lastDateKey = latestMeta.dateKey || dailyReportState.lastDateKey;
  dailyReportState.lastHtmlPath = latestMeta.htmlPath || dailyReportState.lastHtmlPath;
  dailyReportState.lastStage = latestMeta.stage || dailyReportState.lastStage;
  dailyReportState.agentMode = latestMeta.agentMode || dailyReportState.agentMode;
  dailyReportState.latestAvailableDateKey = latestMeta.dateKey || dailyReportState.latestAvailableDateKey;
  dailyReportState.latestAvailableStage = latestMeta.stage || dailyReportState.latestAvailableStage;
}

async function generateDailySalesReportBundle(options = {}) {
  if (!cache.hasLiveData) {
    throw new Error('No live TapTouch data available for daily report generation');
  }

  if (dailyReportPromise && !options.force) {
    return dailyReportPromise;
  }

  dailyReportPromise = (async () => {
    dailyReportState.running = true;
    dailyReportState.lastError = null;

    try {
      const dateKey = cache.data?.ordersDateKey || getTodayDateKey();
      const yesterdayDateKey = shiftDateKey(dateKey, -1);
      const yesterdayPayload = await getOrdersForDatePayload(yesterdayDateKey);
      const report = await createDailySalesReport({
        summary: {
          ordersDateKey: dateKey,
          totalRevenue: cache.data?.totalRevenue || 0,
          totalOrders: cache.data?.totalOrders || 0,
          avgTicket: cache.data?.avgTicket || 0,
          weeklyOverview: cache.data?.weeklyOverview || {},
          products: cache.data?.products || [],
        },
        hourlySales: cache.data?.hourlySales || [],
        todayOrders: cache.data?.recentOrders || [],
        yesterdayOrders: yesterdayPayload?.orders || [],
      }, {
        mode: options.mode || REPORT_AGENT_MODE,
        openAIApiKey: process.env.OPENAI_API_KEY || '',
        openAIModel: process.env.REPORT_AGENT_OPENAI_MODEL || REPORT_AGENT_OPENAI_MODEL,
        stage: options.stage || 'snapshot',
        trigger: options.trigger || 'manual',
        storeState: options.storeState || null,
      });

      const meta = persistDailySalesReport(report, REPORTS_DIR);
      cleanupOldDailyReports(REPORT_AGENT_HISTORY_DAYS);
      dailyReportState.lastGeneratedAt = report.generatedAt;
      dailyReportState.lastDateKey = report.dateKey;
      dailyReportState.lastHtmlPath = meta.htmlPath;
      dailyReportState.lastStage = meta.stage;
      dailyReportState.agentMode = meta.agentMode;
      dailyReportState.latestAvailableDateKey = meta.dateKey;
      dailyReportState.latestAvailableStage = meta.stage;
      dailyReportState.nextScheduledAt = meta.stage === 'final'
        ? buildNextOpenTime(getReportClock())
        : buildNextSnapshotDueAt(report.generatedAt);

      return {
        meta,
        report,
      };
    } catch (error) {
      dailyReportState.lastError = error.message || 'Daily report generation failed';
      throw error;
    } finally {
      dailyReportState.running = false;
      dailyReportPromise = null;
    }
  })();

  return dailyReportPromise;
}

function queueAutoDailyReportGeneration(reason = 'snapshot_reload', options = {}) {
  if (!AUTO_DAILY_REPORT_ENABLED || !cache.hasLiveData) return;

  generateDailySalesReportBundle({
    stage: options.stage || 'snapshot',
    trigger: reason,
    storeState: options.storeState || null,
  })
    .then(result => {
      console.log(`[Report Agent] Updated ${result.meta.stage} daily report for ${result.meta.dateKey} (${reason})`);
    })
    .catch(error => {
      console.error(`[Report Agent] Failed to generate daily report (${reason}):`, error.message);
    });
}

function evaluateAutoDailyReportSchedule(reason = 'scheduler_tick') {
  if (!AUTO_DAILY_REPORT_ENABLED || !cache.hasLiveData) return;
  if (dailyReportState.running) return;

  const clock = getReportClock();
  const dateKey = cache.data?.ordersDateKey || clock.dateKey;
  const reportIndex = readDailyReportIndex(dateKey);
  const latestStage = reportIndex?.latestStage || null;
  const latestGeneratedAt = reportIndex?.latestGeneratedAt || null;

  dailyReportState.latestAvailableDateKey = reportIndex?.dateKey || dailyReportState.latestAvailableDateKey;
  dailyReportState.latestAvailableStage = latestStage || dailyReportState.latestAvailableStage;

  if (isReportStoreOpen(clock)) {
    if (!latestGeneratedAt || latestStage === 'final') {
      dailyReportState.nextScheduledAt = null;
      queueAutoDailyReportGeneration(reason, { stage: 'snapshot', storeState: 'open' });
      return;
    }

    const nextDueAt = buildNextSnapshotDueAt(latestGeneratedAt);
    dailyReportState.nextScheduledAt = nextDueAt;
    if (nextDueAt && Date.now() >= Date.parse(nextDueAt)) {
      queueAutoDailyReportGeneration(reason, { stage: 'snapshot', storeState: 'open' });
    }
    return;
  }

  dailyReportState.nextScheduledAt = buildNextOpenTime(clock);
  if (latestStage !== 'final') {
    queueAutoDailyReportGeneration(reason, { stage: 'final', storeState: 'closed' });
  }
}

function persistOrderDetail(key, detail) {
  if (!cache.raw) cache.raw = {};
  if (!cache.raw.orderDetails) cache.raw.orderDetails = {};
  cache.raw.orderDetails[key] = detail;

  fs.writeFileSync(SCRAPE_RESULT_PATH, JSON.stringify(cache.raw, null, 2));
  loadData();
}

function persistOrdersForDate(dateKey, entry) {
  if (!cache.raw) cache.raw = {};
  if (!cache.raw.ordersByDate) cache.raw.ordersByDate = {};
  cache.raw.ordersByDate[dateKey] = entry;

  fs.writeFileSync(SCRAPE_RESULT_PATH, JSON.stringify(cache.raw, null, 2));
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

  fs.writeFileSync(SCRAPE_RESULT_PATH, JSON.stringify(cache.raw, null, 2));
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

async function fetchProductsReportLive(options = {}) {
  const sid = tapTouchSession?.sid || cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null;
  let fetched = null;

  if (tapTouchSession?.cookieHeader) {
    try {
      fetched = await fetchProductsForRangeWithSession(tapTouchSession, { ...options, sid });
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_MISSING') {
        await refreshTapTouchSession(true);
        fetched = await fetchProductsForRangeWithSession(tapTouchSession, {
          ...options,
          sid: tapTouchSession?.sid || sid,
        });
      } else {
        throw error;
      }
    }
  } else {
    await refreshTapTouchSession(true);
    fetched = await fetchProductsForRangeWithSession(tapTouchSession, {
      ...options,
      sid: tapTouchSession?.sid || sid,
    });
  }

  return fetched;
}

function shiftDateKey(dateKey, deltaDays) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + deltaDays);
  return formatDateKey(date);
}

function buildDateKeySeries(endDateKey, length) {
  const keys = [];
  for (let index = length - 1; index >= 0; index -= 1) {
    keys.push(shiftDateKey(endDateKey, -index));
  }
  return keys;
}

async function fetchProductReportForDateKey(dateKey) {
  const { start, end } = buildDayRange(dateKey);

  try {
    const fetched = await fetchProductsReportLive({
      label: 'Today',
      start,
      end,
    });
    return buildProductReportDataset(fetched.products, {
      mode: 'date',
      label: dateKey,
      dateKey,
      fetchedAt: fetched.fetchedAt,
      source: 'date_live',
    });
  } catch (error) {
    const fetched = await fetchProductsForRange({
      sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
      label: 'Today',
      start,
      end,
    });
    return buildProductReportDataset(fetched.products, {
      mode: 'date',
      label: dateKey,
      dateKey,
      fetchedAt: fetched.fetchedAt,
      source: 'date_live_fallback',
    });
  }
}

async function fetchTimelineReports(dateKeys = []) {
  const reports = [];
  for (const key of dateKeys) {
    reports.push(await fetchProductReportForDateKey(key));
  }
  return reports;
}

async function buildProductsAnalysisPayload(mode, dateKey) {
  let currentReport = null;
  let previousReport = null;
  let comparisonLabel = '';
  let trendEndDateKey = dateKey;

  if (mode === 'today') {
    currentReport = await fetchProductReportForDateKey(getTodayDateKey());
    previousReport = await fetchProductReportForDateKey(shiftDateKey(getTodayDateKey(), -1));
    comparisonLabel = '较昨日';
    trendEndDateKey = getTodayDateKey();
  } else if (mode === 'date') {
    currentReport = await fetchProductReportForDateKey(dateKey);
    previousReport = await fetchProductReportForDateKey(shiftDateKey(dateKey, -1));
    comparisonLabel = '较前一日';
    trendEndDateKey = dateKey;
  } else {
    const { weekStart, weekEnd } = getWeekRangeForDateKey(dateKey);
    const previousWeekStart = new Date(weekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);
    const previousWeekEnd = new Date(weekEnd);
    previousWeekEnd.setDate(previousWeekEnd.getDate() - 7);

    let fetchedCurrent = null;
    let fetchedPrevious = null;

    try {
      fetchedCurrent = await fetchProductsReportLive({
        label: 'This Week',
        start: weekStart,
        end: weekEnd,
      });
      fetchedPrevious = await fetchProductsReportLive({
        label: 'This Week',
        start: previousWeekStart,
        end: previousWeekEnd,
      });
    } catch (error) {
      fetchedCurrent = await fetchProductsForRange({
        sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
        label: 'This Week',
        start: weekStart,
        end: weekEnd,
      });
      fetchedPrevious = await fetchProductsForRange({
        sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
        label: 'This Week',
        start: previousWeekStart,
        end: previousWeekEnd,
      });
    }

    currentReport = buildProductReportDataset(fetchedCurrent.products, {
      mode: 'week',
      label: formatRangeLabel(weekStart, weekEnd),
      dateKey,
      weekStart: formatDateKey(weekStart),
      weekEnd: formatDateKey(weekEnd),
      fetchedAt: fetchedCurrent.fetchedAt,
      source: 'week_live',
    });
    previousReport = buildProductReportDataset(fetchedPrevious.products, {
      mode: 'week',
      label: formatRangeLabel(previousWeekStart, previousWeekEnd),
      dateKey: formatDateKey(previousWeekStart),
      weekStart: formatDateKey(previousWeekStart),
      weekEnd: formatDateKey(previousWeekEnd),
      fetchedAt: fetchedPrevious.fetchedAt,
      source: 'week_previous',
    });
    comparisonLabel = '较上周';
    trendEndDateKey = formatDateKey(weekEnd);
  }

  const trend7 = await fetchTimelineReports(buildDateKeySeries(trendEndDateKey, 7));
  const trend30 = await fetchTimelineReports(buildDateKeySeries(trendEndDateKey, 30));
  const totalSkuUniverse = new Set(trend30.flatMap(report => report.products.map(product => product.name))).size;
  const comparedProducts = compareProductsByName(currentReport.products, previousReport.products);
  const changes = buildChangeLeaders(currentReport.products, previousReport.products);
  const totalSkus = Math.max(currentReport.insights.uniqueProducts, totalSkuUniverse);

  const currentQty = currentReport.insights.totalQty;
  const previousQty = previousReport.insights.totalQty;
  const currentRevenue = currentReport.insights.totalRevenue;
  const previousRevenue = previousReport.insights.totalRevenue;
  const currentProfit = currentReport.insights.totalProfit;
  const previousProfit = previousReport.insights.totalProfit;

  return {
    mode,
    dateKey,
    current: {
      ...currentReport,
      productsCompared: comparedProducts,
    },
    previous: previousReport,
    comparisonLabel,
    kpis: {
      totalQty: {
        value: currentQty,
        previousValue: previousQty,
        changePct: calcChangePct(currentQty, previousQty),
      },
      totalRevenue: {
        value: currentRevenue,
        previousValue: previousRevenue,
        changePct: calcChangePct(currentRevenue, previousRevenue),
      },
      activeSkuRate: {
        active: currentReport.insights.uniqueProducts,
        total: totalSkus,
        pct: totalSkus > 0 ? round2((currentReport.insights.uniqueProducts / totalSkus) * 100) : 0,
      },
      championShare: {
        pct: currentReport.insights.topProduct?.sharePct || 0,
        name: currentReport.insights.topProduct?.name || '',
      },
      totalProfit: {
        value: currentProfit,
        previousValue: previousProfit,
        changePct: calcChangePct(currentProfit, previousProfit),
      },
    },
    rankings: {
      byQty: currentReport.products.slice().sort((a, b) => (b.qty - a.qty) || (b.amount - a.amount)),
      byRevenue: currentReport.products.slice().sort((a, b) => (b.amount - a.amount) || (b.qty - a.qty)),
      byProfit: currentReport.products.slice().sort((a, b) => (b.profit - a.profit) || (b.amount - a.amount)),
    },
    insights: {
      champion: currentReport.insights.topProduct,
      growthLeader: changes.growth,
      declineLeader: changes.decline,
      concentration: buildConcentrationStats(currentReport.products, currentRevenue),
      recommendation: currentReport.insights.concentrationTop5 >= 60
        ? '当前销售集中度偏高，建议增加长尾产品曝光与套餐联动，降低单一爆款依赖。'
        : '当前菜单结构较均衡，可继续强化冠军单品，并针对潜力产品做第二波推广。',
    },
    menuEngineering: buildMenuEngineering(currentReport.products),
    categoryAnalysis: summarizeCategoryStats(
      currentReport.products,
      currentRevenue,
      currentProfit,
      currentQty
    ),
    profitLeaders: buildProfitLeaders(currentReport.products),
    trends: {
      range7: buildTrendPackage(trend7, currentReport.products),
      range30: buildTrendPackage(trend30, currentReport.products),
    },
  };
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
  dataSource:  cache.hasLiveData ? 'taptouch_live' : 'empty',
  storeName:   cache.data?.storeName || 'PROSPERITY XH',
  lastUpdated: cache.lastUpdated,
  scrapedAt:   cache.hasLiveData ? (cache.data?.scrapedAt || null) : null,
  autoSync: {
    cookieLastRefreshedAt: autoSyncState.cookieLastRefreshedAt,
    dataLastFetchedAt: autoSyncState.dataLastFetchedAt,
    running: autoSyncState.running,
    cookieRefreshing: autoSyncState.cookieRefreshing,
    lastError: autoSyncState.lastError,
    enabled: AUTO_SYNC_ENABLED,
  },
  detailPrefetch: {
    queueSize: detailPrefetchQueue.length,
    activeWorkers: detailPrefetchActive,
  },
}));

app.get('/api/sales/hourly', (req, res) => {
  res.json(cache.data.hourlySales);
});

app.get('/api/sales/summary', (req, res) => {
  const d = cache.data;
  res.json({
    hasLiveData: cache.hasLiveData,
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

app.get('/api/data-context', (req, res) => {
  res.json(buildAnalyticsContextPayload());
});

app.get('/api/reports/daily/latest', async (req, res) => {
  const bundle = readLatestDailyReportBundle();
  const history = buildDailyReportHistory();

  if (!bundle) {
    return res.status(404).json({
      ok: false,
      error: 'No cached daily report available yet',
      state: dailyReportState,
      history,
    });
  }

  res.json({
    ok: true,
    state: dailyReportState,
    meta: bundle.meta,
    report: bundle.report,
    history,
  });
});

app.get('/api/reports/daily/status', (req, res) => {
  res.json({
    ok: true,
    state: dailyReportState,
    latest: readLatestDailyReportMeta(),
    history: buildDailyReportHistory(),
  });
});

app.get('/api/reports/daily/history', (req, res) => {
  res.json({
    ok: true,
    history: buildDailyReportHistory(Number(req.query.limit) || REPORT_AGENT_HISTORY_DAYS),
  });
});

app.post('/api/reports/daily/generate', async (req, res) => {
  try {
    const clock = getReportClock();
    const requestedStage = String(req.body?.stage || '').trim().toLowerCase();
    const stage = requestedStage === 'final'
      ? 'final'
      : (isReportStoreOpen(clock) ? 'snapshot' : 'final');
    const result = await generateDailySalesReportBundle({
      force: true,
      mode: req.body?.mode || REPORT_AGENT_MODE,
      stage,
      trigger: 'manual_api',
      storeState: isReportStoreOpen(clock) ? 'open' : 'closed',
    });
    res.json({
      ok: true,
      state: dailyReportState,
      meta: result.meta,
      report: result.report,
      history: buildDailyReportHistory(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || 'Failed to generate daily report',
      state: dailyReportState,
    });
  }
});

app.get('/api/orders/recent', (req, res) => {
  res.json(cache.data.recentOrders);
});

app.get('/api/products/report', async (req, res) => {
  const mode = String(req.query.mode || 'today').trim();
  const dateKey = String(req.query.date || '').trim() || getTodayDateKey();

  if (!['today', 'date', 'week'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode. Use today, date, or week.' });
  }

  if ((mode === 'date' || mode === 'week') && !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
  }

  if (mode === 'today') {
    if (cache.hasLiveData && Array.isArray(cache.data?.products) && cache.data.products.length > 0) {
      return res.json(buildProductReportDataset(cache.data.products, {
        mode: 'today',
        label: '今天',
        dateKey: cache.data?.ordersDateKey || getTodayDateKey(),
        fetchedAt: cache.data?.scrapedAt || cache.lastUpdated,
        source: 'today_live',
      }));
    }

    try {
      const { start, end } = buildDayRange(getTodayDateKey());
      let fetched = null;

      try {
        fetched = await fetchProductsReportLive({
          label: 'Today',
          start,
          end,
        });
      } catch (error) {
        fetched = await fetchProductsForRange({
          sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
          label: 'Today',
          start,
          end,
        });
      }

      return res.json(buildProductReportDataset(fetched.products, {
        mode: 'today',
        label: '今天',
        dateKey: getTodayDateKey(),
        fetchedAt: fetched.fetchedAt,
        source: 'today_live_direct',
      }));
    } catch (error) {
      return res.json(buildProductReportDataset([], {
        mode: 'today',
        label: '今天',
        dateKey: getTodayDateKey(),
        fetchedAt: null,
        source: 'empty',
      }));
    }
  }

  try {
    let fetched = null;
    let dataset = null;

    if (mode === 'date') {
      const { start, end } = buildDayRange(dateKey);
      try {
        fetched = await fetchProductsReportLive({
          label: 'Today',
          start,
          end,
        });
      } catch (error) {
        fetched = await fetchProductsForRange({
          sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
          label: 'Today',
          start,
          end,
        });
      }

      dataset = buildProductReportDataset(fetched.products, {
        mode: 'date',
        label: dateKey,
        dateKey,
        fetchedAt: fetched.fetchedAt,
        source: 'date_live',
      });
    } else {
      const { weekStart, weekEnd } = getWeekRangeForDateKey(dateKey);
      try {
        fetched = await fetchProductsReportLive({
          label: 'This Week',
          start: weekStart,
          end: weekEnd,
        });
      } catch (error) {
        fetched = await fetchProductsForRange({
          sid: cache.raw?.dashData?.sid || cache.raw?.weeklyDashData?.sid || null,
          label: 'This Week',
          start: weekStart,
          end: weekEnd,
        });
      }

      dataset = buildProductReportDataset(fetched.products, {
        mode: 'week',
        label: formatRangeLabel(weekStart, weekEnd),
        dateKey,
        weekStart: formatDateKey(weekStart),
        weekEnd: formatDateKey(weekEnd),
        fetchedAt: fetched.fetchedAt,
        source: 'week_live',
      });
    }

    res.json(dataset);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load products report' });
  }
});

app.get('/api/products/analysis', async (req, res) => {
  const mode = String(req.query.mode || 'today').trim();
  const dateKey = String(req.query.date || '').trim() || getTodayDateKey();

  if (!['today', 'date', 'week'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode. Use today, date, or week.' });
  }
  if ((mode === 'date' || mode === 'week') && !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
  }

  try {
    const payload = await buildProductsAnalysisPayload(mode, dateKey || getTodayDateKey());
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to build products analysis' });
  }
});

app.get('/api/orders/by-date', async (req, res) => {
  const dateKey = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
  }

  if (!cache.hasLiveData) {
    return res.json(buildOrdersDataset([], {
      dateKey,
      label: dateKey === getTodayDateKey() ? '今天' : dateKey,
      isToday: dateKey === getTodayDateKey(),
      source: 'empty',
      fetchedAt: null,
    }));
  }

  try {
    const payload = await getOrdersForDatePayload(dateKey);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to load orders for date', dateKey });
  }
});

app.post('/api/orders/prefetch', (req, res) => {
  if (!cache.hasLiveData) return res.json({ ok: true, queued: 0, queueSize: 0, activeWorkers: 0 });

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
  if (!cache.hasLiveData) return res.status(404).json({ error: 'No data yet. Please sync from TapTouch first.' });
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
  res.json(cache.data.orderDetails || {});
});

// Sales report data
app.get('/api/sales/report', (req, res) => {
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

function finalizeScrapeSuccess() {
  scrapeStatus.running = false;
  loadData();
  applyCacheSyncStateToScrapeStatus();
  scrapeStatus.lastLog = cache.syncState?.message || '✅ 数据更新成功！';
  scrapeStatus.error = null;
}

function finalizeScrapeFailure(message) {
  scrapeStatus.running = false;
  scrapeStatus.lastLog = message || '❌ 爬虫失败';
  scrapeStatus.error = message || 'Scraper failed';
  scrapeStatus.phase = 'failed';
}

async function runScraperInline() {
  try {
    const result = await scrapeTapTouch();
    if (result?.session?.cookieHeader) {
      tapTouchSession = {
        sid: result.session.sid || tapTouchSession?.sid || null,
        cookies: result.session.cookies || [],
        cookieHeader: result.session.cookieHeader,
        createdAt: result.session.createdAt || new Date().toISOString(),
      };
      autoSyncState.cookieLastRefreshedAt = tapTouchSession.createdAt;
      autoSyncState.dataLastFetchedAt = new Date().toISOString();
      autoSyncState.lastError = null;
    }
    finalizeScrapeSuccess();
  } catch (error) {
    finalizeScrapeFailure(error.message || 'Inline scrape failed');
  }
}

function runScraperChildProcess() {
  const child = spawn('node', ['scraper.js'], { cwd: APP_ROOT, env: process.env });

  child.stdout.on('data', d => {
    const line = d.toString().trim().split('\n').pop();
    console.log('[Scraper]', line);
    scrapeStatus.lastLog = line;
  });
  child.stderr.on('data', d => {
    const line = d.toString().trim().split('\n').pop();
    if (line) scrapeStatus.lastLog = line;
  });

  child.on('close', code => {
    if (code === 0) {
      finalizeScrapeSuccess();
    } else {
      finalizeScrapeFailure(`❌ 失败 (exit ${code})`);
    }
  });
}

app.get('/api/scrape/status', (req, res) => res.json({
  ...scrapeStatus,
  dataReady:   cache.hasLiveData,
  lastUpdated: cache.lastUpdated,
}));

app.get('/api/healthz', (req, res) => res.json({
  ok: true,
  target: DEPLOY_TARGET,
  uptimeSec: Math.round(process.uptime()),
  hasSnapshot: fs.existsSync(SCRAPE_RESULT_PATH),
  dataReady: cache.hasLiveData,
}));

app.get('/api/readyz', (req, res) => {
  if (!cache.hasLiveData) {
    return res.status(503).json({
      ok: false,
      ready: false,
      reason: 'waiting_for_snapshot',
      target: DEPLOY_TARGET,
    });
  }

  res.json({
    ok: true,
    ready: true,
    target: DEPLOY_TARGET,
    lastUpdated: cache.lastUpdated,
  });
});

app.get('/api/runtime', (req, res) => res.json({
  deployTarget: DEPLOY_TARGET,
  isServerless,
  scraperExecutionMode: SCRAPER_EXECUTION_MODE,
  enableBackgroundJobs: ENABLE_BACKGROUND_JOBS,
  enableFileWatch: ENABLE_FILE_WATCH,
  enableScraperApi: ENABLE_SCRAPER_API,
  snapshotPath: SCRAPE_RESULT_PATH,
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
  if (!ENABLE_SCRAPER_API) {
    return res.status(501).json({
      ok: false,
      error: '当前运行模式已禁用本地爬虫入口。建议在独立 worker 或 Docker 容器中运行 scraper。',
      deployTarget: DEPLOY_TARGET,
    });
  }

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

  if (SCRAPER_EXECUTION_MODE === 'inline') {
    runScraperInline();
  } else {
    runScraperChildProcess();
  }
});

// ============================================================
// START
// ============================================================
hydrateDailyReportStateFromDisk();
const loaded = loadData();
if (loaded && AUTO_DAILY_REPORT_ENABLED) {
  evaluateAutoDailyReportSchedule('startup');
}

if (AUTO_SYNC_ENABLED && ENABLE_BACKGROUND_JOBS) {
  console.log('[Server] Auto sync enabled. Dashboard visit can trigger sync automatically.');

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

  setInterval(() => {
    evaluateAutoDailyReportSchedule('scheduler_tick');
  }, REPORT_AGENT_SCHEDULER_TICK_MS);
} else if (AUTO_SYNC_ENABLED && !ENABLE_BACKGROUND_JOBS) {
  console.log(`[Server] Background jobs disabled for ${DEPLOY_TARGET} mode. Auto sync timers will not run in-process.`);
} else {
  console.log('[Server] TapTouch auto sync disabled until TAPTOUCH_EMAIL and TAPTOUCH_PASSWORD are configured.');
}

if (ENABLE_FILE_WATCH) {
  fs.watchFile(SCRAPE_RESULT_PATH, { interval: 3000 }, () => {
    console.log('[Server] Snapshot changed — reloading...');
    if (loadData()) {
      applyCacheSyncStateToScrapeStatus();
      evaluateAutoDailyReportSchedule('snapshot_reload');
    }
  });
}

app.listen(PORT, () => {
  console.log(`\n🍜  PROSPERITY XH Dashboard Server`);
  console.log(`    Dashboard: http://localhost:${PORT}`);
  console.log(`    Data:      ${loaded ? `✅ TapTouch 真实数据 ($${cache.data?.totalRevenue})` : '⭕ 初始为空，等待 TapTouch 同步'}\n`);
});

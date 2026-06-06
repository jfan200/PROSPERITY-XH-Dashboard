'use strict';

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
  const mappedOrders = mapRawOrdersToApiOrders(orders, {});
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

module.exports = {
  round2,
  parseMoneyValue,
  parseLocalDateTime,
  formatDateKey,
  startOfWeekMonday,
  formatRangeLabel,
  getTodayDateKey,
  buildDayRange,
  isSummaryLikeOrder,
  mapRawOrdersToApiOrders,
  buildOrdersDataset,
  buildEmptyWeeklyOverview,
  buildEmptyDashboardData,
};

'use strict';

/**
 * Pure payload builder for `GET /api/v1/sales/orders` (JIN-92).
 *
 * Deliberately thin: it adds only what does not already exist in the repo —
 * numeric line items, pagination, date-range aggregation and an integrity block.
 * Everything else is injected from the server's existing helpers so there is
 * exactly one implementation of each rule:
 *
 * | Concern | Reused from |
 * |---|---|
 * | raw → API order mapping (incl. summary-row filtering) | `mapRawOrdersToApiOrders` in `server.js` |
 * | money parsing | `parseMoneyValue` in `server.js` |
 * | response envelope `{ meta, data }` | `GET /api/v1/sales/summary` |
 *
 * `orders` arriving here are therefore **already mapped**; this module must not
 * re-map them.
 *
 * Note on the date scope: `getOrdersForDatePayload` in `server.js` is NOT reused
 * because it performs live TapTouch fetches for uncached dates. A read-only GET
 * must not trigger a scrape, so `resolveOrderScope` below is cache-only.
 *
 * Range queries report `missingDates` in `integrity` on purpose: without it a day
 * the scraper never fetched is indistinguishable from a day with zero sales, and
 * an agent would read a data gap as a revenue collapse.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Longest window a single request may span. */
const MAX_RANGE_DAYS = 92;

const DAY_MS = 86400000;

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function toInteger(value) {
  return parseInt(String(value ?? '').replace(/[^0-9-]/g, ''), 10) || 0;
}

/**
 * Whether a string is a real `YYYY-MM-DD` calendar date.
 * Rejects `2026-02-30` and `2026-13-01`, which a regex alone would accept.
 * @param {string} key - candidate date key.
 * @returns {boolean} true when the date exists.
 */
function isValidDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Enumerate the date keys between two inclusive bounds.
 * Stepped in UTC so a DST boundary cannot duplicate or skip a day.
 * @param {string} startKey - inclusive start, `YYYY-MM-DD`.
 * @param {string} endKey - inclusive end, `YYYY-MM-DD`.
 * @returns {Array<string>} date keys, capped at {@link MAX_RANGE_DAYS} entries.
 */
function enumerateDateKeys(startKey, endKey) {
  const days = [];
  let cursor = Date.parse(`${startKey}T00:00:00Z`);
  const end = Date.parse(`${endKey}T00:00:00Z`);
  while (cursor <= end && days.length <= MAX_RANGE_DAYS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return days;
}

/**
 * Validate `?date=` / `?start=&end=` and expand a range into day keys.
 *
 * @param {{date?: string, start?: string, end?: string}} query - raw query values.
 * @returns {{ok: true, mode: 'date'|'range', days: Array<string>}
 *   | {ok: false, error: {code: string, message: string}}} parsed range.
 */
function parseOrderRange({ date = '', start = '', end = '' } = {}) {
  const single = String(date || '').trim();
  const from = String(start || '').trim();
  const to = String(end || '').trim();

  if (single && (from || to)) {
    return {
      ok: false,
      error: { code: 'INVALID_RANGE', message: 'date cannot be combined with start/end' },
    };
  }
  if ((from && !to) || (!from && to)) {
    return {
      ok: false,
      error: { code: 'INVALID_RANGE', message: 'start and end must be provided together' },
    };
  }
  if (!single && !from) return { ok: true, mode: 'date', days: [] };

  if (single) {
    if (!isValidDateKey(single)) {
      return { ok: false, error: { code: 'INVALID_DATE', message: 'date must be a real YYYY-MM-DD date' } };
    }
    return { ok: true, mode: 'date', days: [single] };
  }

  if (!isValidDateKey(from) || !isValidDateKey(to)) {
    return { ok: false, error: { code: 'INVALID_DATE', message: 'start and end must be real YYYY-MM-DD dates' } };
  }
  if (from > to) {
    return { ok: false, error: { code: 'INVALID_RANGE', message: 'start must not be after end' } };
  }

  const days = enumerateDateKeys(from, to);
  if (days.length > MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: { code: 'RANGE_TOO_LONG', message: `range must not exceed ${MAX_RANGE_DAYS} days` },
    };
  }
  return { ok: true, mode: 'range', days };
}

/**
 * Attach numeric line items to an already-mapped order.
 *
 * Receipt items store `qty`/`price`/`subtotal` as display strings; the agent-side
 * contract rejects formatted numbers, so they are parsed here.
 *
 * @param {object} order - an order produced by `mapRawOrdersToApiOrders`.
 * @param {object} orderDetails - details keyed by txId.
 * @param {(value: unknown) => number} parseMoney - the server's money parser.
 * @returns {object} the order with `items` replaced by numeric items.
 */
function withItems(order, orderDetails, parseMoney) {
  const key = String(order?.txId || order?.id || '').trim();
  const detail = key ? orderDetails?.[key] : undefined;
  const rawItems = Array.isArray(detail?.items) ? detail.items : [];
  return {
    ...order,
    items: rawItems.map((item) => ({
      name: String(item?.name || '').trim(),
      quantity: toInteger(item?.qty),
      unitPrice: parseMoney(item?.price),
      lineTotal: parseMoney(item?.subtotal),
      note: String(item?.note || '').trim(),
    })),
  };
}

/**
 * Build the paginated response for `/api/v1/sales/orders`.
 *
 * `integrity` describes the whole scope, not just the current page, so a caller
 * can judge whether product-level conclusions are safe before paging through.
 *
 * @param {object} input
 * @param {Array<object>} [input.orders] - orders already mapped by the server.
 * @param {object} [input.orderDetails] - cached details keyed by txId.
 * @param {object} [input.meta] - `{ source, fetchedAt }` provenance.
 * @param {number} [input.page] - 1-based page number.
 * @param {number} [input.limit] - page size, clamped to {@link MAX_LIMIT}.
 * @param {string} [input.generatedAt] - ISO timestamp for `integrity.generatedAt`.
 * @param {object} [input.coverage] - `{ daysRequested, daysWithData, missingDates }` from the scope.
 * @param {(value: unknown) => number} input.parseMoney - required; the server passes `parseMoneyValue`.
 * @returns {{meta: object, data: {orders: Array<object>}}} the response body.
 */
function buildSalesOrdersV1Payload({
  orders = [],
  orderDetails = {},
  meta = {},
  page = 1,
  limit = DEFAULT_LIMIT,
  generatedAt = new Date().toISOString(),
  coverage = {},
  parseMoney,
} = {}) {
  if (typeof parseMoney !== 'function') {
    throw new TypeError('buildSalesOrdersV1Payload requires parseMoney (pass the server parseMoneyValue)');
  }

  const mapped = (Array.isArray(orders) ? orders : []).map((order) =>
    withItems(order, orderDetails, parseMoney),
  );

  const total = mapped.length;
  const safeLimit = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const safePage = clampInt(page, 1, Number.MAX_SAFE_INTEGER, 1);
  const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);
  const offset = (safePage - 1) * safeLimit;
  const pageOrders = mapped.slice(offset, offset + safeLimit);

  const ordersWithItems = mapped.filter((order) => order.items.length > 0).length;
  const detailCoveragePct = total === 0 ? 0 : Number(((ordersWithItems / total) * 100).toFixed(2));

  return {
    meta: {
      source: meta.source ?? 'live',
      fetchedAt: meta.fetchedAt ?? null,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      integrity: {
        recordCount: pageOrders.length,
        totalOrderCount: total,
        ordersWithItems,
        detailCoveragePct,
        hasMissingDetails: ordersWithItems < total,
        daysRequested: coverage.daysRequested ?? 1,
        daysWithData: coverage.daysWithData ?? 1,
        missingDates: coverage.missingDates ?? [],
        generatedAt,
      },
    },
    data: { orders: pageOrders },
  };
}

/**
 * Pick the raw orders for the requested days out of the process cache.
 *
 * Cache-only by design: unlike `getOrdersForDatePayload`, this never triggers a
 * TapTouch fetch, so a read-only GET cannot cause a scrape.
 *
 * @param {object} cache - the server's cache object.
 * @param {{date?: string, days?: Array<string>}} [options] - requested day keys.
 * @param {string} todayKey - today's business date key.
 * @returns {{orders: Array<object>, source: string, fetchedAt: string|null,
 *   dateKey: string, coverage: {daysRequested: number, daysWithData: number, missingDates: Array<string>}}} scope.
 */
function resolveOrderScope(cache, options = {}, todayKey) {
  const today = String(todayKey || cache?.data?.ordersDateKey || '');
  const requestedDays = Array.isArray(options.days) && options.days.length > 0
    ? options.days
    : (String(options.date || '').trim() ? [String(options.date).trim()] : []);

  if (!cache || cache.hasLiveData !== true) {
    return {
      orders: [],
      source: 'empty',
      fetchedAt: null,
      dateKey: requestedDays[0] || today,
      coverage: { daysRequested: requestedDays.length || 1, daysWithData: 0, missingDates: requestedDays.slice() },
    };
  }

  const raw = cache.raw || {};

  // No date, or exactly one: keep the original single-day semantics.
  if (requestedDays.length <= 1) {
    const requested = requestedDays[0] || '';
    if (!requested || requested === today) {
      return {
        orders: Array.isArray(raw.allOrders) ? raw.allOrders : [],
        source: 'today_live',
        fetchedAt: cache.data?.scrapedAt || cache.lastUpdated || null,
        dateKey: today,
        coverage: { daysRequested: 1, daysWithData: 1, missingDates: [] },
      };
    }
    const entry = raw.ordersByDate?.[requested];
    const present = Array.isArray(entry?.orders);
    return {
      orders: present ? entry.orders : [],
      source: 'date_cache',
      fetchedAt: entry?.fetchedAt || cache.lastUpdated || null,
      dateKey: requested,
      coverage: { daysRequested: 1, daysWithData: present ? 1 : 0, missingDates: present ? [] : [requested] },
    };
  }

  const orders = [];
  const missingDates = [];
  let daysWithData = 0;
  let usedToday = false;
  let usedCache = false;
  let fetchedAt = null;

  for (const day of requestedDays) {
    if (day === today) {
      orders.push(...(Array.isArray(raw.allOrders) ? raw.allOrders : []));
      usedToday = true;
      daysWithData += 1;
      fetchedAt = fetchedAt || cache.data?.scrapedAt || cache.lastUpdated || null;
      continue;
    }
    const entry = raw.ordersByDate?.[day];
    if (Array.isArray(entry?.orders)) {
      orders.push(...entry.orders);
      usedCache = true;
      daysWithData += 1;
      fetchedAt = fetchedAt || entry.fetchedAt || cache.lastUpdated || null;
    } else {
      missingDates.push(day);
    }
  }

  const source = usedToday && usedCache
    ? 'mixed'
    : usedToday
      ? 'today_live'
      : usedCache
        ? 'date_cache'
        : 'empty';

  return {
    orders,
    source,
    fetchedAt,
    dateKey: requestedDays[0],
    coverage: { daysRequested: requestedDays.length, daysWithData, missingDates },
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
  buildSalesOrdersV1Payload,
  resolveOrderScope,
  parseOrderRange,
  withItems,
  isValidDateKey,
  enumerateDateKeys,
};

'use strict';

/**
 * Pure payload builder for `GET /api/v1/sales/orders` (JIN-92).
 *
 * Deliberately thin: it adds only what does not already exist in the repo —
 * numeric line items, pagination, and an integrity block. Everything else is
 * injected from the server's existing helpers so there is exactly one
 * implementation of each rule:
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
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
        generatedAt,
      },
    },
    data: { orders: pageOrders },
  };
}

/**
 * Pick the raw orders for one business date from the process cache.
 *
 * Cache-only by design: unlike `getOrdersForDatePayload`, this never triggers a
 * TapTouch fetch, so a read-only GET cannot cause a scrape.
 *
 * @param {object} cache - the server's cache object.
 * @param {{date?: string}} [options] - requested business date (`YYYY-MM-DD`).
 * @param {string} todayKey - today's business date key.
 * @returns {{orders: Array<object>, source: string, fetchedAt: string|null, dateKey: string}} scope.
 */
function resolveOrderScope(cache, options = {}, todayKey) {
  const today = String(todayKey || cache?.data?.ordersDateKey || '');
  const requested = String(options.date || '').trim();

  if (!cache || cache.hasLiveData !== true) {
    return { orders: [], source: 'empty', fetchedAt: null, dateKey: requested || today };
  }

  const raw = cache.raw || {};
  if (!requested || requested === today) {
    return {
      orders: Array.isArray(raw.allOrders) ? raw.allOrders : [],
      source: 'today_live',
      fetchedAt: cache.data?.scrapedAt || cache.lastUpdated || null,
      dateKey: today,
    };
  }

  const entry = raw.ordersByDate?.[requested];
  return {
    orders: Array.isArray(entry?.orders) ? entry.orders : [],
    source: 'date_cache',
    fetchedAt: entry?.fetchedAt || cache.lastUpdated || null,
    dateKey: requested,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildSalesOrdersV1Payload,
  resolveOrderScope,
  withItems,
};

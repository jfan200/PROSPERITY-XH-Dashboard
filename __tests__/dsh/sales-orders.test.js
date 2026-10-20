'use strict';

/**
 * Contract tests for GET /api/v1/sales/orders (JIN-92).
 *
 * Fixtures are produced by the repo's own `mapRawOrdersToApiOrders`, and money is
 * parsed by the repo's own `parseMoneyValue`, so this suite exercises the real
 * mapping rules rather than a hand-written imitation of them.
 */

const {
  mapRawOrdersToApiOrders,
  parseMoneyValue,
} = require('../server-helpers');

const {
  buildSalesOrdersV1Payload,
  resolveOrderScope,
} = require('../../lib/api/salesOrders');

const RAW_ORDER_A = {
  id: 'KI-001',
  txId: '900001',
  source: 'Kiosk',
  type: 'Dine In',
  date: '2026-10-15 12:01',
  cashier: 'A',
  customer: 'C1',
  tax: '$1.50',
  amount: '$16.50',
  status: 'paid',
  detailUrl: 'https://example.test/a',
};

const RAW_ORDER_B = {
  id: 'KI-002',
  txId: '900002',
  source: 'Kiosk',
  type: 'Take Away',
  date: '2026-10-15 12:30',
  cashier: 'B',
  customer: 'C2',
  tax: '$2.00',
  amount: '$22.00',
  status: 'paid',
  detailUrl: 'https://example.test/b',
};

const RAW_ORDER_C = {
  id: 'KI-003',
  txId: '900003',
  source: 'Kiosk',
  type: 'Dine In',
  date: '2026-10-15 13:00',
  cashier: 'C',
  customer: 'C3',
  tax: '$1.00',
  amount: '$11.00',
  status: 'paid',
  detailUrl: 'https://example.test/c',
};

const DETAIL_A = {
  items: [
    { name: '重庆小面（红烧牛肉）', qty: '1', price: '$16.80', subtotal: '$16.80', note: '' },
  ],
  totals: { subtotal: 16.8, total: 16.5, gst: 1.5, surcharge: 0, totalPaid: 16.5 },
};

const MAPPED = mapRawOrdersToApiOrders([RAW_ORDER_A, RAW_ORDER_B, RAW_ORDER_C], {});

module.exports = function register({ assert, assertEqual }) {
  console.log('\n=== /api/v1/sales/orders payload ===\n');

  console.log('pagination:');
  {
    const payload = buildSalesOrdersV1Payload({
      orders: MAPPED,
      orderDetails: {},
      page: 1,
      limit: 2,
      generatedAt: '2026-10-20T00:00:00.000Z',
      parseMoney: parseMoneyValue,
    });
    assertEqual(payload.data.orders.length, 2, 'page 1 with limit 2 returns 2 orders');
    assertEqual(payload.meta.total, 3, 'meta.total counts all matching orders');
    assertEqual(payload.meta.totalPages, 2, 'meta.totalPages is 2');
    assertEqual(payload.meta.page, 1, 'meta.page echoes page 1');
  }
  {
    const payload = buildSalesOrdersV1Payload({
      orders: MAPPED,
      orderDetails: {},
      page: 2,
      limit: 2,
      generatedAt: '2026-10-20T00:00:00.000Z',
      parseMoney: parseMoneyValue,
    });
    assertEqual(payload.data.orders.length, 1, 'page 2 with limit 2 returns the remainder');
    assertEqual(payload.data.orders[0].id, 'KI-003', 'page 2 starts at the third order');
  }

  console.log('\nparameter clamping:');
  {
    const low = buildSalesOrdersV1Payload({ orders: MAPPED, page: 0, limit: 0, parseMoney: parseMoneyValue });
    assertEqual(low.meta.page, 1, 'page 0 clamps to 1');
    assert(low.meta.limit >= 1, 'limit 0 clamps to at least 1');
    const high = buildSalesOrdersV1Payload({ orders: MAPPED, page: 1, limit: 100000, parseMoney: parseMoneyValue });
    assert(high.meta.limit <= 200, 'limit is capped at 200');
  }

  console.log('\nreuse contract:');
  {
    let threw = false;
    try {
      buildSalesOrdersV1Payload({ orders: MAPPED });
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, 'builder refuses to run without the injected parseMoney');
  }

  console.log('\nintegrity:');
  {
    const payload = buildSalesOrdersV1Payload({
      orders: MAPPED.slice(0, 2),
      orderDetails: {},
      page: 1,
      limit: 50,
      generatedAt: '2026-10-20T00:00:00.000Z',
      parseMoney: parseMoneyValue,
    });
    assertEqual(payload.meta.integrity.recordCount, 2, 'recordCount counts the page');
    assertEqual(payload.meta.integrity.totalOrderCount, 2, 'totalOrderCount counts the scope');
    assertEqual(payload.meta.integrity.ordersWithItems, 0, 'no details -> ordersWithItems 0');
    assertEqual(payload.meta.integrity.detailCoveragePct, 0, 'no details -> coverage 0%');
    assertEqual(payload.meta.integrity.hasMissingDetails, true, 'no details -> hasMissingDetails true');
    assertEqual(payload.meta.integrity.generatedAt, '2026-10-20T00:00:00.000Z', 'generatedAt is echoed');
  }
  {
    const withDetail = mapRawOrdersToApiOrders([RAW_ORDER_A], { 900001: DETAIL_A });
    const payload = buildSalesOrdersV1Payload({
      orders: withDetail,
      orderDetails: { 900001: DETAIL_A },
      page: 1,
      limit: 50,
      generatedAt: '2026-10-20T00:00:00.000Z',
      parseMoney: parseMoneyValue,
    });
    assertEqual(payload.meta.integrity.ordersWithItems, 1, 'one detail -> ordersWithItems 1');
    assertEqual(payload.meta.integrity.detailCoveragePct, 100, 'full coverage -> 100%');
    assertEqual(payload.meta.integrity.hasMissingDetails, false, 'full coverage -> hasMissingDetails false');
  }

  console.log('\nline items are numeric:');
  {
    const withDetail = mapRawOrdersToApiOrders([RAW_ORDER_A], {});
    const payload = buildSalesOrdersV1Payload({
      orders: withDetail,
      orderDetails: { 900001: DETAIL_A },
      page: 1,
      limit: 50,
      parseMoney: parseMoneyValue,
    });
    const items = payload.data.orders[0].items;
    assertEqual(items.length, 1, 'order carries its parsed line items');
    assertEqual(items[0].name, '重庆小面（红烧牛肉）', 'item name is preserved');
    assertEqual(typeof items[0].quantity, 'number', 'quantity is a number, not a string');
    assertEqual(items[0].quantity, 1, 'quantity parses to 1');
    assertEqual(typeof items[0].unitPrice, 'number', 'unitPrice is a number');
    assertEqual(items[0].unitPrice, 16.8, 'unitPrice parses to 16.8');
    assertEqual(typeof items[0].lineTotal, 'number', 'lineTotal is a number');
    assertEqual(items[0].lineTotal, 16.8, 'lineTotal parses to 16.8');
  }

  console.log('\norder headers keep the shared mapping:');
  {
    const payload = buildSalesOrdersV1Payload({
      orders: mapRawOrdersToApiOrders([RAW_ORDER_A], {}),
      orderDetails: {},
      page: 1,
      limit: 50,
      parseMoney: parseMoneyValue,
    });
    const order = payload.data.orders[0];
    assertEqual(order.txId, '900001', 'txId is exposed');
    assertEqual(order.type, 'Dine In', 'type is exposed');
    assertEqual(order.amount, '$16.50', 'amount keeps the shared rendered form');
    assertEqual(order.detailCached, false, 'detailCached comes from the shared mapper');
  }

  console.log('\nempty scope:');
  {
    const payload = buildSalesOrdersV1Payload({ orders: [], orderDetails: {}, parseMoney: parseMoneyValue });
    assertEqual(payload.data.orders.length, 0, 'empty scope returns an empty array');
    assertEqual(payload.meta.total, 0, 'empty scope reports total 0');
    assertEqual(payload.meta.totalPages, 0, 'empty scope reports 0 pages');
    assertEqual(payload.meta.integrity.detailCoveragePct, 0, 'empty scope coverage is 0');
  }

  console.log('\nresolveOrderScope (cache-only):');
  {
    const cache = {
      hasLiveData: true,
      lastUpdated: '2026-10-15T10:00:00.000Z',
      data: { ordersDateKey: '2026-10-15', scrapedAt: '2026-10-15T09:59:00.000Z' },
      raw: {
        allOrders: [RAW_ORDER_A],
        ordersByDate: { '2026-10-14': { orders: [RAW_ORDER_B], fetchedAt: '2026-10-14T10:00:00.000Z' } },
        orderDetails: { 900001: DETAIL_A },
      },
    };

    const today = resolveOrderScope(cache, {}, '2026-10-15');
    assertEqual(today.orders.length, 1, 'no date -> today scope uses allOrders');
    assertEqual(today.source, 'today_live', 'today scope is labelled today_live');

    const past = resolveOrderScope(cache, { date: '2026-10-14' }, '2026-10-15');
    assertEqual(past.orders.length, 1, 'explicit past date uses the date cache');
    assertEqual(past.source, 'date_cache', 'past date is labelled date_cache');

    const missing = resolveOrderScope(cache, { date: '2026-10-01' }, '2026-10-15');
    assertEqual(missing.orders.length, 0, 'unknown date yields no orders');
    assertEqual(missing.source, 'date_cache', 'unknown date is still labelled date_cache');

    const offline = resolveOrderScope({ hasLiveData: false, raw: null }, {}, '2026-10-15');
    assertEqual(offline.orders.length, 0, 'no live data yields no orders');
    assertEqual(offline.source, 'empty', 'no live data is labelled empty');
  }
};

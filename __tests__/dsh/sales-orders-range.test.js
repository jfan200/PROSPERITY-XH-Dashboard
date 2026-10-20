'use strict';

/**
 * Range-query contract for GET /api/v1/sales/orders (JIN-92 follow-up).
 *
 * The agent needs ~30 day windows. A range query has one failure mode that a
 * single-day query does not: silently treating a day with **no cached data** as a
 * day with **no sales**. That would turn a scraper gap into a fake revenue drop,
 * so `integrity.missingDates` is part of the contract and is asserted here.
 */

const {
  parseOrderRange,
  resolveOrderScope,
  buildSalesOrdersV1Payload,
  MAX_RANGE_DAYS,
} = require('../../lib/api/salesOrders');

const { mapRawOrdersToApiOrders, parseMoneyValue } = require('../server-helpers');

const ORDER_14 = { id: 'KI-014', txId: '900014', type: 'Dine In', date: '2026-10-14 12:00', amount: '$10.00', status: 'paid' };
const ORDER_15 = { id: 'KI-015', txId: '900015', type: 'Dine In', date: '2026-10-15 12:00', amount: '$20.00', status: 'paid' };

module.exports = function register({ assert, assertEqual }) {
  console.log('\n=== /api/v1/sales/orders range ===\n');

  console.log('parseOrderRange — 合法输入:');
  {
    const r = parseOrderRange({ start: '2026-10-14', end: '2026-10-16' });
    assertEqual(r.ok, true, '合法范围被接受');
    assertEqual(r.mode, 'range', 'mode = range');
    assertEqual(r.days, ['2026-10-14', '2026-10-15', '2026-10-16'], '枚举出 3 天，含首尾');
  }
  {
    const r = parseOrderRange({ date: '2026-10-15' });
    assertEqual(r.ok, true, '单日仍可用');
    assertEqual(r.mode, 'date', 'mode = date');
    assertEqual(r.days, ['2026-10-15'], '单日枚举 1 天');
  }
  {
    const r = parseOrderRange({});
    assertEqual(r.ok, true, '不传参数视为单日模式');
    assertEqual(r.mode, 'date', '缺省 mode = date');
    assertEqual(r.days.length, 0, '不指定日期时不枚举（交给调用方用今天）');
  }

  console.log('\nparseOrderRange — 非法输入:');
  {
    const r = parseOrderRange({ start: '2026-10-16', end: '2026-10-14' });
    assertEqual(r.ok, false, 'start > end 被拒绝');
    assertEqual(r.error.code, 'INVALID_RANGE', '错误码 INVALID_RANGE');
  }
  {
    const r = parseOrderRange({ start: '2026-10-14' });
    assertEqual(r.ok, false, '只给 start 被拒绝');
    assertEqual(r.error.code, 'INVALID_RANGE', '错误码 INVALID_RANGE');
  }
  {
    const r = parseOrderRange({ date: '2026-10-14', start: '2026-10-14', end: '2026-10-15' });
    assertEqual(r.ok, false, 'date 与 range 互斥');
    assertEqual(r.error.code, 'INVALID_RANGE', '错误码 INVALID_RANGE');
  }
  {
    const r = parseOrderRange({ start: '2026-13-01', end: '2026-13-02' });
    assertEqual(r.ok, false, '不存在的月份被拒绝');
    assertEqual(r.error.code, 'INVALID_DATE', '错误码 INVALID_DATE');
  }
  {
    const r = parseOrderRange({ start: '2026-02-30', end: '2026-03-01' });
    assertEqual(r.ok, false, '不存在的日期被拒绝');
    assertEqual(r.error.code, 'INVALID_DATE', '2026-02-30 不是合法日期');
  }
  {
    const r = parseOrderRange({ start: '2026-01-01', end: '2026-12-31' });
    assertEqual(r.ok, false, '超长范围被拒绝');
    assertEqual(r.error.code, 'RANGE_TOO_LONG', '错误码 RANGE_TOO_LONG');
    assert(MAX_RANGE_DAYS >= 31, '上限至少覆盖一个月');
  }

  console.log('\nresolveOrderScope — 范围模式:');
  {
    const cache = {
      hasLiveData: true,
      lastUpdated: '2026-10-15T10:00:00.000Z',
      data: { ordersDateKey: '2026-10-15', scrapedAt: '2026-10-15T09:00:00.000Z' },
      raw: {
        allOrders: [ORDER_15],
        ordersByDate: {
          '2026-10-13': { orders: [], fetchedAt: '2026-10-13T10:00:00.000Z' },
          '2026-10-14': { orders: [ORDER_14], fetchedAt: '2026-10-14T10:00:00.000Z' },
        },
        orderDetails: {},
      },
    };

    const scope = resolveOrderScope(
      cache,
      { days: ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'] },
      '2026-10-15',
    );

    assertEqual(scope.orders.length, 2, '合并 10-14 与今天 10-15 的订单');
    assertEqual(scope.coverage.daysRequested, 4, '请求 4 天');
    assertEqual(scope.coverage.daysWithData, 3, '3 天有数据（含 0 单的 10-13）');
    assertEqual(scope.coverage.missingDates, ['2026-10-16'], '只有 10-16 缺失');
    assertEqual(scope.source, 'mixed', '既有今天也有历史缓存 -> mixed');
  }
  {
    const cache = {
      hasLiveData: true,
      data: { ordersDateKey: '2026-10-15' },
      raw: { allOrders: [], ordersByDate: { '2026-10-14': { orders: [ORDER_14] } } },
    };
    const scope = resolveOrderScope(cache, { days: ['2026-10-14', '2026-10-15'] }, '2026-10-15');
    assertEqual(scope.coverage.missingDates, [], '两天都有缓存 -> 无缺失');
    assertEqual(scope.coverage.daysWithData, 2, '两天都有数据');
  }
  {
    const cache = { hasLiveData: false, raw: null };
    const scope = resolveOrderScope(cache, { days: ['2026-10-14', '2026-10-15'] }, '2026-10-15');
    assertEqual(scope.orders.length, 0, '无实时数据 -> 空');
    assertEqual(scope.source, 'empty', 'source = empty');
    assertEqual(scope.coverage.daysWithData, 0, '无数据日为 0');
  }

  console.log('\nintegrity 携带覆盖信息:');
  {
    const mapped = mapRawOrdersToApiOrders([ORDER_14], {});
    const payload = buildSalesOrdersV1Payload({
      orders: mapped,
      orderDetails: {},
      page: 1,
      limit: 50,
      parseMoney: parseMoneyValue,
      coverage: { daysRequested: 2, daysWithData: 1, missingDates: ['2026-10-16'] },
    });
    assertEqual(payload.meta.integrity.daysRequested, 2, 'integrity.daysRequested');
    assertEqual(payload.meta.integrity.daysWithData, 1, 'integrity.daysWithData');
    assertEqual(payload.meta.integrity.missingDates, ['2026-10-16'], 'integrity.missingDates 暴露缺口');
  }
  {
    const payload = buildSalesOrdersV1Payload({
      orders: mapRawOrdersToApiOrders([ORDER_14], {}),
      orderDetails: {},
      parseMoney: parseMoneyValue,
    });
    assertEqual(payload.meta.integrity.daysRequested, 1, '单日模式缺省 daysRequested = 1');
    assertEqual(payload.meta.integrity.missingDates, [], '单日模式缺省无缺失');
  }
};

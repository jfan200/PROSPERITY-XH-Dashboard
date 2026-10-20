'use strict';

/**
 * Contract tests for merging export-derived orders into the snapshot file.
 *
 * `server.js` never talks to TapTouch directly: it reads `data/scrape-result.json`
 * and reloads on change. So the export path can be added without touching the
 * server, as long as the merge preserves every field it does not own.
 */

const { mergeOrdersIntoSnapshot } = require('../../lib/adapters/taptouch-export');

const ORDER_TODAY_A = { id: 'KT-001', txId: '900001', date: '2026-10-20 12:00', amount: '$10.00' };
const ORDER_TODAY_B = { id: 'KT-002', txId: '900002', date: '2026-10-20 13:00', amount: '$20.00' };
const ORDER_PAST = { id: 'KT-009', txId: '900009', date: '2026-10-19 12:00', amount: '$5.00' };

function baseSnapshot() {
  return {
    allOrders: [{ id: 'OLD-1', txId: '111', date: '2026-10-20 09:00', amount: '$1.00' }],
    orderDetails: { 900001: { items: [] } },
    products: [{ name: 'existing product' }],
    dashData: { keep: true },
    ordersByDate: { '2026-10-18': { orders: [{ id: 'CACHED', txId: '222' }], fetchedAt: 'earlier' } },
    timestamp: 'old-timestamp',
  };
}

module.exports = function register({ assert, assertEqual }) {
  console.log('\n=== snapshot merge (export -> scrape-result.json) ===\n');

  console.log('分组与写入:');
  {
    const next = mergeOrdersIntoSnapshot(
      baseSnapshot(),
      [ORDER_TODAY_A, ORDER_TODAY_B, ORDER_PAST],
      { todayKey: '2026-10-20', now: '2026-10-20T07:00:00.000Z' },
    );

    assertEqual(next.allOrders.length, 2, '今天的订单写进 allOrders');
    assertEqual(next.ordersByDate['2026-10-19'].orders.length, 1, '历史订单写进 ordersByDate');
    assertEqual(next.ordersByDate['2026-10-19'].fetchedAt, '2026-10-20T07:00:00.000Z', '历史条目记录抓取时间');
    assertEqual(next.ordersByDate['2026-10-18'].orders.length, 1, '未涉及的日期保持原样');
    assertEqual(next.allOrders.some((o) => o.id === 'OLD-1'), false, '旧的全量订单被本次结果替换');
  }

  console.log('不越权修改:');
  {
    const snapshot = baseSnapshot();
    const next = mergeOrdersIntoSnapshot(
      snapshot,
      [ORDER_TODAY_A],
      { todayKey: '2026-10-20', now: '2026-10-20T07:00:00.000Z' },
    );

    assertEqual(next.orderDetails, snapshot.orderDetails, 'orderDetails 原样保留');
    assertEqual(next.products, snapshot.products, 'products 原样保留');
    assertEqual(next.dashData, snapshot.dashData, 'dashData 原样保留');
    assert(next.timestamp !== 'old-timestamp', 'timestamp 被刷新');
    assertEqual(snapshot.allOrders.length, 1, '输入快照未被就地修改');
  }

  console.log('边界:');
  {
    const next = mergeOrdersIntoSnapshot(
      baseSnapshot(),
      [ORDER_PAST],
      { todayKey: '2026-10-20', now: '2026-10-20T07:00:00.000Z' },
    );
    assertEqual(next.allOrders.length, 0, '没有今天的订单时 allOrders 为空，而不是保留旧数据');
    assertEqual(next.ordersByDate['2026-10-19'].orders.length, 1, '历史仍写入');
  }
  {
    const snapshot = baseSnapshot();
    const next = mergeOrdersIntoSnapshot(snapshot, [], {
      todayKey: '2026-10-20',
      now: '2026-10-20T07:00:00.000Z',
    });
    assertEqual(next.allOrders.length, 0, '空结果清空 allOrders');
    assertEqual(next.ordersByDate['2026-10-18'].orders.length, 1, '空结果不动历史缓存');
  }
};

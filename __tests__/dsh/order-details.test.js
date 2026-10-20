'use strict';

/**
 * Contract tests for backfilling per-order line items.
 *
 * Coverage is the point: the HTML path only had detail for a fraction of orders,
 * so the agent could not answer "what did each order sell". These helpers make
 * the backfill explicit, bounded and observable.
 */

const {
  selectOrdersNeedingDetails,
  mapWithConcurrency,
  mergeDetailsIntoSnapshot,
} = require('../../lib/adapters/taptouch-export');

module.exports = async function register({ assert, assertEqual }) {
  console.log('\n=== order detail backfill ===\n');

  console.log('缺失筛选:');
  {
    const orders = [
      { id: 'A', txId: '1' },
      { id: 'B', txId: '2' },
      { id: 'C', txId: '3' },
      { id: 'NO-TX' },
    ];
    const details = { 1: { items: [{}] } };

    const need = selectOrdersNeedingDetails(orders, details);
    assertEqual(need.length, 2, '只挑出没有明细的订单');
    assertEqual(need.map((o) => o.txId), ['2', '3'], '顺序保持，且跳过没有 txId 的行');

    const forced = selectOrdersNeedingDetails(orders, details, { force: true });
    assertEqual(forced.length, 3, 'force 时连已有的也重抓');
  }

  console.log('并发执行:');
  {
    let active = 0;
    let peak = 0;
    const worker = async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      if (item === 3) throw new Error('boom');
      return item * 2;
    };

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, worker);
    assertEqual(results.ok.length, 4, '失败项不计入成功');
    assertEqual(results.failed.length, 1, '失败项被单独收集');
    assertEqual(results.failed[0].item, 3, '失败项记录了输入');
    assertEqual(results.ok.map((r) => r.result).sort((a, b) => a - b), [2, 4, 8, 10], '成功项结果正确');
    assert(peak <= 2, `并发不超过上限（实际峰值 ${peak}）`);
  }
  {
    const results = await mapWithConcurrency([], 4, async () => 1);
    assertEqual(results.ok.length, 0, '空输入返回空结果');
  }

  console.log('明细合并:');
  {
    const snapshot = {
      allOrders: [{ id: 'A', txId: '1' }],
      orderDetails: { 9: { items: [{ name: 'old' }] } },
      products: [{ name: 'p' }],
    };
    const fetched = [
      { txId: '1', detail: { items: [{ name: 'x' }], totals: { total: 10 } } },
      { txId: '2', detail: null },
    ];

    const next = mergeDetailsIntoSnapshot(snapshot, fetched, { now: '2026-10-20T08:00:00.000Z' });
    assertEqual(next.orderDetails['1'].items[0].name, 'x', '新明细写入');
    assertEqual(next.orderDetails['9'].items[0].name, 'old', '旧明细保留');
    assertEqual(next.orderDetails['2'], undefined, '抓取失败的订单不写入空值');
    assertEqual(next.products, snapshot.products, '其它字段不受影响');
    assertEqual(snapshot.orderDetails['1'], undefined, '输入快照未被就地修改');
  }
};

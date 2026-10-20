'use strict';

/** /api/v1/sales/products 的 payload 契约。 */

const { buildSalesProductsV1Payload } = require('../../lib/api/salesProducts');

const P = [
  { name: '重庆小面', code: '13', category: '主食', qtySold: 121, netSales: 2004.76, netSalesShare: 21.08, cost: 0, profit: 2004.76 },
  { name: '打包盒', code: '', category: '', qtySold: 10, netSales: 5, netSalesShare: 0.05, cost: 0, profit: 5 },
];

module.exports = function register({ assert, assertEqual }) {
  console.log('\n=== /api/v1/sales/products payload ===\n');

  {
    const r = buildSalesProductsV1Payload({
      products: P,
      range: { start: '2026-10-14', end: '2026-10-20' },
      requested: { start: '2026-10-14', end: '2026-10-20' },
      generatedAt: 'x',
    });
    assertEqual(r.data.products.length, 2, '返回两个商品');
    assertEqual(r.meta.integrity.productCount, 2, 'productCount');
    assertEqual(r.meta.integrity.totalQty, 131, '销量合计');
    assertEqual(r.meta.integrity.totalNetSales, 2009.76, '净销售合计');
    assertEqual(r.meta.integrity.rangeMatchesRequest, true, '范围一致');
    assertEqual(r.meta.start, '2026-10-14', 'meta.start 是数据实际范围');
    assertEqual(r.meta.integrity.hasCostData, false, '成本全为 0 时 hasCostData=false');
  }

  {
    const r = buildSalesProductsV1Payload({
      products: P,
      range: { start: '2026-10-14', end: '2026-10-20' },
      requested: { start: '2026-10-01', end: '2026-10-07' },
    });
    assertEqual(r.meta.integrity.rangeMatchesRequest, false, '请求范围与快照不一致时必须标 false');
    assertEqual(r.meta.start, '2026-10-14', '仍然如实报告实际范围，不伪造');
  }

  {
    const r = buildSalesProductsV1Payload({ products: [] });
    assertEqual(r.data.products.length, 0, '空数据');
    assertEqual(r.meta.integrity.totalNetSales, 0, '空数据合计为 0');
    assertEqual(r.meta.start, null, '无范围时 start 为 null');
  }
};

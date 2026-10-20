'use strict';

/**
 * Pure payload builder for `GET /api/v1/sales/products`.
 *
 * The snapshot holds one aggregate product report from the last sync, so this
 * endpoint cannot honour an arbitrary date range. Rather than silently returning
 * a different period's numbers, it reports the range it actually holds and flags
 * whether that matched the request.
 */

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * @param {object} input
 * @param {Array<object>} [input.products] - normalised products from the product report.
 * @param {{start: string, end: string}|null} [input.range] - range the data covers.
 * @param {{start: string, end: string}|null} [input.requested] - range the caller asked for.
 * @param {string} [input.generatedAt] - ISO timestamp.
 * @returns {{meta: object, data: {products: Array<object>}}} response body.
 */
function buildSalesProductsV1Payload({ products = [], range = null, requested = null, generatedAt } = {}) {
  const list = (Array.isArray(products) ? products : []).map((p) => ({
    name: String(p?.name || ''),
    code: String(p?.code || ''),
    category: String(p?.category || ''),
    qtySold: Number(p?.qtySold) || 0,
    netSales: round2(p?.netSales),
    netSalesShare: Number(p?.netSalesShare) || 0,
    cost: round2(p?.cost),
    profit: round2(p?.profit),
  }));

  const totalQty = list.reduce((sum, p) => sum + p.qtySold, 0);
  const totalNetSales = round2(list.reduce((sum, p) => sum + p.netSales, 0));
  const rangeMatchesRequest = Boolean(
    range && requested && range.start === requested.start && range.end === requested.end,
  );

  return {
    meta: {
      start: range?.start ?? null,
      end: range?.end ?? null,
      generatedAt: generatedAt || new Date().toISOString(),
      integrity: {
        productCount: list.length,
        totalQty,
        totalNetSales,
        hasCostData: list.some((p) => p.cost > 0),
        rangeMatchesRequest,
      },
    },
    data: { products: list },
  };
}

module.exports = { buildSalesProductsV1Payload };

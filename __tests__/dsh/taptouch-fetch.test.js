'use strict';

/**
 * Contract tests for the export download request itself (mock fetch, no network).
 */

const { fetchOrdersExport } = require('../../lib/adapters/taptouch-export');

const XLSX_MAGIC_HEADER = 'attachment; filename="order_test.xlsx"';

// 一个最小合法 zip：只有一个 stored 条目，用于验证 fetch 层会解析 body
function tinyXlsxBuffer() {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'orders-sample.xlsx'));
}

module.exports = async function register({ assert, assertEqual }) {
  console.log('\n=== export download ===\n');

  {
    const calls = [];
    const mockFetch = async (url, options = {}) => {
      calls.push({ url: String(url), headers: options.headers || {}, method: options.method || 'GET' });
      return {
        status: 200,
        ok: true,
        headers: {
          get: (name) => (name.toLowerCase() === 'content-disposition' ? XLSX_MAGIC_HEADER : null),
          getSetCookie: () => [],
        },
        arrayBuffer: async () => tinyXlsxBuffer(),
      };
    };

    const result = await fetchOrdersExport(
      { cookieHeader: 'taptouch_session=x' },
      { start: '2026-10-14', end: '2026-10-20', fetchImpl: mockFetch, baseUrl: 'https://example.test' },
    );

    assertEqual(calls.length, 1, '只发一次请求');
    assert(calls[0].url.includes('_export_=all'), 'URL 带 _export_=all');
    assert(calls[0].url.includes('startdt=2026-10-14T00%3A00%3A00'), 'URL 带 startdt');
    assertEqual(calls[0].headers.cookie, 'taptouch_session=x', '带上会话 cookie');
    assertEqual(result.orders.length, 2, '解析出 2 单（汇总行已剔除）');
    assertEqual(result.filename, 'order_test.xlsx', '从 content-disposition 取文件名');
  }

  {
    const authFail = async () => ({
      status: 419,
      ok: false,
      headers: { get: () => null, getSetCookie: () => [] },
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    let code = '';
    try {
      await fetchOrdersExport(
        { cookieHeader: '' },
        { start: '2026-10-20', end: '2026-10-20', fetchImpl: authFail, baseUrl: 'https://example.test' },
      );
    } catch (error) {
      code = error.code || '';
    }
    assertEqual(code, 'AUTH_EXPIRED', '419 归类为 AUTH_EXPIRED，便于上层重新登录');
  }
};

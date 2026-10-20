'use strict';

/**
 * Contract tests for the browser-free TapTouch export adapter.
 *
 * The scraper currently launches headless Chrome to read HTML. TapTouch's
 * backoffice is laravel-admin and exposes an official spreadsheet export, which
 * only needs two plain HTTP requests (login + download). These tests pin that
 * path down without any network access:
 *
 * - the xlsx reader is exercised against a committed fixture of **fake** data
 * - the login flow is exercised against a mock fetch
 * - the normaliser must drop the trailing totals row the export appends
 */

const fs = require('fs');
const path = require('path');

const {
  readXlsxRows,
  ordersFromExport,
  buildExportQuery,
  loginForCookie,
} = require('../../lib/adapters/taptouch-export');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'orders-sample.xlsx');

module.exports = async function register({ assert, assertEqual }) {
  console.log('\n=== TapTouch export adapter ===\n');

  console.log('xlsx 读取:');
  {
    const rows = readXlsxRows(fs.readFileSync(FIXTURE));
    assertEqual(rows.length, 4, '读到 4 行（含表头）');
    assertEqual(rows[0].length, 13, '表头 13 列');
    assertEqual(rows[0][0], 'Number', '第一列表头是 Number');
    assertEqual(rows[0][8], 'Total Sales($)', '第九列表头是 Total Sales($)');
    assertEqual(rows[1][0], 'KT-001', '第一行数据读得出');
    assertEqual(rows[1][8], '16.50', '金额按文本读出');
  }

  console.log('\n订单归一化:');
  {
    const orders = ordersFromExport(readXlsxRows(fs.readFileSync(FIXTURE)));
    assertEqual(orders.length, 2, '汇总行被剔除，剩 2 单');

    const first = orders[0];
    assertEqual(first.id, 'KT-001', 'id 取 Number');
    assertEqual(first.txId, '900000000000001', 'txId 取 Transaction ID');
    assertEqual(first.source, 'Kiosk', 'source 透传');
    assertEqual(first.type, 'Dine In', 'type 取 Fulfillment Type');
    assertEqual(first.date, '2026-10-20 12:01', 'date 保留原始时间');
    assertEqual(first.cashier, 'Alice', 'cashier 透传');
    assertEqual(first.amount, '$16.50', 'amount 格式化成与既有管线一致的字符串');
    assertEqual(first.tax, '$1.50', 'tax 同样格式化');
    assertEqual(first.status, 'paid', 'status 小写');
    assertEqual(first.discount, 0, 'discount 是数字');
    assertEqual(first.rounding, 0, 'rounding 是数字');
  }

  console.log('\n汇总行识别:');
  {
    const orders = ordersFromExport(readXlsxRows(fs.readFileSync(FIXTURE)));
    assert(
      orders.every((o) => o.id && o.id !== '-' && o.txId && o.txId !== '-'),
      '任何订单都不带汇总行的占位值',
    );
  }

  console.log('\n导出 query 构造:');
  {
    const params = new URLSearchParams(buildExportQuery({ start: '2026-10-14', end: '2026-10-20' }));
    assertEqual(params.get('_export_'), 'all', '_export_=all');
    assertEqual(params.get('_ep_scenario_'), 'default', '_ep_scenario_=default');
    assertEqual(params.get('startdt'), '2026-10-14T00:00:00', 'startdt 起点');
    assertEqual(params.get('enddt'), '2026-10-20T23:59:59', 'enddt 终点');
  }
  {
    const params = new URLSearchParams(buildExportQuery({ start: '2026-10-20', end: '2026-10-20' }));
    assertEqual(params.get('startdt'), '2026-10-20T00:00:00', '单日查询起点为当天零点');
    assertEqual(params.get('enddt'), '2026-10-20T23:59:59', '单日查询终点为当天末刻');
  }

  console.log('\n登录流程（mock fetch，无网络）:');
  {
    const calls = [];
    const mockFetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: String(options.body || '') });
      if (!options.method || options.method === 'GET') {
        return {
          status: 200,
          headers: { getSetCookie: () => ['taptouch_session=abc123; Path=/; HttpOnly'] },
          text: async () => '<form><input type="hidden" name="_token" value="tok-xyz"></form>',
        };
      }
      return {
        status: 200,
        headers: { getSetCookie: () => ['taptouch_session=abc123; Path=/'] },
        text: async () => 'ok',
      };
    };

    const result = await loginForCookie({
      baseUrl: 'https://example.test',
      account: 'someone@example.test',
      password: 'secret',
      fetchImpl: mockFetch,
    });

    assertEqual(calls.length, 2, '先 GET 表单再 POST 登录，共 2 次请求');
    assertEqual(calls[0].method, 'GET', '第一次是 GET');
    assertEqual(calls[1].method, 'POST', '第二次是 POST');
    assert(calls[1].body.includes('_token=tok-xyz'), 'POST 带上从表单取到的 _token');
    assert(calls[1].body.includes('account=someone%40example.test'), 'POST 带上账号（已编码）');
    assert(calls[1].body.includes('password=secret'), 'POST 带上密码');
    assertEqual(result.cookieHeader, 'taptouch_session=abc123', '从 set-cookie 组装 cookie 头');
  }
  {
    const failingFetch = async () => ({
      status: 200,
      headers: { getSetCookie: () => [] },
      text: async () => '<form>没有 token 字段</form>',
    });

    let threw = false;
    try {
      await loginForCookie({
        baseUrl: 'https://example.test',
        account: 'a',
        password: 'b',
        fetchImpl: failingFetch,
      });
    } catch (error) {
      threw = /token/i.test(error.message);
    }
    assert(threw, '表单里没有 _token 时明确报错');
  }
};

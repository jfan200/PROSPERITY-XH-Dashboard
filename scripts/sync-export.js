#!/usr/bin/env node
'use strict';

/**
 * Sync TapTouch orders into data/scrape-result.json using the spreadsheet export.
 *
 * This is the opt-in alternative to the Puppeteer scraper. `server.js` is not
 * changed: it already reloads the snapshot when the file changes.
 *
 *   node scripts/sync-export.js                 # today only
 *   node scripts/sync-export.js --days 7        # last 7 days incl. today
 *   node scripts/sync-export.js --dry-run       # report, write nothing
 *   node scripts/sync-export.js --snapshot /path/to/scrape-result.json
 *   node scripts/sync-export.js --days 7 --details          # also backfill line items
 *   node scripts/sync-export.js --details --detail-max 50   # bounded batch
 *
 * Credentials are read from .env.local (TAPTOUCH_EMAIL / TAPTOUCH_PASSWORD).
 * Nothing is printed that could leak them.
 *
 * Caveat: export rows carry no per-order detail URL, so this path cannot fetch
 * receipt line items. Existing `orderDetails` entries are preserved untouched.
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const {
  loginForCookie,
  fetchOrdersExport,
  mergeOrdersIntoSnapshot,
  selectOrdersNeedingDetails,
  mapWithConcurrency,
  mergeDetailsIntoSnapshot,
  fetchProductsExport,
} = require(path.join(APP_ROOT, 'lib/adapters/taptouch-export'));
const { fetchSingleOrderDetailWithSession } = require(path.join(APP_ROOT, 'scraper.js'));

const BASE = process.env.TAPTOUCH_BASE_URL || 'https://backoffice.taptouch.net';

function parseArgs(argv) {
  const args = {
    days: 1,
    dryRun: false,
    details: false,
    detailMax: 0,
    detailConcurrency: 4,
    forceDetails: false,
    products: false,
    snapshot: path.join(APP_ROOT, 'data', 'scrape-result.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--details') args.details = true;
    else if (arg === '--products') args.products = true;
    else if (arg === '--force-details') { args.details = true; args.forceDetails = true; }
    else if (arg === '--detail-max') args.detailMax = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--detail-concurrency') args.detailConcurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (arg === '--days') args.days = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--snapshot') args.snapshot = argv[++i];
    else if (arg === '--help') {
      console.log('用法: node scripts/sync-export.js [--days N] [--dry-run] [--snapshot PATH]');
      process.exit(0);
    }
  }
  return args;
}

function loadEnv() {
  const env = {};
  for (const file of ['.env', '.env.local']) {
    const full = path.join(APP_ROOT, file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function dateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const account = process.env.TAPTOUCH_EMAIL || env.TAPTOUCH_EMAIL || '';
  const password = process.env.TAPTOUCH_PASSWORD || env.TAPTOUCH_PASSWORD || '';
  if (!account || !password) {
    console.error('✗ 未配置 TAPTOUCH_EMAIL / TAPTOUCH_PASSWORD');
    process.exit(1);
  }

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (args.days - 1));
  const startKey = dateKey(start);
  const endKey = dateKey(today);

  console.log(`[export] 登录 ${BASE}`);
  const session = await loginForCookie({ baseUrl: BASE, account, password });

  console.log(`[export] 拉取 ${startKey} .. ${endKey}`);
  const result = await fetchOrdersExport(session, { start: startKey, end: endKey });
  console.log(`[export] 订单 ${result.orders.length} 单，文件名 ${result.filename || '(未提供)'}`);

  const revenue = result.orders.reduce((sum, o) => sum + Number(String(o.amount).replace(/[^0-9.-]/g, '')), 0);
  console.log(`[export] 营业额合计 $${revenue.toFixed(2)}`);

  if (!fs.existsSync(args.snapshot)) {
    console.error(`✗ 找不到快照: ${args.snapshot}`);
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'));
  const merged = mergeOrdersIntoSnapshot(snapshot, result.orders, {
    todayKey: endKey,
    now: new Date().toISOString(),
  });

  console.log(`[export] allOrders: ${(snapshot.allOrders || []).length} -> ${merged.allOrders.length}`);
  console.log(`[export] ordersByDate 天数: ${Object.keys(snapshot.ordersByDate || {}).length} -> ${Object.keys(merged.ordersByDate).length}`);

  let finalSnapshot = merged;
  if (args.details) {
    const missing = selectOrdersNeedingDetails(result.orders, merged.orderDetails, { force: args.forceDetails });
    const todo = args.detailMax > 0 ? missing.slice(0, args.detailMax) : missing;
    console.log(`[export] 缺明细 ${missing.length} 单，本次抓取 ${todo.length} 单（并发 ${args.detailConcurrency}）`);

    if (todo.length > 0) {
      const started = Date.now();
      let done = 0;
      const outcome = await mapWithConcurrency(todo, args.detailConcurrency, async (order) => {
        const detail = await fetchSingleOrderDetailWithSession(
          { cookieHeader: session.cookieHeader },
          { txId: order.txId, id: order.id, amount: order.amount },
        );
        if (!detail) throw new Error('empty detail');
        done += 1;
        if (done % 20 === 0) console.log(`[export]   已抓 ${done}/${todo.length}`);
        return detail;
      });

      const fetched = outcome.ok.map((entry) => ({ txId: entry.item.txId, detail: entry.result }));
      finalSnapshot = mergeDetailsIntoSnapshot(merged, fetched, { now: new Date().toISOString() });
      console.log(`[export] 明细成功 ${outcome.ok.length}，失败 ${outcome.failed.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (outcome.failed.length > 0) {
        console.log(`[export]   失败示例: ${outcome.failed[0].error}`);
      }
      console.log(`[export] orderDetails: ${Object.keys(merged.orderDetails || {}).length} -> ${Object.keys(finalSnapshot.orderDetails).length}`);
    }
  }

  if (args.products) {
    try {
      const prod = await fetchProductsExport(session, { start: startKey, end: endKey });
      finalSnapshot = { ...finalSnapshot, productSales: prod.products, productSalesRange: { start: startKey, end: endKey }, productSalesUpdatedAt: new Date().toISOString() };
      const totalQty = prod.products.reduce((s, p) => s + p.qtySold, 0);
      const totalProfit = prod.products.reduce((s, p) => s + p.profit, 0);
      console.log(`[export] 商品报表: ${prod.products.length} 个商品，销量 ${totalQty}，利润 $${totalProfit.toFixed(2)}`);
      prod.products.slice(0, 3).forEach((p) => console.log(`[export]   ${p.name.slice(0, 28)}  x${p.qtySold}  利润 $${p.profit}`));
    } catch (error) {
      console.error('[export] 商品报表失败（不影响订单写入）:', error.message);
    }
  }

  if (args.dryRun) {
    console.log('[export] --dry-run，不写入');
    return;
  }

  fs.writeFileSync(args.snapshot, `${JSON.stringify(finalSnapshot, null, 2)}\n`, 'utf8');
  console.log(`[export] 已写入 ${args.snapshot}`);
  console.log('[export] server.js 检测到文件变化会自动重载');
}

main().catch((error) => {
  console.error('✗ 同步失败:', error.message);
  process.exit(1);
});

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
} = require(path.join(APP_ROOT, 'lib/adapters/taptouch-export'));

const BASE = process.env.TAPTOUCH_BASE_URL || 'https://backoffice.taptouch.net';

function parseArgs(argv) {
  const args = { days: 1, dryRun: false, snapshot: path.join(APP_ROOT, 'data', 'scrape-result.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
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

  if (args.dryRun) {
    console.log('[export] --dry-run，不写入');
    return;
  }

  fs.writeFileSync(args.snapshot, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(`[export] 已写入 ${args.snapshot}`);
  console.log('[export] server.js 检测到文件变化会自动重载');
}

main().catch((error) => {
  console.error('✗ 同步失败:', error.message);
  process.exit(1);
});

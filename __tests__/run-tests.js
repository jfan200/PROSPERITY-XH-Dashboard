'use strict';

const {
  round2,
  parseMoneyValue,
  parseLocalDateTime,
  formatDateKey,
  startOfWeekMonday,
  formatRangeLabel,
  getTodayDateKey,
  buildDayRange,
  isSummaryLikeOrder,
  mapRawOrdersToApiOrders,
  buildOrdersDataset,
  buildEmptyWeeklyOverview,
  buildEmptyDashboardData,
} = require('./server-helpers');

const {
  parseReceiptDetail,
} = require('../scraper');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const condition = JSON.stringify(actual) === JSON.stringify(expected);
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('\n=== Server Helpers Tests ===\n');

console.log('round2:');
assertEqual(round2(10.123), 10.12, 'round2(10.123) = 10.12');
assertEqual(round2(10.125), 10.13, 'round2(10.125) = 10.13');
assertEqual(round2(0), 0, 'round2(0) = 0');
assertEqual(round2(null), 0, 'round2(null) = 0');

console.log('\nparseMoneyValue:');
assertEqual(parseMoneyValue('$10.50'), 10.5, 'parseMoneyValue("$10.50") = 10.5');
assertEqual(parseMoneyValue('$1,234.56'), 1234.56, 'parseMoneyValue("$1,234.56") = 1234.56');
assertEqual(parseMoneyValue(''), 0, 'parseMoneyValue("") = 0');

console.log('\nparseLocalDateTime:');
const dt = parseLocalDateTime('2026-06-05 12:30:00');
assert(dt instanceof Date, 'parseLocalDateTime returns Date');
assertEqual(dt.getFullYear(), 2026, 'year is 2026');
assertEqual(dt.getMonth(), 5, 'month is 5 (June)');
assertEqual(dt.getDate(), 5, 'day is 5');
assertEqual(parseLocalDateTime(''), null, 'empty string returns null');

console.log('\nformatDateKey:');
assertEqual(formatDateKey(new Date(2026, 5, 5)), '2026-06-05', 'formatDateKey works');

console.log('\nstartOfWeekMonday:');
const monday = startOfWeekMonday(new Date(2026, 5, 5)); // Thursday
assertEqual(monday.getDay(), 1, 'returns Monday');
assertEqual(monday.getDate(), 1, 'June 1');

console.log('\nformatRangeLabel:');
assertEqual(
  formatRangeLabel(new Date(2026, 5, 1), new Date(2026, 5, 7)),
  'Jun 1 - 7',
  'same month range'
);

console.log('\nbuildDayRange:');
const range = buildDayRange('2026-06-05');
assertEqual(range.start.getHours(), 0, 'start hour is 0');
assertEqual(range.end.getHours(), 23, 'end hour is 23');
assertEqual(range.end.getMinutes(), 59, 'end minute is 59');

console.log('\nisSummaryLikeOrder:');
assertEqual(isSummaryLikeOrder({ id: 'Total' }), true, 'Total is summary');
assertEqual(isSummaryLikeOrder({ id: 'Subtotal' }), true, 'Subtotal is summary');
assertEqual(isSummaryLikeOrder({ id: '' }), true, 'empty id is summary');
assertEqual(isSummaryLikeOrder(null), true, 'null is summary');
assertEqual(isSummaryLikeOrder({ id: 'KI-001', txId: '12345678', amount: '$35.00' }), false, 'real order is not summary');

console.log('\nmapRawOrdersToApiOrders:');
const orders = mapRawOrdersToApiOrders([
  { id: 'KI-001', txId: '12345678', source: 'POS', type: 'Dine In', date: '2026-06-05 12:30', amount: '$35.00', status: 'paid' },
  { id: 'Total', txId: '', amount: '$35.00' },
]);
assertEqual(orders.length, 1, 'filters out summary orders');
assertEqual(orders[0].id, 'KI-001', 'preserves order id');

console.log('\nbuildOrdersDataset:');
const dataset = buildOrdersDataset([
  { id: 'KI-001', txId: '12345678', amount: '$35.00', date: '2026-06-05 12:30' },
  { id: 'KI-002', txId: '12345679', amount: '$28.50', date: '2026-06-05 13:15' },
], { dateKey: '2026-06-05' });
assertEqual(dataset.totalOrders, 2, 'totalOrders is 2');
assertEqual(dataset.totalRevenue, 63.5, 'totalRevenue is 63.5');
assertEqual(dataset.avgTicket, 31.75, 'avgTicket is 31.75');

console.log('\nbuildEmptyWeeklyOverview:');
const weekly = buildEmptyWeeklyOverview(new Date(2026, 5, 5));
assertEqual(weekly.totalRevenue, 0, 'totalRevenue is 0');
assertEqual(weekly.daily.length, 7, 'has 7 days');
assertEqual(weekly.daily[0].label, 'Mon', 'first day is Mon');

console.log('\nbuildEmptyDashboardData:');
const dash = buildEmptyDashboardData(new Date(2026, 5, 5));
assertEqual(dash.storeName, 'PROSPERITY XH', 'storeName is PROSPERITY XH');
assertEqual(dash.totalRevenue, 0, 'totalRevenue is 0');

console.log('\n=== Scraper Tests ===\n');

console.log('parseReceiptDetail:');
const mockOrder = {
  id: 'KI-001',
  txId: '12345678',
  date: '2026-06-05 12:30',
  type: 'Dine In',
};

const receiptText = `
  Transaction Receipt
  Order Time: 2026-06-05 12:30
  Fulfillment: Dine In
  Transaction Id: 12345678
  
  Item Name Qty Price($)
  重庆小面 2 $24.00
  酸辣粉 1 $12.00
  + 加蛋 x 2 $4.00
  
  Sub-Total $40.00
  GST Included In Total $3.64
  Surcharge $0.00
  Card $40.00
  Total Paid $40.00
`;

const receipt = parseReceiptDetail(receiptText, mockOrder, 'https://example.com/receipt');
assertEqual(receipt.orderId, 'KI-001', 'orderId is KI-001');
assertEqual(receipt.txId, '12345678', 'txId is 12345678');
assert(receipt.items.length === 2, 'has 2 items');
assertEqual(receipt.items[0].name, '重庆小面', 'first item is 重庆小面');
assertEqual(receipt.items[1].name, '酸辣粉', 'second item is 酸辣粉');
assert(receipt.items[1].note.includes('加蛋'), 'second item has addon note');
assertEqual(receipt.totals.subtotal, 40, 'subtotal is 40');
assertEqual(receipt.totals.gst, 3.64, 'gst is 3.64');
assertEqual(receipt.payment.card, 40, 'card payment is 40');
assertEqual(receipt.payment.cash, 0, 'cash payment is 0');

const compactReceiptText = 'Transaction Receipt Receipt Receipt Foodie Fair The Glen 食集-重庆小面 https://spicynoodlesglen.lifeintouch.net ABN: 35 623 264 148 Phone: +61432201585 Address: 74-76 Kingsway, Glen Waverley, VIC, 3150 Customer: 278 Fulfillment: Dine In Order Time: Sat 06 Jun 2026 13:27 Transaction Id: 214658693660433 Item Name Price($) 老麻抄手(10pcs)Numbing Mala Wontons 1 16.80 + 不辣Not Spicy x 1 0.00 + 只要葱花(Scallions Only) x 1 0.00 老麻抄手(10pcs)Numbing Mala Wontons 1 16.80 + 不辣Not Spicy x 1 0.00 + 只要葱花(Scallions Only) x 1 0.00 Sub-Total 33.60 Total $33.60 GST Included In Total $3.05 Flexible $33.60 Total Paid $33.60 Reward Points: 0, Available Points: 0 Credit Balance: $0.00';
const compactReceipt = parseReceiptDetail(compactReceiptText, {
  ...mockOrder,
  id: 'KI-026',
  txId: '214658693660433',
  amount: '$33.60',
}, 'https://example.com/compact');
assert(compactReceipt.items.length === 2, 'compact receipt has 2 parsed items');
assert(compactReceipt.items[0].name.includes('老麻抄手'), 'compact receipt parses first item name');
assert(compactReceipt.items[0].note.includes('不辣'), 'compact receipt preserves addon notes');
assertEqual(compactReceipt.totals.subtotal, 33.6, 'compact receipt subtotal is 33.6');
assertEqual(compactReceipt.totals.totalPaid, 33.6, 'compact receipt totalPaid is 33.6');

console.log('\n=== Results ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}

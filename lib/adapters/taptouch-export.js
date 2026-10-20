'use strict';

/**
 * Browser-free TapTouch data adapter.
 *
 * TapTouch's backoffice is a laravel-admin application: it has no public JSON API
 * (`/api/*`, `/swagger`, `/openapi.json` all 404), but laravel-admin ships an
 * official spreadsheet export. That export is the best machine-readable surface
 * it offers, and it needs exactly two plain HTTP requests:
 *
 *   1. GET  /auth/login            -> session cookie + hidden `_token`
 *   2. POST /auth/login            -> authenticated session
 *   3. GET  /store/report/orders?_export_=all&startdt=..&enddt=..  -> .xlsx
 *
 * This replaces launching headless Chrome and parsing HTML. The output is shaped
 * like the rows `scraper.js` produces, so `mapRawOrdersToApiOrders`,
 * `buildOrdersDataset` and the rest of the pipeline work unchanged.
 *
 * Parsing xlsx without a dependency: an .xlsx is a zip of XML parts, and this
 * module reads the zip central directory directly and inflates the parts it
 * needs. That keeps the dependency list unchanged.
 *
 * @module prosperityxh/adapters/taptouch-export
 */

const zlib = require('zlib');

// ─────────────────────────────────────────────────────────────────────────────
// zip
// ─────────────────────────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Read a zip archive into a map of entry name → content.
 *
 * Supports the two compression methods an xlsx may use: stored (0) and deflate
 * (8). Anything else is reported rather than silently skipped.
 *
 * @param {Buffer} buffer - the whole archive.
 * @returns {Map<string, Buffer>} entry contents by name.
 */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip archive: end of central directory not found');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('corrupt zip: bad central directory signature');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data));
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// xlsx
// ─────────────────────────────────────────────────────────────────────────────

/** Column letters (`A`, `B`, …, `AA`) to a zero-based index. */
function columnIndex(reference) {
  const letters = String(reference || '').replace(/[^A-Z]/gi, '').toUpperCase();
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return letters ? index - 1 : -1;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of every `<t>` inside a fragment, concatenated (rich-text runs). */
function textOf(fragment) {
  const parts = [];
  for (const match of String(fragment || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
    parts.push(decodeEntities(match[1]));
  }
  return parts.join('');
}

/**
 * Parse `xl/sharedStrings.xml` into an array of strings.
 * @param {string} xml - part contents.
 * @returns {Array<string>} shared strings by index.
 */
function parseSharedStrings(xml) {
  const strings = [];
  for (const match of String(xml || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    strings.push(textOf(match[1]));
  }
  return strings;
}

/**
 * Parse one worksheet into a dense grid of strings.
 * @param {string} xml - `xl/worksheets/sheetN.xml` contents.
 * @param {Array<string>} shared - shared strings.
 * @returns {Array<Array<string>>} rows of cell text.
 */
function parseWorksheet(xml, shared) {
  const rows = [];
  for (const rowMatch of String(xml || '').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    let cursor = 0;
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const refMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const index = refMatch ? columnIndex(refMatch[1]) : cursor;
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';

      let value = '';
      if (type === 'inlineStr') {
        value = textOf(inner);
      } else if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        const position = Number(v);
        value = Number.isInteger(position) ? (shared[position] ?? '') : '';
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        value = v === undefined ? '' : decodeEntities(v);
      }

      if (index >= 0) {
        while (row.length < index) row.push('');
        row[index] = value;
        cursor = index + 1;
      } else {
        row.push(value);
        cursor = row.length;
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Read the first worksheet of an xlsx file as a grid of strings.
 * @param {Buffer} buffer - the .xlsx contents.
 * @returns {Array<Array<string>>} rows of cell text, header first.
 */
function readXlsxRows(buffer) {
  const entries = readZip(buffer);

  const sharedPart = entries.get('xl/sharedStrings.xml');
  const shared = sharedPart ? parseSharedStrings(sharedPart.toString('utf8')) : [];

  const sheetName = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (!sheetName) throw new Error('not an xlsx file: no worksheet part found');

  return parseWorksheet(entries.get(sheetName).toString('utf8'), shared);
}

// ─────────────────────────────────────────────────────────────────────────────
// normalisation
// ─────────────────────────────────────────────────────────────────────────────

/** Columns of the order export, by header text. */
const ORDER_COLUMNS = {
  id: 'Number',
  txId: 'Transaction ID',
  source: 'Source',
  type: 'Fulfillment Type',
  date: 'Date',
  cashier: 'Cashier',
  customer: 'Customer',
  tax: 'Tax($)',
  amount: 'Total Sales($)',
  discount: 'Discount($)',
  redeemPoints: 'Redeem Points($)',
  rounding: 'Rounding($)',
  status: 'Status',
};

function toNumber(value) {
  const parsed = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Render a money cell the way the rest of the pipeline expects (`$16.50`). */
function toMoneyText(value) {
  return `$${toNumber(value).toFixed(2)}`;
}

/** Map header text to column index, tolerating order changes. */
function headerIndex(header) {
  const index = {};
  const normalised = header.map((cell) => String(cell || '').trim());
  for (const [key, title] of Object.entries(ORDER_COLUMNS)) {
    const position = normalised.indexOf(title);
    if (position !== -1) index[key] = position;
  }
  return index;
}

/**
 * Convert order-export rows into the row shape `scraper.js` produces.
 *
 * The export appends a totals row whose `Number` and `Transaction ID` are `-`;
 * that row must never reach the pipeline, or it becomes a fake order.
 *
 * @param {Array<Array<string>>} rows - grid from {@link readXlsxRows}.
 * @returns {Array<object>} raw orders (`id`, `txId`, `amount`, …).
 */
function ordersFromExport(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const index = headerIndex(rows[0]);

  if (index.id === undefined || index.txId === undefined) {
    throw new Error('unexpected order export: missing Number / Transaction ID columns');
  }

  const orders = [];
  for (const row of rows.slice(1)) {
    if (!row) continue;
    const id = String(row[index.id] ?? '').trim();
    const txId = String(row[index.txId] ?? '').trim();
    if (!id || id === '-' || !txId || txId === '-') continue;

    orders.push({
      id,
      txId,
      source: String(row[index.source] ?? '').trim(),
      type: String(row[index.type] ?? '').trim(),
      date: String(row[index.date] ?? '').trim(),
      cashier: String(row[index.cashier] ?? '').trim() || '-',
      customer: String(row[index.customer] ?? '').trim() || '-',
      tax: toMoneyText(row[index.tax]),
      amount: toMoneyText(row[index.amount]),
      status: String(row[index.status] ?? 'paid').trim().toLowerCase() || 'paid',
      discount: toNumber(row[index.discount]),
      redeemPoints: toNumber(row[index.redeemPoints]),
      rounding: toNumber(row[index.rounding]),
    });
  }
  return orders;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the query string that asks laravel-admin to export a date range.
 * @param {{start: string, end: string}} range - inclusive `YYYY-MM-DD` bounds.
 * @returns {string} query string (no leading `?`).
 */
function buildExportQuery({ start, end }) {
  return new URLSearchParams({
    _export_: 'all',
    _ep_scenario_: 'default',
    startdt: `${start}T00:00:00`,
    enddt: `${end}T23:59:59`,
  }).toString();
}

/** Collect `set-cookie` name/value pairs into a jar. */
function absorbCookies(response, jar) {
  const header = response?.headers;
  const list = typeof header?.getSetCookie === 'function'
    ? header.getSetCookie()
    : [header?.get?.('set-cookie')].filter(Boolean);
  for (const raw of list || []) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Pull the hidden CSRF token out of the login form. */
function extractToken(html) {
  const match = /name="_token"[^>]*value="([^"]*)"/.exec(String(html || ''));
  return match ? match[1] : '';
}

/**
 * Log in with two plain requests: fetch the form, then post it back with the
 * CSRF token. No browser required.
 *
 * @param {object} options
 * @param {string} options.baseUrl - origin, e.g. `https://backoffice.taptouch.net`.
 * @param {string} options.account - login account.
 * @param {string} options.password - login password.
 * @param {Function} [options.fetchImpl] - fetch-compatible function (injectable for tests).
 * @param {string} [options.loginPath] - login route, default `/auth/login`.
 * @returns {Promise<{cookieHeader: string, token: string}>} the session.
 */
async function loginForCookie({
  baseUrl,
  account,
  password,
  fetchImpl = fetch,
  loginPath = '/auth/login',
}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${loginPath}`;
  const jar = new Map();

  const formResponse = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  absorbCookies(formResponse, jar);

  const html = await formResponse.text();
  const token = extractToken(html);
  if (!token) {
    const error = new Error('login form does not contain a _token field');
    error.code = 'LOGIN_TOKEN_MISSING';
    throw error;
  }

  const body = new URLSearchParams({ _token: token, account, password }).toString();
  const loginResponse = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
    },
    body,
    redirect: 'manual',
  });
  absorbCookies(loginResponse, jar);

  if (loginResponse.status >= 400) {
    const error = new Error(`login rejected with HTTP ${loginResponse.status}`);
    error.code = 'LOGIN_FAILED';
    error.status = loginResponse.status;
    throw error;
  }

  return { cookieHeader: cookieHeader(jar), token };
}


// ─────────────────────────────────────────────────────────────────────────────
// snapshot merge
// ─────────────────────────────────────────────────────────────────────────────

/** Business date of an order row, or '' when it has none. */
function dateKeyOf(order) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(order?.date || order?.dateTime || ''));
  return match ? match[1] : '';
}

/**
 * Merge export-derived orders into the snapshot `server.js` reads.
 *
 * The server owns the file: it reloads on change and treats `allOrders` as today
 * and `ordersByDate` as history. This function therefore writes exactly those two
 * fields, stamps `timestamp`, and copies everything else through untouched —
 * `orderDetails`, `products` and `dashData` still come from the HTML path.
 *
 * The input snapshot is never mutated.
 *
 * @param {object} snapshot - current `data/scrape-result.json` contents.
 * @param {Array<object>} orders - normalised orders from {@link ordersFromExport}.
 * @param {{todayKey: string, now?: string}} options - which date is "today".
 * @returns {object} a new snapshot.
 */
function mergeOrdersIntoSnapshot(snapshot = {}, orders = [], { todayKey, now } = {}) {
  const today = String(todayKey || '');
  const stamp = now || new Date().toISOString();

  const groups = new Map();
  for (const order of orders) {
    const key = dateKeyOf(order);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }

  const nextOrdersByDate = { ...(snapshot.ordersByDate || {}) };
  let todayOrders = [];

  for (const [key, list] of groups) {
    if (key === today) {
      todayOrders = list;
      continue;
    }
    nextOrdersByDate[key] = { orders: list, fetchedAt: stamp };
  }

  return {
    ...snapshot,
    allOrders: todayOrders,
    ordersByDate: nextOrdersByDate,
    timestamp: stamp,
  };
}


/**
 * Download and normalise the order export for a date range.
 *
 * @param {{cookieHeader: string}} session - from {@link loginForCookie}.
 * @param {object} options
 * @param {string} options.start - inclusive `YYYY-MM-DD`.
 * @param {string} options.end - inclusive `YYYY-MM-DD`.
 * @param {string} [options.baseUrl] - origin.
 * @param {Function} [options.fetchImpl] - fetch-compatible function.
 * @param {string} [options.reportPath] - report route, default `/store/report/orders`.
 * @returns {Promise<{orders: Array<object>, filename: string, bytes: number}>} normalised orders.
 */
async function fetchOrdersExport(session, {
  start,
  end,
  baseUrl = 'https://backoffice.taptouch.net',
  fetchImpl = fetch,
  reportPath = '/store/report/orders',
}) {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const url = `${origin}${reportPath}?${buildExportQuery({ start, end })}`;

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*;q=0.8',
      cookie: session?.cookieHeader || '',
      referer: `${origin}${reportPath}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    redirect: 'follow',
  });

  if (response.status === 419 || response.status === 401) {
    const error = new Error('TapTouch session expired (HTTP ' + response.status + ')');
    error.code = 'AUTH_EXPIRED';
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`TapTouch export failed (HTTP ${response.status})`);
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const disposition = (response.headers?.get?.('content-disposition')) || '';
  const nameMatch = /filename="?([^";]+)"?/i.exec(disposition);

  return {
    orders: ordersFromExport(readXlsxRows(buffer)),
    filename: nameMatch ? nameMatch[1] : '',
    bytes: buffer.length,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// order detail backfill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orders that still have no cached line items.
 *
 * @param {Array<object>} orders - orders in scope.
 * @param {object} orderDetails - existing cache keyed by txId.
 * @param {{force?: boolean}} [options] - `force` re-fetches even if present.
 * @returns {Array<object>} orders needing a detail fetch.
 */
function selectOrdersNeedingDetails(orders = [], orderDetails = {}, { force = false } = {}) {
  const cache = orderDetails || {};
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const key = String(order?.txId || '').trim();
    if (!key) return false;
    if (force) return true;
    return !cache[key];
  });
}

/**
 * Run an async worker over items with a bounded number in flight.
 *
 * A failure never aborts the batch: it is reported alongside its input so the
 * caller can retry just those.
 *
 * @param {Array<*>} items - inputs.
 * @param {number} limit - max concurrent workers.
 * @param {(item: *) => Promise<*>} worker - per-item task.
 * @returns {Promise<{ok: Array<{item: *, result: *}>, failed: Array<{item: *, error: string}>}>} outcome.
 */
async function mapWithConcurrency(items = [], limit = 4, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  const ok = [];
  const failed = [];
  let cursor = 0;

  async function run() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      const item = list[index];
      try {
        ok.push({ item, result: await worker(item, index) });
      } catch (error) {
        failed.push({ item, error: (error && error.message) || String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
  return { ok, failed };
}

/**
 * Merge fetched details into the snapshot cache.
 *
 * Orders whose fetch returned nothing are left out rather than written as empty,
 * so a transient failure cannot masquerade as "this order had no items".
 *
 * @param {object} snapshot - current snapshot.
 * @param {Array<{txId: string, detail: object|null}>} fetched - results.
 * @param {{now?: string}} [options] - options.
 * @returns {object} new snapshot.
 */
function mergeDetailsIntoSnapshot(snapshot = {}, fetched = [], { now } = {}) {
  const nextDetails = { ...(snapshot.orderDetails || {}) };
  let written = 0;
  for (const entry of fetched) {
    const key = String(entry?.txId || '').trim();
    if (!key || !entry?.detail) continue;
    nextDetails[key] = entry.detail;
    written += 1;
  }
  return {
    ...snapshot,
    orderDetails: nextDetails,
    detailUpdatedAt: now || new Date().toISOString(),
    detailWritten: written,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// report exports (orders / products)
// ─────────────────────────────────────────────────────────────────────────────

/** Report routes on the backoffice. */
const REPORT_PATHS = {
  orders: '/store/report/orders',
  products: '/store/report/product',
};

/** Columns of the product export, by header text. */
const PRODUCT_COLUMNS = {
  name: 'Name',
  variant: 'Variant',
  code: 'Code',
  category: 'Category',
  qtySold: 'Total Quantity Sold',
  netSales: 'Total Net Sales($)',
  netSalesShare: 'Net Sales Share(%)',
  cost: 'Total Cost($)',
  profit: 'Total Profit($)',
};

/**
 * Convert product-report rows into normalised products.
 *
 * The product report is the answer to "what sells": it aggregates quantity,
 * revenue, cost and profit per product, which per-order line items cannot give
 * directly.
 *
 * @param {Array<Array<string>>} rows - grid from {@link readXlsxRows}.
 * @returns {Array<object>} normalised products.
 */
function productsFromExport(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const header = (rows[0] || []).map((c) => String(c || '').trim());
  const index = {};
  for (const [key, title] of Object.entries(PRODUCT_COLUMNS)) {
    const at = header.indexOf(title);
    if (at !== -1) index[key] = at;
  }
  if (index.name === undefined) {
    throw new Error('unexpected product export: missing Name column');
  }

  const products = [];
  for (const row of rows.slice(1)) {
    const name = String(row[index.name] ?? '').trim();
    if (!name) continue;
    // The export appends a totals row named Total; counting it doubles revenue.
    if (/^(total|sub ?total|grand ?total|合计|总计)$/i.test(name)) continue;
    products.push({
      name,
      variant: String(row[index.variant] ?? '').trim(),
      code: String(row[index.code] ?? '').trim(),
      category: String(row[index.category] ?? '').trim(),
      qtySold: toNumber(row[index.qtySold]),
      netSales: toNumber(row[index.netSales]),
      netSalesShare: toNumber(row[index.netSalesShare]),
      cost: toNumber(row[index.cost]),
      profit: toNumber(row[index.profit]),
    });
  }
  return products;
}

/**
 * Download any report export for a date range.
 * @param {{cookieHeader: string}} session - authenticated session.
 * @param {object} options - `reportPath`, `start`, `end` plus transport overrides.
 * @returns {Promise<{rows: Array<Array<string>>, filename: string, bytes: number}>} raw grid.
 */
async function fetchReportExport(session, {
  reportPath,
  start,
  end,
  baseUrl = 'https://backoffice.taptouch.net',
  fetchImpl = fetch,
}) {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const url = `${origin}${reportPath}?${buildExportQuery({ start, end })}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*;q=0.8',
      cookie: session?.cookieHeader || '',
      referer: `${origin}${reportPath}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    redirect: 'follow',
  });
  if (response.status === 419 || response.status === 401) {
    const error = new Error('TapTouch session expired (HTTP ' + response.status + ')');
    error.code = 'AUTH_EXPIRED';
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`TapTouch export failed (HTTP ${response.status})`);
    error.code = 'HTTP_ERROR';
    error.status = response.status;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const disposition = (response.headers?.get?.('content-disposition')) || '';
  const nameMatch = /filename="?([^";]+)"?/i.exec(disposition);
  return {
    rows: readXlsxRows(buffer),
    filename: nameMatch ? nameMatch[1] : '',
    bytes: buffer.length,
  };
}

/**
 * Download and normalise the product report for a date range.
 * @param {{cookieHeader: string}} session - authenticated session.
 * @param {{start: string, end: string}} range - inclusive date bounds.
 * @param {object} [options] - transport overrides.
 * @returns {Promise<{products: Array<object>, filename: string, bytes: number}>} normalised products.
 */
async function fetchProductsExport(session, { start, end }, options = {}) {
  const result = await fetchReportExport(session, { reportPath: REPORT_PATHS.products, start, end, ...options });
  return { products: productsFromExport(result.rows), filename: result.filename, bytes: result.bytes };
}

module.exports = {
  readZip,
  readXlsxRows,
  parseSharedStrings,
  parseWorksheet,
  columnIndex,
  ordersFromExport,
  buildExportQuery,
  loginForCookie,
  fetchOrdersExport,
  fetchProductsExport,
  fetchReportExport,
  productsFromExport,
  REPORT_PATHS,
  mergeOrdersIntoSnapshot,
  selectOrdersNeedingDetails,
  mapWithConcurrency,
  mergeDetailsIntoSnapshot,
  dateKeyOf,
  ORDER_COLUMNS,
};

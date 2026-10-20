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

module.exports = {
  readZip,
  readXlsxRows,
  parseSharedStrings,
  parseWorksheet,
  columnIndex,
  ordersFromExport,
  buildExportQuery,
  loginForCookie,
  ORDER_COLUMNS,
};

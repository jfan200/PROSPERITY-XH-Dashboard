/**
 * RESTAURANT DASHBOARD — APP.JS
 * 只使用 TapTouch 真实数据（通过后端 server.js）
 * 模拟数据仅在服务器无响应时作为占位符
 */
'use strict';

// ============================================================
// ORDERS PAGE — full table with all orders, clickable rows
// ============================================================
let allOrdersCache = [];
let orderDetailsCache = {};
let orderSearchQuery = '';
const inflightOrderDetails = new Map();
let orderWarmupTimer = null;
let todayOrdersCache = [];
let selectedOrdersDate = '';
let activeOrdersMeta = null;
let ordersDateRequestId = 0;

function getMelbourneDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function buildOrdersMeta(meta = {}, orders = []) {
  const todayKey = getMelbourneDateString();
  const dateKey = meta.dateKey || selectedOrdersDate || todayKey;
  const totalRevenue = typeof meta.totalRevenue === 'number'
    ? meta.totalRevenue
    : orders.reduce((sum, order) => sum + parseMoneyText(order.amount), 0);
  const totalOrders = typeof meta.totalOrders === 'number' ? meta.totalOrders : orders.length;

  return {
    dateKey,
    label: meta.label || (dateKey === todayKey ? '今天' : dateKey),
    isToday: typeof meta.isToday === 'boolean' ? meta.isToday : dateKey === todayKey,
    source: meta.source || 'today_live',
    fetchedAt: meta.fetchedAt || null,
    totalOrders,
    totalRevenue,
    avgTicket: totalOrders > 0 ? totalRevenue / totalOrders : 0,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeOrderSearchValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_/#+.:]/g, '');
}

function getOrderLookupKeys(txId, orderId, detail = null, order = null) {
  return Array.from(new Set([
    txId,
    orderId,
    detail?.txId,
    detail?.orderId,
    detail?.receipt?.transactionId,
    order?.txId,
    order?.id,
  ].filter(Boolean).map(value => String(value).trim()).filter(Boolean)));
}

function findOrderRecord(txId, orderId) {
  const targetKeys = getOrderLookupKeys(txId, orderId);
  return allOrdersCache.find(order => {
    const orderKeys = getOrderLookupKeys(order.txId, order.id, null, order);
    return orderKeys.some(key => targetKeys.includes(key));
  }) || null;
}

function getCachedOrderDetail(txId, orderId) {
  const keys = getOrderLookupKeys(txId, orderId);
  for (const key of keys) {
    if (orderDetailsCache[key]) return orderDetailsCache[key];
  }
  return null;
}

function storeOrderDetail(detail, order = null, txId = '', orderId = '') {
  const keys = getOrderLookupKeys(txId, orderId, detail, order);
  keys.forEach(key => {
    orderDetailsCache[key] = detail;
  });

  const record = findOrderRecord(txId || detail?.txId, orderId || detail?.orderId);
  if (record) record.detailCached = true;
  return detail;
}

function getOrderIdDigits(order) {
  return normalizeOrderSearchValue(order.id).replace(/^[a-z]+/, '');
}

function orderMatchesSearch(order, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;

  // 1. Order ID matching (case-insensitive, ignores non-alphanumeric separators)
  const cleanId = order.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanQuery = q.replace(/[^a-z0-9]/g, '');
  if (cleanId.includes(cleanQuery)) return true;

  // 2. Suffix/digits matching for order ID (e.g. "21" matches "KI-021" or "KT-021")
  const idDigits = order.id.replace(/[^0-9]/g, ''); // get all digits, e.g. "021" or "011"
  if (/^\d+$/.test(q)) {
    if (idDigits === q || Number(idDigits) === Number(q) || idDigits.endsWith(q)) {
      return true;
    }
  }

  // 3. Amount matching
  const amountStr = String(order.amount || '').replace(/[^0-9.]/g, '');
  if (amountStr.includes(q)) return true;

  // 4. Numeric matching for long strings
  if (/^\d+$/.test(q)) {
    if (q.length >= 4) {
      const cleanTx = String(order.txId || '').replace(/[^0-9]/g, '');
      if (cleanTx.includes(q)) return true;
    }
    if (q.length >= 4) {
      const cleanDate = String(order.dateTime || order.date || '').replace(/[^0-9]/g, '');
      if (cleanDate.includes(q)) return true;
    }
    return false;
  }

  // 5. Text fields
  const otherFields = [
    String(order.source || '').toLowerCase(),
    String(order.type || '').toLowerCase(),
    String(order.status || '').toLowerCase(),
    String(order.cashier || '').toLowerCase(),
  ];
  if (otherFields.some(field => field.includes(q))) return true;

  return false;
}

function getOrderDetailState(order) {
  const requestKey = order.txId || order.id || '';
  if (getCachedOrderDetail(order.txId, order.id) || order.detailCached) return 'ready';
  if (requestKey && inflightOrderDetails.has(requestKey)) return 'loading';
  return 'idle';
}

function getOrderDetailStateLabel(state) {
  if (state === 'ready') return '收据已缓存';
  if (state === 'loading') return '正在获取收据';
  return '点击查看收据';
}

function getOrderStatusLabel(status) {
  if (status === 'paid') return '✓ 已付款';
  if (status === 'refunded') return '↩ 退款';
  return '◷ 处理中';
}

function formatOrdersSourceLabel(source) {
  const labels = {
    today_live: '今天实时数据',
    weekly_cache: '本周缓存',
    date_cache: '历史缓存',
    live_fetch: 'TapTouch 现抓',
    empty: '等待同步',
  };
  return labels[source] || 'TapTouch 数据';
}

function updateOrdersHeaderMeta(totalCount, visibleCount) {
  const cachedCount = allOrdersCache.filter(order => getOrderDetailState(order) === 'ready').length;
  const loadingCount = allOrdersCache.filter(order => getOrderDetailState(order) === 'loading').length;
  const meta = activeOrdersMeta || buildOrdersMeta({}, allOrdersCache);
  const summaryParts = [`共 ${totalCount} 笔订单`];

  if (visibleCount !== totalCount) {
    summaryParts.push(`当前筛出 ${visibleCount} 笔`);
  } else {
    summaryParts.push('点击订单可查看 receipt');
  }

  setText('orders-page-sub', summaryParts.join(' · '));

  const stats = document.getElementById('orders-page-stats');
  if (!stats) return;

  const metrics = [
    { label: meta.isToday ? '总订单数' : `${meta.dateKey} 订单`, value: `${totalCount}`, sub: meta.isToday ? 'TapTouch 全量同步' : `来源：${formatOrdersSourceLabel(meta.source)}` },
    { label: '筛选显示', value: `${visibleCount}`, sub: orderSearchQuery ? `过滤：${orderSearchQuery}` : '未启用筛选' }
  ];

  stats.innerHTML = metrics.map(metric => `
    <div class="orders-stat-card">
      <div class="orders-stat-label">${escapeHtml(metric.label)}</div>
      <div class="orders-stat-value">${escapeHtml(metric.value)}</div>
      <div class="orders-stat-sub">${escapeHtml(metric.sub)}</div>
    </div>
  `).join('');
}

function getFilteredOrders() {
  if (!orderSearchQuery) return allOrdersCache.slice();
  return allOrdersCache.filter(order => orderMatchesSearch(order, orderSearchQuery));
}

function syncOrdersDateControls(isLoading = false) {
  const dateInput = document.getElementById('orders-date-input');
  const todayBtn = document.getElementById('orders-today-btn');
  const prevBtn = document.getElementById('orders-date-prev');
  const nextBtn = document.getElementById('orders-date-next');
  const todayKey = getMelbourneDateString();
  const currentVal = selectedOrdersDate || todayKey;

  if (dateInput) {
    dateInput.max = todayKey;
    dateInput.value = currentVal;
    dateInput.disabled = isLoading;
  }
  if (todayBtn) {
    todayBtn.disabled = isLoading || currentVal === todayKey;
  }
  if (prevBtn) {
    prevBtn.disabled = isLoading;
  }
  if (nextBtn) {
    nextBtn.disabled = isLoading || currentVal >= todayKey;
  }
}

let lastOrdersNavTime = 0;
function ordersDateNav(delta) {
  const now = Date.now();
  if (now - lastOrdersNavTime < 300) return; // prevent fast double-clicks/taps
  lastOrdersNavTime = now;

  const picker = document.getElementById('orders-date-input');
  if (!picker) return;
  const current = picker.value || getMelbourneDateString();

  // Parse as local date parts to avoid UTC timezone shift
  const [y, m, dayStr] = current.split('-').map(Number);
  const d = new Date(y, m - 1, dayStr);   // Local midnight, no UTC conversion
  d.setDate(d.getDate() + delta);

  // Format back using local getters (not toISOString which uses UTC)
  const newDate = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');

  const today = getMelbourneDateString();
  if (newDate > today) return;
  changeOrdersDate(newDate);
}

function updateOrdersViewLabels() {
  const meta = activeOrdersMeta || buildOrdersMeta({}, allOrdersCache);
  const panelTitle = document.getElementById('orders-panel-title');
  if (panelTitle) {
    panelTitle.textContent = meta.isToday ? '今日全部订单' : `${meta.dateKey} 全部订单`;
  }

  if (currentPage === 'orders') {
    setText('page-title', meta.isToday ? '今日订单' : '历史订单');
    setText('page-subtitle', `${meta.label} · 共 ${allOrdersCache.length} 笔`);
  }
}

async function changeOrdersDate(dateKey) {
  if (!dateKey) return;
  await loadOrdersForDate(dateKey);
}

async function jumpToTodayOrders() {
  await loadOrdersForDate(getMelbourneDateString(), { preferTodayCache: true });
}

async function loadOrdersForDate(dateKey, options = {}) {
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))
    ? String(dateKey)
    : getMelbourneDateString();
  const todayKey = getMelbourneDateString();

  selectedOrdersDate = normalizedDate;
  syncOrdersDateControls(true);

  if (normalizedDate === todayKey && todayOrdersCache.length && options.preferTodayCache !== false) {
    activeOrdersMeta = buildOrdersMeta({
      dateKey: todayKey,
      label: '今天',
      isToday: true,
      source: 'today_live',
      fetchedAt: cachedSummary?.scrapedAt || null,
      totalOrders: todayOrdersCache.length,
    }, todayOrdersCache);
    renderOrdersPage(todayOrdersCache, activeOrdersMeta);
    syncOrdersDateControls(false);
    return;
  }

  const requestId = ++ordersDateRequestId;
  setText('orders-page-sub', `${normalizedDate} 订单加载中...`);

  try {
    const response = await fetch(`${CONFIG.apiBase}/api/orders/by-date?date=${encodeURIComponent(normalizedDate)}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (requestId !== ordersDateRequestId) return;
    renderOrdersPage(payload.orders || [], payload);
  } catch (error) {
    if (requestId !== ordersDateRequestId) return;
    setText('orders-page-sub', `${normalizedDate} 订单加载失败：${error.message}`);
  } finally {
    if (requestId === ordersDateRequestId) {
      syncOrdersDateControls(false);
    }
  }
}

function renderOrdersPage(orders, meta = {}) {
  allOrdersCache = Array.isArray(orders) ? orders.map(order => ({ ...order })) : [];
  activeOrdersMeta = buildOrdersMeta(meta, allOrdersCache);
  selectedOrdersDate = activeOrdersMeta.dateKey;
  updateOrdersViewLabels();
  syncOrdersDateControls(false);

  const searchInput = document.getElementById('order-search');
  if (searchInput && searchInput.value !== orderSearchQuery) {
    searchInput.value = orderSearchQuery;
  }

  applyOrderFilter();
  queueOrderDetailWarmup();
}

function _renderOrdersTable(orders) {
  const tbody = document.getElementById('orders-page-tbody');
  if (!tbody) return;

  if (!orders.length) {
    const emptyCopy = orderSearchQuery
      ? `没有匹配“${escapeHtml(orderSearchQuery)}”的订单`
      : '暂无订单';
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="orders-empty-cell">
          <div class="orders-empty-state">
            <div class="orders-empty-icon">🧾</div>
            <div class="orders-empty-title">${emptyCopy}</div>
            <div class="orders-empty-sub">试试输入完整订单号、去掉连字符，或搜索交易号。</div>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const statusCls = o.status === 'paid' ? 'paid' : o.status === 'refunded' ? 'refund' : 'pending';
    const detailState = getOrderDetailState(o);
    const txDisplay = o.txId ? `TX ${o.txId}` : '暂无交易号';
    const timeParts = String(o.dateTime || '').split(' ');
    const orderDate = timeParts.length > 1 ? timeParts[0] : '';
    const orderTime = o.date || timeParts[1] || '--:--';
    return `
      <tr class="order-row" onclick='openOrderModal(${JSON.stringify(o.txId || '')}, ${JSON.stringify(o.id || '')})'>
        <td>
          <div class="order-id-stack">
            <div class="order-id-line">
              <span class="order-id-code">${escapeHtml(o.id || '-')}</span>
              <span class="order-detail-pill ${detailState}">${getOrderDetailStateLabel(detailState)}</span>
            </div>
            <div class="order-id-meta">${escapeHtml(txDisplay)}</div>
          </div>
        </td>
        <td class="order-cell-muted">${escapeHtml(o.source || '-')}</td>
        <td><span class="order-type-badge">${escapeHtml(o.type || '-')}</span></td>
        <td>
          <div class="order-time-stack">
            <span class="order-time-main">${escapeHtml(orderTime)}</span>
            <span class="order-time-sub">${escapeHtml(orderDate || '今日')}</span>
          </div>
        </td>
        <td class="order-cell-soft">${escapeHtml(o.tax || '$0')}</td>
        <td class="order-amount-cell">${escapeHtml(o.amount || '$0')}</td>
        <td><span class="order-status ${statusCls}">${getOrderStatusLabel(o.status)}</span></td>
      </tr>`;
  }).join('');
}

function filterOrders(query) {
  orderSearchQuery = String(query || '').trim();
  applyOrderFilter();
}

function applyOrderFilter() {
  const filteredOrders = getFilteredOrders();
  updateOrdersHeaderMeta(allOrdersCache.length, filteredOrders.length);
  _renderOrdersTable(filteredOrders);
}

function getOrderRequestKey(order) {
  return order?.txId || order?.id || '';
}

function queueOrderDetailWarmup() {
  clearTimeout(orderWarmupTimer);
  const warmKeys = allOrdersCache
    .filter(order => getOrderDetailState(order) === 'idle')
    .slice(0, 10)
    .map(order => getOrderRequestKey(order))
    .filter(Boolean);

  if (!warmKeys.length) return;

  orderWarmupTimer = setTimeout(() => {
    warmRecentOrderDetails(warmKeys);
  }, 900);
}

async function warmRecentOrderDetails(keys) {
  try {
    await fetch(`${CONFIG.apiBase}/api/orders/prefetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
  } catch {
    // Keep UI smooth even if background prefetch endpoint is unavailable.
  }
}

function queueAroundOrderPrefetch(anchorOrder, radius = 6) {
  const anchorKey = getOrderRequestKey(anchorOrder);
  if (!anchorKey) return;
  const index = allOrdersCache.findIndex(order => getOrderRequestKey(order) === anchorKey);
  if (index === -1) return;

  const candidates = [];
  for (let offset = 1; offset <= radius; offset += 1) {
    const left = allOrdersCache[index - offset];
    const right = allOrdersCache[index + offset];
    if (left && getOrderDetailState(left) === 'idle') candidates.push(getOrderRequestKey(left));
    if (right && getOrderDetailState(right) === 'idle') candidates.push(getOrderRequestKey(right));
  }

  if (!candidates.length) return;
  warmRecentOrderDetails(candidates);
}

async function requestOrderDetail(txId, orderId, options = {}) {
  const key = txId || orderId;
  if (!key) throw new Error('Missing order key');

  const cached = getCachedOrderDetail(txId, orderId);
  if (cached) return cached;

  if (inflightOrderDetails.has(key)) {
    return inflightOrderDetails.get(key);
  }

  const order = findOrderRecord(txId, orderId);
  const silent = !!options.silent;
  const request = (async () => {
    const response = await fetch(`${CONFIG.apiBase}/api/orders/detail/${encodeURIComponent(key)}`);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {}
      throw new Error(message);
    }

    const detail = await response.json();
    storeOrderDetail(detail, order, txId, orderId);
    if (!silent) applyOrderFilter();
    return detail;
  })();

  inflightOrderDetails.set(key, request);
  applyOrderFilter();

  try {
    return await request;
  } finally {
    inflightOrderDetails.delete(key);
    applyOrderFilter();
  }
}

function renderOrderModalLoading(order) {
  return `
    <div class="order-modal-shell is-loading">
      <div class="order-modal-hero">
        <div>
          <div class="order-modal-kicker">Transaction Receipt</div>
          <div class="order-modal-order-id">${escapeHtml(order.id || '未命名订单')}</div>
          <div class="order-modal-caption">正在优先拉取当前收据，同时后台并发预取附近订单，越看越快。</div>
        </div>
        <div class="order-modal-total muted">
          <span>请稍候</span>
          <strong>加载中</strong>
        </div>
      </div>
      <div class="order-detail-grid">
        ${['时间', '类型', '来源', '交易号'].map(label => `
          <div class="order-detail-card skeleton-card">
            <div class="order-detail-label">${label}</div>
            <div class="order-skeleton-line w-70"></div>
          </div>
        `).join('')}
      </div>
      <div class="receipt-section">
        <div class="receipt-section-head">
          <h3>收据明细</h3>
          <span>TapTouch</span>
        </div>
        <div class="order-loading-panel">
          <div class="order-skeleton-line w-90"></div>
          <div class="order-skeleton-line w-100"></div>
          <div class="order-skeleton-line w-80"></div>
          <div class="order-skeleton-line w-60"></div>
        </div>
      </div>
    </div>
  `;
}

let currentActiveOrderRecord = null;
let currentActiveOrderDetail = null;

function renderOrderModalFallback(order, message = '') {
  currentActiveOrderRecord = order;
  currentActiveOrderDetail = null;

  const note = message || '这笔订单的收据尚未完全同步，您可在此直接预览原始收据。';
  
  const metaCards = [
    ['时间', order.dateTime || order.date || '-'],
    ['类型', order.type || '-'],
    ['来源', order.source || '-'],
    ['交易号', order.txId || '-'],
  ];

  return `
    <div class="order-modal-shell two-col">
      <!-- Left Column: Details & Fallback Note -->
      <div class="order-modal-left-col">
        <div class="order-modal-hero-compact">
          <div>
            <span class="order-kicker">Order Snapshot</span>
            <h4 class="order-id-title">${escapeHtml(order.id || '未命名订单')}</h4>
          </div>
          <div class="order-hero-price">
            <span class="order-price-label">订单金额</span>
            <span class="order-price-val">${escapeHtml(order.amount || '-')}</span>
          </div>
        </div>

        <div class="order-compact-meta-list">
          ${metaCards.map(([label, value]) => `
            <div class="order-meta-row">
              <span class="order-meta-label">${escapeHtml(label)}</span>
              <strong class="order-meta-val" title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>

        <div class="order-compact-summary" style="margin-top: 12px;">
          <div class="receipt-summary-rows-compact" style="background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.15); padding: 12px; border-radius: 12px;">
            <div style="font-size: 12px; color: #f87171; line-height: 1.4; display: flex; gap: 8px; align-items: flex-start;">
              <span>⏳</span>
              <div>${escapeHtml(note)}</div>
            </div>
          </div>
        </div>

        ${order.detailUrl ? `
          <div style="display: flex; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06);">
            <button class="receipt-link-btn-compact" onclick="printReceiptPdf('${escapeHtml(order.id)}', '${escapeHtml(order.detailUrl)}')" style="width: 100%; border: none; outline: none; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); padding: 8px 12px; border-radius: 100px; color: #34d399; cursor: pointer; font-weight: 700; transition: all 0.2s; font-size: 11px;">
              🖨️ 打印 / 保存 PDF
            </button>
          </div>
        ` : ''}
      </div>

      <!-- Right Column: Auto-iframe or Empty State -->
      <div class="order-modal-right-col">
        <div class="receipt-section-head-compact">
          <h3>收据内容</h3>
          <span class="items-count-badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171;">模拟模式</span>
        </div>
        ${order.detailUrl ? `
          <div class="receipt-list-scrollable" style="padding: 0; overflow: hidden; height: 100%;">
            <iframe src="${CONFIG.apiBase}/api/receipt-proxy?url=${encodeURIComponent(order.detailUrl)}" style="width: 100%; height: 100%; border: none; background: #fff; border-radius: 12px;"></iframe>
          </div>
        ` : `
          <div class="receipt-empty-panel" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; gap: 12px;">
            <div class="receipt-empty-icon" style="font-size: 40px;">⏳</div>
            <div class="receipt-empty-title" style="font-size: 16px; font-weight: 700; color: var(--text-1);">收据获取中</div>
            <div class="receipt-empty-copy" style="font-size: 12px; color: var(--text-3); max-width: 260px;">该订单尚未记录原始收据链接，请稍后刷新或重试同步。</div>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderOrderModalDetail(order, detail) {
  currentActiveOrderRecord = order;
  currentActiveOrderDetail = detail;

  const receiptMeta = detail.receipt || {};
  const totals = detail.totals || {};
  const paymentMethods = detail.payment?.methods || [];
  const primaryTotal = totals.totalPaid || totals.total || parseMoneyText(order.amount);
  const totalRows = [
    totals.subtotal ? ['Sub-Total', formatCurrency(totals.subtotal)] : null,
    totals.gst ? ['GST', formatCurrency(totals.gst)] : null,
    totals.surcharge ? ['Surcharge', formatCurrency(totals.surcharge)] : null,
    ...paymentMethods.map(method => [method.label, formatCurrency(method.amount)]),
  ].filter(Boolean);

  const metaCards = [
    ['时间', receiptMeta.orderTime || order.dateTime || order.date || '-'],
    ['类型', receiptMeta.fulfillment || order.type || '-'],
    ['来源', order.source || '-'],
    ['交易号', detail.txId || order.txId || '-'],
  ];

  const itemMarkup = (detail.items || []).map(item => {
    const qty = Number(item.qty) || 1;
    const priceInfo = qty > 1 
      ? `<span style="color: var(--text-3); font-size: 11px;">${qty} x ${escapeHtml(formatDetailAmount(item.price))}</span>` 
      : '';
    return `
      <article class="receipt-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 12px; padding: 10px 14px; gap: 12px;">
        <div class="receipt-item-main" style="flex: 1; min-width: 0;">
          <div class="receipt-item-name" style="font-size: 13px; font-weight: 700; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.name || '未命名菜品')}</div>
          ${item.note ? `<div class="receipt-item-note" style="font-size: 11px; color: var(--text-3); margin-top: 2px;">${escapeHtml(item.note).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
        <div class="receipt-item-meta" style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
          ${priceInfo}
          <strong style="color: #38bdf8; font-weight: 800; font-size: 15px; font-family: 'Inter', sans-serif; text-shadow: 0 0 8px rgba(56, 189, 248, 0.15);">${escapeHtml(formatDetailAmount(item.subtotal || item.price))}</strong>
        </div>
      </article>
    `;
  }).join('');

  const receiptUrl = detail.url || order.detailUrl;
  const proxyUrl = receiptUrl ? `${CONFIG.apiBase}/api/receipt-proxy?url=${encodeURIComponent(receiptUrl)}` : '';

  return `
    <div class="order-modal-shell two-col">
      <!-- Left Column: Details & Payment Summary -->
      <div class="order-modal-left-col">
        <div class="order-modal-hero-compact">
          <div>
            <span class="order-kicker">Transaction Details</span>
            <h4 class="order-id-title">${escapeHtml(order.id || detail.orderId || '未命名订单')}</h4>
          </div>
          <div class="order-hero-price">
            <span class="order-price-label">${totals.totalPaid ? '实付金额' : '订单总额'}</span>
            <span class="order-price-val">${escapeHtml(primaryTotal ? formatCurrency(primaryTotal) : (order.amount || '-'))}</span>
          </div>
        </div>

        <div class="order-compact-meta-list">
          ${metaCards.map(([label, value]) => `
            <div class="order-meta-row">
              <span class="order-meta-label">${escapeHtml(label)}</span>
              <strong class="order-meta-val" title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
            </div>
          `).join('')}
        </div>

        <div class="order-compact-summary" style="margin-top: 12px;">
          <div class="receipt-summary-head-compact" style="font-size: 11px; font-weight: 700; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;">付款汇总</div>
          <div class="receipt-summary-rows-compact">
            ${totalRows.map(([label, value]) => `
              <div class="receipt-summary-row-compact">
                <span>${escapeHtml(label)}</span>
                <span>${escapeHtml(value)}</span>
              </div>
            `).join('')}
            <div class="receipt-summary-row-compact grand-total">
              <span>${totals.totalPaid ? 'Total Paid' : 'Total'}</span>
              <strong>${escapeHtml(primaryTotal ? formatCurrency(primaryTotal) : (order.amount || '-'))}</strong>
            </div>
          </div>
        </div>

        ${receiptUrl ? `
          <div style="display: flex; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06);">
            <button class="receipt-link-btn-compact orders-today-btn" onclick="toggleIframeReceipt('${escapeHtml(proxyUrl)}')" style="flex: 1; border: none; outline: none; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); padding: 8px 12px; border-radius: 100px; color: #60a5fa; cursor: pointer; font-weight: 700; transition: all 0.2s; font-size: 11px;">
              📄 切换收据网页
            </button>
            <button class="receipt-link-btn-compact" onclick="printReceiptPdf('${escapeHtml(order.id || detail.orderId)}', '${escapeHtml(receiptUrl)}')" style="flex: 1; border: none; outline: none; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); padding: 8px 12px; border-radius: 100px; color: #34d399; cursor: pointer; font-weight: 700; transition: all 0.2s; font-size: 11px;">
              🖨️ 打印 / 保存 PDF
            </button>
          </div>
        ` : ''}
      </div>

      <!-- Right Column: Dish List (Scrollable) -->
      <div class="order-modal-right-col">
        <div class="receipt-section-head-compact">
          <h3>菜品明细</h3>
          <span class="items-count-badge">${detail.items?.length || 0} 项</span>
        </div>
        <div class="receipt-list-scrollable">
          ${itemMarkup || '<div class="receipt-empty-copy">TapTouch 未返回可解析的菜品明细。</div>'}
        </div>
      </div>
    </div>
  `;
}

function toggleIframeReceipt(url) {
  const body = document.getElementById('order-modal-body');
  if (!body) return;
  const scrollable = body.querySelector('.receipt-list-scrollable');
  const toggleBtn = body.querySelector('.orders-today-btn'); // IFrame toggler
  if (!scrollable || !toggleBtn) return;

  const iframe = scrollable.querySelector('iframe');
  if (iframe) {
    // Switch back to text dishes list
    if (currentActiveOrderRecord && currentActiveOrderDetail) {
      body.innerHTML = renderOrderModalDetail(currentActiveOrderRecord, currentActiveOrderDetail);
    }
  } else {
    // Switch to iframe
    scrollable.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none;background:#fff;border-radius:12px"></iframe>`;
    scrollable.style.padding = '0';
    scrollable.style.overflow = 'hidden';
    toggleBtn.innerHTML = '📝 切换回精简文字菜品';
    toggleBtn.style.color = '#34d399';
    toggleBtn.style.borderColor = 'rgba(52, 211, 153, 0.3)';
    toggleBtn.style.background = 'rgba(52, 211, 153, 0.1)';
  }
}

function printReceiptPdf(orderId, url) {
  if (!url) {
    alert('无法获取收据打印链接');
    return;
  }
  const proxyUrl = `${CONFIG.apiBase}/api/receipt-proxy?url=` + encodeURIComponent(url);
  
  let iframe = document.getElementById('receipt-print-iframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'receipt-print-iframe';
    iframe.style.position = 'fixed';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    document.body.appendChild(iframe);
  }
  
  iframe.onload = function() {
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (err) {
        alert('打印收据失败: ' + err.message);
      }
    }, 250);
  };
  iframe.src = proxyUrl;
}

// ============================================================
// ORDER DETAIL MODAL
// ============================================================
async function openOrderModal(txId, orderId) {
  const modal = document.getElementById('order-modal');
  const title = document.getElementById('order-modal-title');
  const body  = document.getElementById('order-modal-body');
  if (!modal) return;

  const order = findOrderRecord(txId, orderId) || { id: orderId, txId };
  const requestKey = txId || orderId || '';
  modal.dataset.currentOrderKey = requestKey;
  title.textContent = `订单 ${order.id || orderId || txId} 详情`;
  body.innerHTML = renderOrderModalLoading(order);
  modal.classList.add('active');
  queueAroundOrderPrefetch(order, 8);

  let detail = getCachedOrderDetail(txId, orderId);
  if (!detail) {
    try {
      detail = await requestOrderDetail(txId, orderId);
    } catch (error) {
      if (modal.dataset.currentOrderKey === requestKey) {
        body.innerHTML = renderOrderModalFallback(order, `收据获取较慢：${error.message}`);
      }
      return;
    }
  }

  if (modal.dataset.currentOrderKey !== requestKey) return;

  if (detail && detail.items && detail.items.length > 0) {
    body.innerHTML = renderOrderModalDetail(order, detail);
  } else {
    body.innerHTML = renderOrderModalFallback(order);
  }
}

function closeOrderModal() {
  const modal = document.getElementById('order-modal');
  if (!modal) return;
  modal.classList.remove('active');
  delete modal.dataset.currentOrderKey;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCamModal(); closeOrderModal(); } });

// ============================================================
// SALES PAGE — summary cards + hourly chart
// ============================================================
function formatCurrency(value) {
  return `$${Number(value || 0).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseMoneyText(value) {
  const numeric = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatDetailAmount(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number') return formatCurrency(value);

  const raw = String(value).trim();
  if (!raw) return '-';
  if (raw.startsWith('$')) return raw;

  const numeric = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) && /[\d]/.test(raw) ? formatCurrency(numeric) : raw;
}

// ============================================================
// SALES PAGE STATE
// ============================================================
let salesHourlyChartInst = null;
let salesTypeChartInst   = null;
let avgTicketChartInst   = null;

// ── Compute analytics from raw orders ───────────────────────
function computeOrderStats(orders = []) {
  const typeMap = {};
  const brackets = [
    { label: '< $15',    min: 0,  max: 15  },
    { label: '$15–25',   min: 15, max: 25  },
    { label: '$25–40',   min: 25, max: 40  },
    { label: '> $40',    min: 40, max: Infinity },
  ];
  const ticketBuckets = brackets.map(b => ({ ...b, count: 0 }));
  let maxAmount = 0;
  let maxOrder = null;

  for (const o of orders) {
    const type = (o.type || 'Other').trim();
    const amt  = parseMoneyText(o.amount);

    // Type distribution
    typeMap[type] = (typeMap[type] || { count: 0, revenue: 0 });
    typeMap[type].count++;
    typeMap[type].revenue += amt;

    // Ticket size bucket
    for (const b of ticketBuckets) {
      if (amt >= b.min && amt < b.max) { b.count++; break; }
    }

    // Max single order
    if (amt > maxAmount) { maxAmount = amt; maxOrder = o; }
  }

  return { typeMap, ticketBuckets, maxAmount, maxOrder };
}

// ── Render Hero KPI row ─────────────────────────────────────
function renderSalesHero(summary, orders) {
  const weekly = summary.weeklyOverview;
  const stats  = computeOrderStats(orders || []);

  setText('hero-rev-val',  formatCurrency(summary.totalRevenue));
  setText('hero-ord-val',  `${summary.totalOrders || 0} 单`);
  setText('hero-avg-val',  formatCurrency(summary.avgTicket));
  setText('hero-max-val',  formatCurrency(stats.maxAmount));
  setText('hero-week-val', formatCurrency(weekly?.totalRevenue || 0));

  const maxO = stats.maxOrder;
  setText('hero-max-sub', maxO ? `订单 ${maxO.id || ''} · ${(maxO.date || '').slice(11,16)}` : '今日最大订单');
  setText('hero-rev-sub',  `${summary.ordersDateKey || '今日'} · 实时数据`);
  setText('hero-ord-sub',  orders?.length ? `来源：${[...new Set(orders.map(o=>o.source))].join(' / ')}` : '全部来自实时数据');
  setText('hero-avg-sub',  `今日 ${orders?.length || 0} 笔订单均值`);
  setText('hero-week-sub', weekly ? `${weekly.activeDays} 天有营业 · ${weekly.dateRangeLabel}` : '本周营业天数');
}

// ── Render Hourly Chart (dual-axis: revenue bar + orders line)
function renderSalesHourlyChart(hourlySales) {
  const canvas = document.getElementById('sales-hourly-chart');
  if (!canvas || !hourlySales?.length) return;
  const ctx = canvas.getContext('2d');
  const palette = getThemePalette();
  const isLight = document.body.getAttribute('data-theme') === 'light';
  if (salesHourlyChartInst) salesHourlyChartInst.destroy();

  // Filter to business hours 10:00–00:00 (next day midnight)
  // Hours from 10 to 23, then 00 = midnight
  const BUSINESS_HOURS = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00','00:00'];
  const filtered = BUSINESS_HOURS.map(h => {
    const found = hourlySales.find(d => d.hour === h);
    return found || { hour: h, revenue: 0, orders: 0, isFuture: true };
  });

  const peakIdx = filtered.reduce((peak, v, i) => v.revenue > (filtered[peak]?.revenue || 0) ? i : peak, 0);
  const peakHour = filtered[peakIdx]?.hour || '--:--';
  const peakRev  = filtered[peakIdx]?.revenue || 0;
  setText('sales-peak-badge', `🔥 高峰 ${peakHour}  $${peakRev.toFixed(2)}`);
  setText('sales-hourly-sub', `今日实时数据 · 销售额 + 订单数双轴 · 最高峰 ${peakHour}`);

  const barColors = filtered.map((d, i) =>
    i === peakIdx  ? 'rgba(245,158,11,0.85)' :
    d.isFuture     ? (isLight ? 'rgba(15,23,42,0.07)' : 'rgba(255,255,255,0.04)') :
    d.isCurrent    ? 'rgba(59,130,246,0.9)' : 'rgba(59,130,246,0.62)'
  );

  const grad = ctx.createLinearGradient(0, 0, 0, 240);
  grad.addColorStop(0, 'rgba(59,130,246,0.35)');
  grad.addColorStop(1, 'rgba(59,130,246,0.02)');

  salesHourlyChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: filtered.map(d => d.hour),
      datasets: [
        {
          label: '销售额 AUD',
          data: filtered.map(d => d.revenue),
          backgroundColor: barColors,
          borderColor: filtered.map((d, i) => i === peakIdx ? '#f59e0b' : '#3b82f6'),
          borderWidth: 1,
          borderRadius: 5,
          yAxisID: 'yRev',
          order: 2,
        },
        {
          label: '订单数',
          type: 'line',
          data: filtered.map(d => d.orders || 0),
          borderColor: 'rgba(16,185,129,0.8)',
          backgroundColor: 'rgba(16,185,129,0.1)',
          borderWidth: 2,
          tension: 0.4,
          fill: false,
          pointBackgroundColor: filtered.map(d => d.isFuture ? 'transparent' : palette.green),
          pointRadius: 3,
          pointHoverRadius: 5,
          yAxisID: 'yOrd',
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: palette.chartAxis, font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: palette.tooltipBg,
          borderColor: 'rgba(99,179,237,0.3)',
          borderWidth: 1,
          titleColor: palette.tooltipTitle,
          bodyColor: palette.tooltipText,
          padding: 10,
          callbacks: {
            label: item => item.datasetIndex === 0
              ? ` 销售额 ${formatCurrency(item.raw)}`
              : ` 订单数 ${item.raw} 单`,
          },
        },
      },
      scales: {
        x: { grid: { color: palette.chartGridSoft }, ticks: { color: palette.chartAxis, font: { size: 10 } }, border: { display: false } },
        yRev: {
          position: 'left',
          beginAtZero: true,
          grid: { color: palette.chartGrid },
          ticks: { color: palette.chartAxis, callback: v => `$${v}`, maxTicksLimit: 5 },
          border: { display: false },
        },
        yOrd: {
          position: 'right',
          beginAtZero: true,
          grid: { display: false },
          ticks: { color: palette.green, callback: v => `${v}单`, maxTicksLimit: 5, precision: 0 },
          border: { display: false },
        },
      },
    },
  });
}

// ── Render Order Type Donut (Dine In vs Take Away) ──────────
function renderOrderTypeChart(orders) {
  const canvas = document.getElementById('sales-type-chart');
  const legend = document.getElementById('sales-type-legend');
  const stats  = document.getElementById('sales-type-stats');
  if (!canvas || !orders?.length) return;

  const palette = getThemePalette();
  if (salesTypeChartInst) salesTypeChartInst.destroy();

  const typeData = {};
  for (const o of orders) {
    const t = (o.type || 'Other').trim();
    const amt = parseMoneyText(o.amount);
    typeData[t] = typeData[t] || { count: 0, revenue: 0 };
    typeData[t].count++;
    typeData[t].revenue += amt;
  }

  const TYPE_COLORS = {
    'Dine In':   '#3b82f6',
    'Take Away': '#10b981',
    'Delivery':  '#f59e0b',
    'Other':     '#8b5cf6',
  };

  const entries = Object.entries(typeData).sort((a, b) => b[1].count - a[1].count);
  const labels  = entries.map(([t]) => t);
  const counts  = entries.map(([, d]) => d.count);
  const colors  = labels.map(l => TYPE_COLORS[l] || '#8899bb');
  const total   = counts.reduce((s, v) => s + v, 0);

  salesTypeChartInst = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors, borderColor: palette.bgCard, borderWidth: 2, hoverOffset: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.tooltipBg,
          borderColor: 'rgba(99,179,237,0.3)',
          borderWidth: 1,
          titleColor: palette.tooltipTitle,
          bodyColor: palette.tooltipText,
          padding: 10,
          callbacks: {
            label: (i) => ` ${i.label}: ${i.raw} 单 (${Math.round(i.raw / total * 100)}%)`,
          },
        },
      },
    },
  });

  if (legend) {
    legend.innerHTML = entries.map(([type, d]) => `
      <div class="sales-type-legend-item">
        <span class="sales-type-legend-dot" style="background:${TYPE_COLORS[type] || '#8899bb'}"></span>
        <span>${type}</span>
        <span class="sales-type-legend-pct">${Math.round(d.count / total * 100)}%</span>
      </div>
    `).join('');
  }

  if (stats && entries.length >= 2) {
    const [top] = entries;
    const avgByType = entries.map(([t, d]) => `
      <div class="sales-type-stat">
        <div class="sales-type-stat-label">${t}</div>
        <div class="sales-type-stat-value">${formatCurrency(d.revenue / d.count)}</div>
      </div>
    `).join('');
    stats.innerHTML = `<div style="grid-column:1/-1;font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">各类型平均客单价</div>${avgByType}`;
  }
}

// ── Render Ticket Size Histogram ────────────────────────────
function renderTicketDistribution(orders) {
  const container = document.getElementById('ticket-dist-bars');
  if (!container) return;
  if (!orders?.length) {
    container.innerHTML = `<div style="color:var(--text-3);font-size:12px;padding:20px 0;text-align:center">同步数据后显示</div>`;
    return;
  }

  const brackets = [
    { label: '< $15',    min: 0,  max: 15,       color: '#06b6d4' },
    { label: '$15–25',   min: 15, max: 25,       color: '#3b82f6' },
    { label: '$25–40',   min: 25, max: 40,       color: '#8b5cf6' },
    { label: '> $40',    min: 40, max: Infinity, color: '#f59e0b' },
  ];

  for (const b of brackets) b.count = 0;
  for (const o of orders) {
    const amt = parseMoneyText(o.amount);
    for (const b of brackets) {
      if (amt >= b.min && amt < b.max) { b.count++; break; }
    }
  }

  const total = orders.length;
  const maxCount = Math.max(...brackets.map(b => b.count), 1);

  setText('ticket-dist-sub', `共 ${total} 笔订单 · 价位区间分布`);

  // Animate bars with a delay
  container.innerHTML = brackets.map(b => `
    <div class="ticket-dist-row">
      <span class="ticket-dist-label">${b.label}</span>
      <div class="ticket-dist-bar-wrap">
        <div class="ticket-dist-bar-fill" data-pct="${(b.count / maxCount * 100).toFixed(0)}" style="width:0%;background:${b.color}"></div>
      </div>
      <span class="ticket-dist-count">${b.count}单</span>
      <span class="ticket-dist-pct" style="color:${b.color}">${total > 0 ? Math.round(b.count / total * 100) : 0}%</span>
    </div>
  `).join('');

  // Animate bar widths
  requestAnimationFrame(() => {
    container.querySelectorAll('.ticket-dist-bar-fill').forEach(el => {
      el.style.width = `${el.dataset.pct}%`;
    });
  });
}

// ── Render Avg Ticket Trend (weekly line chart) ─────────────
function renderAvgTicketChart(weeklyOverview) {
  const canvas = document.getElementById('avg-ticket-chart');
  const summary = document.getElementById('avg-ticket-summary');
  if (!canvas) return;

  const palette = getThemePalette();
  if (avgTicketChartInst) avgTicketChartInst.destroy();

  const daily = (weeklyOverview?.daily || []).filter(d => d.hasData);
  if (!daily.length) return;

  const weeklyAvg = weeklyOverview?.avgTicket || 0;
  const maxAvg    = Math.max(...daily.map(d => d.avgTicket));
  const minAvg    = Math.min(...daily.map(d => d.avgTicket));
  const bestDay   = daily.find(d => d.avgTicket === maxAvg);

  avgTicketChartInst = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: weeklyOverview.daily.map(d => d.label),
      datasets: [{
        label: '平均客单价',
        data: weeklyOverview.daily.map(d => d.hasData ? d.avgTicket : null),
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139,92,246,0.12)',
        borderWidth: 2.5,
        tension: 0.4,
        fill: true,
        spanGaps: false,
        pointBackgroundColor: weeklyOverview.daily.map(d =>
          d.isToday ? '#f59e0b' : d.hasData ? '#8b5cf6' : 'transparent'
        ),
        pointRadius: weeklyOverview.daily.map(d => d.hasData ? 4 : 0),
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.tooltipBg,
          borderColor: 'rgba(139,92,246,0.4)',
          borderWidth: 1,
          titleColor: palette.tooltipTitle,
          bodyColor: palette.tooltipText,
          padding: 8,
          callbacks: { label: i => ` 客单价 ${formatCurrency(i.raw)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: palette.chartAxis, font: { size: 10 } }, border: { display: false } },
        y: {
          beginAtZero: false,
          grid: { color: palette.chartGridSoft },
          ticks: { color: palette.chartAxis, callback: v => `$${v}`, maxTicksLimit: 4 },
          border: { display: false },
        },
      },
    },
  });

  if (summary) {
    summary.innerHTML = [
      { label: '周均客单价', value: formatCurrency(weeklyAvg) },
      { label: '最高', value: `${formatCurrency(maxAvg)} · ${bestDay?.label || ''}` },
    ].map(s => `
      <div class="avg-ticket-stat">
        <div class="avg-ticket-stat-label">${s.label}</div>
        <div class="avg-ticket-stat-value">${s.value}</div>
      </div>
    `).join('');
  }
}

// ── Render Calendar Day Cards ────────────────────────────────
function renderCalendarCards(weeklyOverview, todayOrders) {
  const grid = document.getElementById('sales-calendar-grid');
  if (!grid) return;

  const daily = weeklyOverview?.daily || [];
  if (!daily.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-3);font-size:12px;padding:24px;text-align:center">同步数据后显示</div>`;
    return;
  }

  // Compute Dine In / Take Away from today's orders for "today" card
  const todayTypeMap = {};
  for (const o of (todayOrders || [])) {
    const t = (o.type || 'Other').trim();
    todayTypeMap[t] = (todayTypeMap[t] || 0) + 1;
  }
  const todayTotal = (todayOrders || []).length;

  const TYPE_COLORS = { 'Dine In': '#3b82f6', 'Take Away': '#10b981', 'Delivery': '#f59e0b', 'Other': '#8b5cf6' };

  grid.innerHTML = daily.map(day => {
    const typeEntries = day.isToday && todayTotal > 0
      ? Object.entries(todayTypeMap).sort((a, b) => b[1] - a[1]).slice(0, 2)
      : [];

    const typeBars = typeEntries.map(([type, count]) => {
      const pct = Math.round(count / todayTotal * 100);
      return `
        <div class="sales-cal-type-row">
          <span class="sales-cal-type-label">${type.replace('Dine In', 'DI').replace('Take Away', 'TA')}</span>
          <div class="sales-cal-type-track"><div class="sales-cal-type-fill" style="width:${pct}%;background:${TYPE_COLORS[type] || '#8899bb'}"></div></div>
          <span class="sales-cal-type-pct">${pct}%</span>
        </div>
      `;
    }).join('');

    const badgeClass = day.isToday ? 'is-today' : (day.hasData ? 'has-data' : 'is-empty');
    const badgeText  = day.isToday ? '今天' : (day.hasData ? `${day.orders} 单` : '无数据');
    const clickAction = day.hasData
      ? `jumpToOrdersWithDate('${day.dateKey || ''}')` : '';

    return `
      <div class="sales-cal-card ${day.isToday ? 'is-today' : ''} ${!day.hasData ? 'no-data' : ''}" 
           onclick="${clickAction}" 
           data-date="${day.dateKey || ''}"
           title="${day.fullLabel}">
        <div class="sales-cal-weekday">${day.weekday}</div>
        <div class="sales-cal-date">${day.fullLabel.replace(day.weekday + ' ', '')}</div>
        <div class="sales-cal-revenue">${formatCurrency(day.revenue)}</div>
        <div class="sales-cal-orders-badge ${badgeClass}">${badgeText}</div>
        <div class="sales-cal-avg">均 ${formatCurrency(day.avgTicket)}</div>
        ${typeBars ? `<div class="sales-cal-type-bars">${typeBars}</div>` : ''}
      </div>
    `;
  }).join('');
}

// Helper: jump to orders page and load the specified date
async function jumpToOrdersWithDate(dateKey) {
  showPage('orders');
  await loadOrdersForDate(dateKey, { preferTodayCache: dateKey === getMelbourneDateString() });
}

// ── Render Daily Breakdown (Tab 2) ───────────────────────────
function renderSalesDailyBreakdown(weeklyOverview) {
  const el = document.getElementById('sales-daily-breakdown');
  if (!el) return;

  const days = weeklyOverview?.daily || [];
  if (!days.length) {
    el.innerHTML = `<div style="grid-column:1/-1;color:var(--text-3);font-size:12px;padding:24px;text-align:center">同步数据后显示</div>`;
    return;
  }

  el.innerHTML = days.map(day => `
    <div class="sales-daily-item ${day.isToday ? 'is-today' : ''}">
      <div class="sales-daily-head">
        <div>
          <div class="sales-daily-label">${day.weekday}</div>
          <div class="sales-daily-date">${day.fullLabel}</div>
        </div>
        <span class="sales-daily-badge ${day.isToday ? 'is-today' : (day.hasData ? 'has-data' : 'is-empty')}">
          ${day.isToday ? '今天' : (day.hasData ? `${day.orders} 单` : '暂无数据')}
        </span>
      </div>
      <div class="sales-daily-metric">${formatCurrency(day.revenue)}</div>
      <div class="sales-daily-sub">均 ${formatCurrency(day.avgTicket)} · ${day.orders} 单</div>
    </div>
  `).join('');
}

// ── Master renderSalesPage ───────────────────────────────────
function renderSalesPage(summary, hourlySales) {
  if (!summary) return;

  const weeklyOverview = summary.weeklyOverview || null;
  const todayOrders    = allOrdersCache || [];

  // Hero KPIs
  renderSalesHero(summary, todayOrders);

  // Section subtitle (weekly range)
  if (weeklyOverview?.dateRangeLabel) {
    setText('sales-weekly-trend-sub', `${weeklyOverview.dateRangeLabel} · 销售额面积图 + 订单数折线`);
    setText('sales-week-badge', weeklyOverview.dateRangeLabel);
    setText('daily-cards-sub', `${weeklyOverview.dateRangeLabel} · 点击日期跳转订单 · Dine In / Take Away 占比`);
  }

  // Charts (use setTimeout so DOM is ready)
  setTimeout(() => {
    renderSalesHourlyChart(hourlySales || []);
    renderOrderTypeChart(todayOrders);
    renderWeeklyChart(weeklyOverview);     // keeps existing weekly chart
    renderAvgTicketChart(weeklyOverview);
    renderSourceChart(summary.payments || []);  // payment donut
  }, 40);

  // Non-chart sections
  renderTicketDistribution(todayOrders);
  renderCalendarCards(weeklyOverview, todayOrders);
  renderSalesDailyBreakdown(weeklyOverview);
  setSalesViewMode(salesViewMode);
}


// ============================================================
// CONFIG
// ============================================================
function resolveApiBase() {
  const explicit = window.__API_BASE__;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().replace(/\/$/, '');
  }

  const origin = window.location?.origin;
  if (origin && origin !== 'null' && /^https?:\/\//.test(origin)) {
    return origin.replace(/\/$/, '');
  }

  return 'http://localhost:3001';
}

const CONFIG = {
  restaurantName: 'PROSPERITY XH',
  brandName:      '食集-重庆小面',
  apiBase:        resolveApiBase(),
  refreshIntervalMs: 5 * 60 * 1000,

  cameras: [
    {
      id: 'cam-1',
      name: '厨房',
      type: 'Xiaomi 云台2K',
      isOnline: true,
      go2rtcUrl: 'http://localhost:1984/stream.html?src=dining_room&mode=webrtc',
      appOnly: false,
      externalUrl: 'https://home.mi.com/',
      note: '已接入 go2rtc 实时视频流',
      previewRatio: '16 / 9',
      previewImageUrl: '',
    },
    { id: 'cam-2', name: '前台收银', type: 'Xiaomi',     isOnline: false, go2rtcUrl: null },
    { id: 'cam-3', name: '店门口',   type: 'Dahua/DMSS', isOnline: false, go2rtcUrl: null },
    {
      id: 'cam-4',
      name: '用餐区',
      type: 'Dahua/DMSS',
      isOnline: false,
      go2rtcUrl: null,
    },
  ],
};

// ============================================================
// STATE
// ============================================================
let currentPage     = 'dashboard';
let currentChartType = 'bar';
let currentSalesData = [];
let currentPayments  = [];
let salesChartInst   = null;
let sourceChartInst  = null;
let weeklyChartInst  = null;
let countdownSec     = Math.floor(CONFIG.refreshIntervalMs / 1000);
let countdownTimer   = null;
let scrapePoller     = null;
let serverOnline     = false;
const THEME_PREF_KEY = 'dashboard_theme_preference';
let themePreference  = 'system';
let systemThemeMedia = null;
let salesViewMode    = 'overview';

function getSystemTheme() {
  if (!window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getCssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function getThemePalette() {
  return {
    chartGrid: getCssVar('--chart-grid') || 'rgba(255,255,255,0.05)',
    chartGridSoft: getCssVar('--chart-grid-soft') || 'rgba(255,255,255,0.04)',
    chartAxis: getCssVar('--chart-axis') || '#8899bb',
    tooltipBg: getCssVar('--chart-tooltip-bg') || '#161e2e',
    tooltipTitle: getCssVar('--chart-tooltip-title') || '#8899bb',
    tooltipText: getCssVar('--chart-tooltip-text') || '#f0f4ff',
    bgCard: getCssVar('--bg-card') || '#161e2e',
    green: getCssVar('--green') || '#10b981',
  };
}

function updateThemeButton() {
  const iconEl = document.getElementById('theme-btn-icon');
  const textEl = document.getElementById('theme-btn-text');
  if (!iconEl || !textEl) return;

  const map = {
    dark:  { icon: '🌙', text: '深夜模式' },
    light: { icon: '☀️', text: '白天模式' },
  };
  const state = map[themePreference] || map.light;

  // Animate icon with a quick spin-bounce
  iconEl.style.transform = 'rotate(-30deg) scale(0.6)';
  iconEl.style.opacity = '0';
  setTimeout(() => {
    iconEl.textContent = state.icon;
    iconEl.style.transform = 'rotate(0deg) scale(1)';
    iconEl.style.opacity = '1';
  }, 120);

  textEl.textContent = state.text;
}

function rerenderThemeSensitiveCharts() {
  if (currentSalesData.length) renderSalesChart(currentSalesData);
  if (currentPayments.length) renderSourceChart(currentPayments);
  if (cachedSummary?.weeklyOverview) {
    renderWeeklyChart(cachedSummary.weeklyOverview);
    renderAvgTicketChart(cachedSummary.weeklyOverview);
  }
  if (cachedSalesHourly?.length) renderSalesHourlyChart(cachedSalesHourly);
  if (allOrdersCache?.length) renderOrderTypeChart(allOrdersCache);
}

function applyThemePreference(pref, options = {}) {
  const { persist = true, rerender = true } = options;
  const normalized = ['dark', 'light'].includes(pref) ? pref : 'light';
  themePreference = normalized;

  document.body.setAttribute('data-theme', normalized);
  document.body.setAttribute('data-theme-pref', normalized);
  updateThemeButton();

  if (persist) {
    try { localStorage.setItem(THEME_PREF_KEY, normalized); } catch {}
  }

  if (rerender) rerenderThemeSensitiveCharts();
}

function cycleThemePreference() {
  const order = ['light', 'dark'];
  const idx = order.indexOf(themePreference);
  const next = order[(idx + 1) % order.length];

  // Flash overlay for premium feel
  const flash = document.createElement('div');
  flash.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999', 'pointer-events:none',
    'background:rgba(255,255,255,0.06)',
    'opacity:0',
    'transition:opacity 0.15s ease',
  ].join(';');
  document.body.appendChild(flash);
  requestAnimationFrame(() => {
    flash.style.opacity = '1';
    setTimeout(() => {
      flash.style.opacity = '0';
      setTimeout(() => flash.remove(), 200);
    }, 80);
  });

  applyThemePreference(next, { persist: true, rerender: true });
}

function setSalesViewMode(mode = 'overview') {
  const normalized = mode === 'daily' ? 'daily' : 'overview';
  salesViewMode = normalized;

  const overviewSection = document.getElementById('sales-overview-section');
  const dailySection    = document.getElementById('sales-daily-section');
  const overviewBtn     = document.getElementById('sales-mode-overview');
  const dailyBtn        = document.getElementById('sales-mode-daily');

  if (overviewSection) overviewSection.classList.toggle('hidden', normalized !== 'overview');
  if (dailySection)    dailySection.classList.toggle('hidden', normalized !== 'daily');

  // Both buttons use ctype-btn class in the new design
  if (overviewBtn) {
    overviewBtn.classList.toggle('active', normalized === 'overview');
    overviewBtn.classList.toggle('ctype-btn', true);
  }
  if (dailyBtn) {
    dailyBtn.classList.toggle('active', normalized === 'daily');
    dailyBtn.classList.toggle('ctype-btn', true);
  }

  if (currentPage === 'sales') {
    const salesModeLabel = normalized === 'daily' ? '每日分析' : '营销总览';
    setText(
      'page-subtitle',
      `${salesModeLabel} · 今日 ${cachedSummary ? formatCurrency(cachedSummary.totalRevenue) : '--'} | ${cachedSummary?.totalOrders || '--'} 单 · 每5分钟自动刷新`
    );
  }
}

// ============================================================
// CLOCK (Melbourne time)
// ============================================================
function updateClock() {
  const now = new Date();
  const tz  = 'Australia/Melbourne';
  const fmt  = (opts) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, ...opts }).format(now);

  setText('topbar-time',   fmt({ hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }));
  setText('topbar-date',   fmt({ day:'numeric', month:'short' }));
  setText('sidebar-time',  fmt({ hour:'2-digit', minute:'2-digit', hour12:false }));
  setText('sidebar-date',  fmt({ weekday:'short', day:'numeric', month:'short', year:'numeric' }));

  const hour   = parseInt(fmt({ hour:'2-digit', hour12:false }));
  const isOpen = hour >= 10 && hour < 22;
  document.getElementById('store-status-card')?.classList.toggle('closed', !isOpen);
  setText('store-status-text', isOpen ? '营业中' : '已打烊');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function applyRefreshCountdownUI(seconds) {
  const text = formatCountdown(seconds);
  setText('countdown-text', text);
  setText('footer-countdown', text);
}

// ============================================================
// FETCH LIVE DATA FROM BACKEND
// ============================================================
async function fetchLiveData() {
  const [hourly, summary, orders] = await Promise.all([
    fetch(`${CONFIG.apiBase}/api/sales/hourly`).then(r  => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(`${CONFIG.apiBase}/api/sales/summary`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(`${CONFIG.apiBase}/api/orders/recent`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  ]);
  return { hourly, summary, orders };
}

// ============================================================
// KPI DISPLAY (real data)
// ============================================================
function renderKPIs(summary, hourlySales) {
  setText('kpi-rev-val', `$${summary.totalRevenue.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`);
  setText('kpi-ord-val', `${summary.totalOrders} 单`);
  setText('kpi-avg-val', `$${summary.avgTicket.toFixed(2)}`);

  // Peak hour
  const peak = hourlySales.reduce((mx, d) => d.revenue > (mx?.revenue || 0) ? d : mx, null);
  if (peak) {
    setText('kpi-peak-val', peak.hour);
    setText('kpi-peak-rev', `峰值 $${peak.revenue}`);
  }

  // No yesterday data from TapTouch yet — show neutral
  const kpiChgIds = ['kpi-rev-chg', 'kpi-ord-chg', 'kpi-avg-chg'];
  kpiChgIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = 'kpi-mini-change neutral'; el.textContent = '实时数据'; }
  });
}

function fmtH(label) { return label; }  // labels are already "11:00" strings

// ============================================================
// HOURLY SALES CHART
// ============================================================
function renderSalesChart(hourlySales) {
  const canvas = document.getElementById('sales-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isLight = document.body.getAttribute('data-theme') === 'light';
  if (salesChartInst) salesChartInst.destroy();

  // Filter to business hours 10:00–00:00
  const DASH_HOURS = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00','00:00'];
  const filteredData = DASH_HOURS.map(h => {
    const found = hourlySales.find(d => d.hour === h);
    return found || { hour: h, revenue: 0, isFuture: true, isCurrent: false };
  });

  const labels   = filteredData.map(d => d.hour);
  const revenues = filteredData.map(d => d.revenue);

  const barColors = filteredData.map(d =>
    d.isFuture  ? (isLight ? 'rgba(15,23,42,0.08)' : 'rgba(255,255,255,0.04)') :
    d.isCurrent ? 'rgba(245,158,11,0.8)'  : 'rgba(59,130,246,0.75)'
  );
  const borderColors = filteredData.map(d =>
    d.isFuture  ? (isLight ? 'rgba(15,23,42,0.15)' : 'rgba(255,255,255,0.06)') :
    d.isCurrent ? '#f59e0b' : '#3b82f6'
  );

  const grad = ctx.createLinearGradient(0, 0, 0, 220);
  grad.addColorStop(0, 'rgba(59,130,246,0.45)');
  grad.addColorStop(1, 'rgba(59,130,246,0.02)');

  salesChartInst = new Chart(ctx, {
    type: currentChartType,
    data: {
      labels,
      datasets: [{
        label: 'AUD',
        data: revenues,
        backgroundColor: currentChartType === 'bar' ? barColors : grad,
        borderColor:     currentChartType === 'bar' ? borderColors : '#3b82f6',
        borderWidth:  currentChartType === 'bar' ? 1 : 2,
        borderRadius: currentChartType === 'bar' ? 5 : 0,
        tension: 0.4,
        fill: currentChartType === 'line',
        pointBackgroundColor: hourlySales.map(d =>
          d.isFuture ? 'transparent' : d.isCurrent ? '#f59e0b' : '#3b82f6'
        ),
        pointBorderColor: isLight ? '#e2e8f0' : '#fff',
        pointBorderWidth: 1.5,
        pointRadius: currentChartType === 'line' ? 4 : 0,
        pointHoverRadius: 6,
      }],
    },
    options: chartOptions('$'),
  });
}

// ============================================================
// PAYMENT METHOD DONUT (dashboard + sales page)
// ============================================================
let salesPaymentChartInst = null;

function renderSourceChart(payments) {
  // Render on dashboard canvas
  const dashCanvas = document.getElementById('source-chart');
  if (dashCanvas) {
    const ctx = dashCanvas.getContext('2d');
    const palette = getThemePalette();
    if (sourceChartInst) sourceChartInst.destroy();

    if (payments && payments.length > 0) {
      sourceChartInst = new Chart(ctx, buildPaymentChartConfig(payments, palette));
    }

    // Dashboard legend
    const legend = document.getElementById('donut-legend');
    if (legend) legend.innerHTML = buildPaymentLegendHTML(payments);
  }

  // Render on sales page canvas
  const salesCanvas = document.getElementById('sales-payment-chart');
  if (salesCanvas) {
    const ctx = salesCanvas.getContext('2d');
    const palette = getThemePalette();
    if (salesPaymentChartInst) salesPaymentChartInst.destroy();

    if (payments && payments.length > 0) {
      salesPaymentChartInst = new Chart(ctx, buildPaymentChartConfig(payments, palette));
    }

    // Sales page legend
    const salesLegend = document.getElementById('sales-payment-legend');
    if (salesLegend) salesLegend.innerHTML = buildPaymentLegendHTML(payments);
  }
}

function buildPaymentChartConfig(payments, palette) {
  return {
    type: 'doughnut',
    data: {
      labels: payments.map(p => p.label),
      datasets: [{
        data: payments.map(p => p.value),
        backgroundColor: payments.map(p => p.color),
        borderColor: palette.bgCard,
        borderWidth: 2,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.tooltipBg,
          borderColor: 'rgba(99,179,237,0.3)',
          borderWidth: 1,
          titleColor: palette.tooltipTitle,
          bodyColor: palette.tooltipText,
          padding: 10,
          callbacks: {
            label: (i) => ` $${Number(i.raw).toFixed(2)} (${payments[i.dataIndex]?.pct || 0}%)`,
          },
        },
      },
    },
  };
}

function buildPaymentLegendHTML(payments) {
  if (!payments?.length) return '';
  return payments.map(p => `
    <div class="legend-item">
      <span class="legend-dot" style="background:${p.color}"></span>
      <span>${p.label}</span>
      <span class="legend-val">$${Number(p.value).toFixed(2)} (${p.pct}%)</span>
    </div>
  `).join('');
}

// ============================================================
// SALES PAGE — DATE PICKER
// ============================================================
let salesViewDate = '';   // '' = today (uses live data)

function initSalesDatePicker() {
  const picker = document.getElementById('sales-date-picker');
  if (!picker) return;
  const today = getMelbourneDateString();
  picker.value = today;
  picker.max   = today;
  updateSalesDateUI(today);
}

function updateSalesDateUI(dateKey) {
  const today  = getMelbourneDateString();
  const isToday = dateKey === today;
  const picker = document.getElementById('sales-date-picker');
  const label  = document.getElementById('sales-date-label');
  const todayBtn = document.getElementById('sales-date-today');
  const nextBtn  = document.getElementById('sales-date-next');

  if (picker)   picker.value = dateKey;
  if (label)    label.textContent = isToday ? '今天' : dateKey;
  if (todayBtn) todayBtn.classList.toggle('is-today', isToday);
  if (nextBtn)  nextBtn.disabled = dateKey >= today;
}

function salesDateChanged(dateKey) {
  if (!dateKey) return;
  salesViewDate = dateKey;
  updateSalesDateUI(dateKey);
  loadSalesForDate(dateKey);
}

let lastSalesNavTime = 0;
function salesDateNav(delta) {
  const now = Date.now();
  if (now - lastSalesNavTime < 300) return; // prevent fast double-clicks/taps
  lastSalesNavTime = now;

  const picker = document.getElementById('sales-date-picker');
  if (!picker) return;
  const current = picker.value || getMelbourneDateString();

  // Parse as local date parts to avoid UTC timezone shift
  const [y, m, dayStr] = current.split('-').map(Number);
  const d = new Date(y, m - 1, dayStr);   // Local midnight, no UTC conversion
  d.setDate(d.getDate() + delta);

  // Format back using local getters (not toISOString which uses UTC)
  const newDate = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');

  const today = getMelbourneDateString();
  if (newDate > today) return;
  salesDateChanged(newDate);
}

function salesGoToday() {
  const today = getMelbourneDateString();
  salesViewDate = '';
  salesDateChanged(today);
  // Reload live today data
  refreshData();
}

async function loadSalesForDate(dateKey) {
  const today = getMelbourneDateString();
  if (dateKey === today) {
    // Use cached live data
    if (cachedSummary) {
      allOrdersCache = todayOrdersCache;
      renderSalesPage(cachedSummary, cachedSalesHourly);
      renderSourceChart(currentPayments);
    }
    loadWeekForDate(dateKey);   // ensure weekly section matches
    return;
  }

  // Show loading state
  setText('hero-rev-val', '加载中...');
  setText('hero-ord-val', '--');
  setText('hero-avg-val', '--');
  setText('hero-max-val', '--');
  setText('hero-week-val', '--');

  try {
    const resp = await fetch(`${CONFIG.apiBase}/api/orders/by-date?date=${encodeURIComponent(dateKey)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    const orders  = Array.isArray(payload.orders) ? payload.orders : [];

    // Compute metrics from orders
    const totalRevenue = orders.reduce((s, o) => s + parseMoneyText(o.amount), 0);
    const totalOrders  = orders.length;
    const avgTicket    = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const stats        = computeOrderStats(orders);

    // Build a minimal summary object for the selected date
    const fakeSummary = {
      ...(cachedSummary || {}),
      ordersDateKey: dateKey,
      totalRevenue,
      totalOrders,
      avgTicket,
      payments: currentPayments,
    };

    // Update the shared cache so all chart functions see it
    allOrdersCache = orders;

    // Update hero KPIs
    renderSalesHero(fakeSummary, orders);
    setText('hero-rev-sub',  `${dateKey} 历史数据`);
    setText('hero-ord-sub',  `${orders.length} 笔订单`);
    setText('hero-avg-sub',  `${orders.length} 笔订单均値`);
    setText('hero-max-sub',  `${dateKey} 最大单笔`);

    // Rebuild charts with the historical order data
    setTimeout(() => {
      renderOrderTypeChart(orders);
      renderTicketDistribution(orders);

      // Build hourly breakdown from orders
      const hourlyMap = {};
      for (const o of orders) {
        const raw = o.date || o.dateTime || '';
        // "HH:MM" may appear as first 5 chars of time portion
        const timePart = raw.includes(' ') ? raw.split(' ')[1] : raw;
        const hhmm = timePart.slice(0, 5);
        const hKey  = hhmm.slice(0, 2) + ':00';
        if (!hKey.match(/^\d{2}:00$/)) continue;
        if (!hourlyMap[hKey]) hourlyMap[hKey] = { hour: hKey, revenue: 0, orders: 0, isFuture: false };
        hourlyMap[hKey].revenue += parseMoneyText(o.amount);
        hourlyMap[hKey].orders++;
      }
      renderSalesHourlyChart(Object.values(hourlyMap));
    }, 30);

    // Load the week that contains the selected date
    loadWeekForDate(dateKey);

  } catch (err) {
    setText('hero-rev-val', '加载失败');
    console.error('[Sales Date] Failed to load orders for', dateKey, err.message);
  }
}

// ============================================================
// LOAD WEEKLY DATA FOR ANY SELECTED DATE
// ============================================================
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_SHORT_CLIENT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function localDateKey(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

async function loadWeekForDate(dateKey) {
  console.log('[loadWeekForDate] Initialized loading week containing:', dateKey);
  try {
    const today = getMelbourneDateString();
    const [sy, sm, sd] = dateKey.split('-').map(Number);
    const selObj = new Date(sy, sm - 1, sd);

    // Mon of the selected week (0=Mon … 6=Sun)
    const dow = (selObj.getDay() + 6) % 7;
    const weekMon = new Date(sy, sm - 1, sd - dow);
    const weekMonStr = localDateKey(weekMon);

    // Build the 7-day date keys
    const weekDays = WEEKDAY_LABELS.map((label, i) => {
      const d = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() + i);
      return { label, dateKey: localDateKey(d), dateObj: d };
    });

    console.log('[loadWeekForDate] target Mon is:', weekMonStr, 'weekDays are:', weekDays.map(w => w.dateKey));

    // Check if today's week — if so use cached weeklyOverview
    const [ty, tm, td] = today.split('-').map(Number);
    const todayObj = new Date(ty, tm - 1, td);
    const todayDow = (todayObj.getDay() + 6) % 7;
    const todayMon = localDateKey(new Date(ty, tm - 1, td - todayDow));

    if (weekMonStr === todayMon && cachedSummary?.weeklyOverview) {
      console.log('[loadWeekForDate] selected date is in current week. Using cached weeklyOverview.');
      _applyWeeklyOverview(cachedSummary.weeklyOverview, dateKey);
      return;
    }

    console.log('[loadWeekForDate] selected date is in a historical week. Fetching 7 days in parallel...');

    // Historical week — fetch each day in parallel
    const results = await Promise.all(
      weekDays.map(async day => {
        // Don't fetch future days
        if (day.dateKey > today) {
          console.log('[loadWeekForDate] Skipping future day:', day.dateKey);
          return { ...day, orders: [], revenue: 0, ordersCount: 0 };
        }
        try {
          console.log('[loadWeekForDate] Fetching day:', day.dateKey);
          const resp = await fetch(`${CONFIG.apiBase}/api/orders/by-date?date=${encodeURIComponent(day.dateKey)}`);
          if (!resp.ok) {
            console.error('[loadWeekForDate] Day fetch failed:', day.dateKey, 'HTTP', resp.status);
            return { ...day, orders: [], revenue: 0, ordersCount: 0 };
          }
          const payload = await resp.json();
          const orders = Array.isArray(payload.orders) ? payload.orders : [];
          const revenue = orders.reduce((s, o) => s + parseMoneyText(o.amount), 0);
          console.log('[loadWeekForDate] Day fetch success:', day.dateKey, 'Orders:', orders.length, 'Rev:', revenue);
          return { ...day, orders, revenue, ordersCount: orders.length };
        } catch (err) {
          console.error('[loadWeekForDate] Catch day fetch error:', day.dateKey, err.message);
          return { ...day, orders: [], revenue: 0, ordersCount: 0 };
        }
      })
    );

    // Build weeklyOverview-compatible object
    const daily = results.map(r => {
      const isFuture = r.dateKey > today;
      const avgTicket = r.ordersCount > 0 ? r.revenue / r.ordersCount : 0;

      // Build type breakdown from orders
      const typeBreakdown = {};
      for (const o of (r.orders || [])) {
        const t = o.type || 'Other';
        typeBreakdown[t] = (typeBreakdown[t] || 0) + parseMoneyText(o.amount);
      }

      return {
        label:         r.label,
        chartLabel:    r.label,
        weekday:       r.label,
        fullLabel:     `${r.label} ${r.dateObj.getDate()} ${MONTH_SHORT_CLIENT[r.dateObj.getMonth()]}`,
        dateKey:       r.dateKey,
        revenue:       Math.round(r.revenue * 100) / 100,
        orders:        r.ordersCount,
        avgTicket:     Math.round(avgTicket * 100) / 100,
        hasData:       r.revenue > 0 || r.ordersCount > 0,
        isToday:       r.dateKey === today,
        typeBreakdown,
      };
    });

    const totalRevenue = daily.reduce((s, d) => s + d.revenue, 0);
    const totalOrders  = daily.reduce((s, d) => s + d.orders,  0);
    const activeDays   = daily.filter(d => d.hasData).length;
    const bestDay      = daily.filter(d => d.hasData).reduce((b, d) => !b || d.revenue > b.revenue ? d : b, null);

    // Format week label e.g. "May 18 – 24" or "May 25 – Jun 1"
    const wStart = weekDays[0].dateObj;
    const wEnd   = weekDays[6].dateObj;
    const sM = MONTH_SHORT_CLIENT[wStart.getMonth()];
    const eM = MONTH_SHORT_CLIENT[wEnd.getMonth()];
    const dateRangeLabel = sM === eM
      ? `${sM} ${wStart.getDate()} – ${wEnd.getDate()}`
      : `${sM} ${wStart.getDate()} – ${eM} ${wEnd.getDate()}`;

    const weeklyOverview = {
      dateRangeLabel,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalOrders,
      avgTicket: totalOrders > 0 ? Math.round(totalRevenue / totalOrders * 100) / 100 : 0,
      activeDays,
      bestDay: bestDay ? { label: bestDay.weekday, fullLabel: bestDay.fullLabel, revenue: bestDay.revenue, orders: bestDay.orders, avgTicket: bestDay.avgTicket } : null,
      daily,
    };

    console.log('[loadWeekForDate] WeeklyOverview prepared:', weeklyOverview.dateRangeLabel, 'Total Rev:', weeklyOverview.totalRevenue);
    _applyWeeklyOverview(weeklyOverview, dateKey);
  } catch (err) {
    console.error('[loadWeekForDate] Crash in loadWeekForDate:', err);
  }
}

// Apply a weeklyOverview and highlight the selected date
function _applyWeeklyOverview(weeklyOverview, selectedDateKey) {
  console.log('[_applyWeeklyOverview] Applying week data:', weeklyOverview.dateRangeLabel, 'selected:', selectedDateKey);
  const range = weeklyOverview.dateRangeLabel || '本周';
  setText('sales-weekly-trend-sub', `${range} · 销售额面积图 + 订单数折线`);
  setText('daily-cards-sub',        `${range} · 点击日期跳转订单 · Dine In / Take Away 占比`);
  setText('sales-week-badge',       range);

  renderWeeklyChart(weeklyOverview);
  renderAvgTicketChart(weeklyOverview);
  renderCalendarCards(weeklyOverview, allOrdersCache);
  renderSalesDailyBreakdown(weeklyOverview); // Refresh the daily list too!

  // Update the fifth Hero card (Weekly Cumulative) with the actual week's revenue and active days!
  setText('hero-week-val', formatCurrency(weeklyOverview.totalRevenue || 0));
  setText('hero-week-sub', `${weeklyOverview.activeDays || 0} 天有营业 · ${range}`);

  // After cards render, highlight the selected day
  setTimeout(() => {
    document.querySelectorAll('.sales-cal-card').forEach(card => {
      const isSelected = card.getAttribute('data-date') === selectedDateKey;
      card.classList.toggle('is-selected-date', isSelected);
    });
  }, 20);
}

// ============================================================
// WEEKLY CHART (area chart with orders line)
// ============================================================
function renderWeeklyChart(weeklyOverview) {
  const canvas = document.getElementById('weekly-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const palette = getThemePalette();
  const isLight = document.body.getAttribute('data-theme') === 'light';
  if (weeklyChartInst) weeklyChartInst.destroy();

  const daily = weeklyOverview?.daily || [];
  if (!daily.length) return;

  // Gradient fill for area
  const grad = ctx.createLinearGradient(0, 0, 0, 220);
  grad.addColorStop(0, 'rgba(59,130,246,0.30)');
  grad.addColorStop(1, 'rgba(59,130,246,0.02)');

  weeklyChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: daily.map(day => day.label),
      datasets: [
        {
          label: '销售额 AUD',
          data: daily.map(day => day.revenue),
          type: 'line',
          tension: 0.4,
          fill: true,
          backgroundColor: grad,
          borderColor: '#3b82f6',
          borderWidth: 2.5,
          pointBackgroundColor: daily.map(day =>
            day.isToday ? '#f59e0b' : day.hasData ? '#3b82f6' : 'transparent'
          ),
          pointBorderColor: isLight ? '#e2e8f0' : '#1e293b',
          pointBorderWidth: 2,
          pointRadius: daily.map(day => day.hasData ? 5 : 0),
          pointHoverRadius: 7,
          yAxisID: 'y',
          order: 1,
        },
        {
          label: '订单数',
          data: daily.map(day => day.orders),
          type: 'bar',
          backgroundColor: daily.map(day =>
            day.isToday ? 'rgba(245,158,11,0.25)' :
            day.hasData ? 'rgba(16,185,129,0.22)' :
            (isLight ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.04)')
          ),
          borderColor: daily.map(day =>
            day.isToday ? 'rgba(245,158,11,0.6)' :
            day.hasData ? 'rgba(16,185,129,0.6)' :
            'transparent'
          ),
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'y1',
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: palette.chartAxis, font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: palette.tooltipBg,
          borderColor: 'rgba(99,179,237,0.3)',
          borderWidth: 1,
          titleColor: palette.tooltipTitle,
          bodyColor: palette.tooltipText,
          padding: 10,
          callbacks: {
            title: items => daily[items[0]?.dataIndex]?.fullLabel || '',
            label: item => item.datasetIndex === 0
              ? ` 销售额 ${formatCurrency(item.raw)}`
              : ` 订单数 ${item.raw} 单`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: palette.chartGridSoft },
          ticks: { color: palette.chartAxis, font: { size: 10 } },
          border: { display: false },
        },
        y: {
          position: 'left',
          beginAtZero: true,
          grid: { color: palette.chartGrid },
          ticks: { color: palette.chartAxis, callback: v => `$${v}`, maxTicksLimit: 5 },
          border: { display: false },
        },
        y1: {
          position: 'right',
          beginAtZero: true,
          grid: { display: false },
          ticks: { color: palette.green, callback: v => `${v}单`, maxTicksLimit: 5, precision: 0 },
          border: { display: false },
        },
      },
    },
  });
}


// ============================================================
// ORDERS TABLE (real data from TapTouch)
// ============================================================
function renderOrders(orders) {
  const tbody = document.getElementById('orders-tbody');
  if (!tbody) return;

  if (!orders || orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:24px">暂无订单数据</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const statusCls = o.status === 'paid' ? 'paid' : o.status === 'refunded' ? 'refund' : 'pending';
    const detailState = getOrderDetailState(o);
    const txDisplay = o.txId ? `TX ${o.txId}` : '暂无交易号';
    const timeParts = String(o.dateTime || '').split(' ');
    const orderDate = timeParts.length > 1 ? timeParts[0] : '';
    const orderTime = o.date || timeParts[1] || '--:--';
    
    // Map order type to a safe lowercase CSS class
    const typeCls = String(o.type || '').toLowerCase().replace(/\s+/g, '-');

    return `
      <tr class="order-row" onclick='openOrderModal(${JSON.stringify(o.txId || '')}, ${JSON.stringify(o.id || '')})'>
        <td>
          <div class="order-id-stack">
            <div class="order-id-line">
              <span class="order-id-code">${escapeHtml(o.id || '-')}</span>
              <span class="order-detail-pill ${detailState}">${getOrderDetailStateLabel(detailState)}</span>
            </div>
            <div class="order-id-meta">${escapeHtml(txDisplay)}</div>
          </div>
        </td>
        <td class="order-cell-muted">${escapeHtml(o.source || '-')}</td>
        <td><span class="order-type-badge order-type-${typeCls}">${escapeHtml(o.type || '-')}</span></td>
        <td>
          <div class="order-time-stack">
            <span class="order-time-main">${escapeHtml(orderTime)}</span>
            <span class="order-time-sub">${escapeHtml(orderDate || '今日')}</span>
          </div>
        </td>
        <td class="order-cell-soft">${escapeHtml(o.tax || '$0')}</td>
        <td class="order-amount-cell">${escapeHtml(o.amount || '$0')}</td>
        <td><span class="order-status ${statusCls}">${getOrderStatusLabel(o.status)}</span></td>
      </tr>`;
  }).join('');
}

// ============================================================
// PERIOD PERFORMANCE BARS
// ============================================================
function renderPerf(hourlySales) {
  const list = document.getElementById('perf-list');
  if (!list) return;

  const periods = [
    { label: '早市 10AM–2PM', hours: ['10:00','11:00','12:00','13:00'], icon: '☀️', gradient: 'linear-gradient(90deg, #f59e0b, #fbbf24)', glow: 'rgba(245, 158, 11, 0.35)' },
    { label: '下午 2PM–6PM',  hours: ['14:00','15:00','16:00','17:00'], icon: '☕', gradient: 'linear-gradient(90deg, #06b6d4, #3b82f6)', glow: 'rgba(6, 182, 212, 0.35)' },
    { label: '晚市 6PM–12AM',  hours: ['18:00','19:00','20:00','21:00','22:00','23:00','00:00'], icon: '🔥', gradient: 'linear-gradient(90deg, #ef4444, #ec4899)', glow: 'rgba(239, 68, 68, 0.35)' },
  ];

  const revenues = periods.map(p => hourlySales.filter(d => p.hours.includes(d.hour)).reduce((s, d) => s + d.revenue, 0));
  const maxRev = Math.max(...revenues, 1);

  list.innerHTML = periods.map((p, idx) => {
    const rev = revenues[idx];
    const pct = Math.min(Math.round(rev / maxRev * 100), 100);
    return `
      <div class="perf-item-premium">
        <div class="perf-item-header">
          <div class="perf-item-meta">
            <span class="perf-item-icon-premium">${p.icon}</span>
            <span class="perf-item-label-premium">${p.label}</span>
          </div>
          <span class="perf-item-value-premium">$${rev.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
        </div>
        <div class="perf-bar-track-premium">
          <div class="perf-bar-fill-premium" style="width: ${pct}%; background: ${p.gradient}; box-shadow: 0 0 8px ${p.glow}"></div>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// TOP ITEMS (premium product analytics widget)
// ============================================================
let cachedProductsToday = null;
let activeProductsReport = null;
let productsViewMode = 'today';
let productsViewDate = '';
let productsReportRequestId = 0;
let productsSortMode = 'qty';
let productsTrendRange = '7d';
let productsTrendMetric = 'qty';
let productsTrendChartInst = null;
let productsConcentrationChartInst = null;
let productsRankingExpanded = false;
let productsReportLoading = false;
let cachedDataContext = null;
let dataContextLoading = false;
let cachedDailyReport = null;
let dailyReportLoading = false;
let dailyReportGenerating = false;

function medalForRank(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function percentText(value, digits = 1) {
  const numeric = Number(value) || 0;
  return `${numeric.toFixed(digits)}%`;
}

function trendArrow(value) {
  const numeric = Number(value) || 0;
  if (numeric > 0) return '↑';
  if (numeric < 0) return '↓';
  return '→';
}

function trendClass(value) {
  const numeric = Number(value) || 0;
  if (numeric > 0) return 'positive';
  if (numeric < 0) return 'negative';
  return 'neutral';
}

function getWeekRangeLabelFromDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  const reference = new Date(year, (month || 1) - 1, day || 1);
  const dayOfWeek = reference.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(reference);
  weekStart.setDate(reference.getDate() + diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const fmt = date => new Intl.DateTimeFormat('en-AU', {
    month: 'short',
    day: 'numeric',
  }).format(date);

  return `${fmt(weekStart)} - ${fmt(weekEnd)}`;
}

function getProductsPeriodLabel(mode = productsViewMode, dateKey = productsViewDate || getMelbourneDateString()) {
  if (mode === 'week') return getWeekRangeLabelFromDateKey(dateKey);
  if (mode === 'date') return dateKey;
  return '今天';
}

function getProductsSortLabel() {
  if (productsSortMode === 'revenue') return '销售额';
  if (productsSortMode === 'profit') return '利润';
  return '销量';
}

function updateProductsControls() {
  const dateInput = document.getElementById('products-date-input');
  const prevBtn = document.querySelector('#page-products .products-date-tools .orders-date-nav-btn:first-child');
  const nextBtn = document.querySelector('#page-products .products-date-tools .orders-date-nav-btn:last-child');
  const todayBtn = document.getElementById('products-mode-today');
  const rankingToggle = document.getElementById('products-ranking-toggle');
  const todayKey = getMelbourneDateString();
  const currentVal = productsViewDate || todayKey;

  document.getElementById('products-mode-today')?.classList.toggle('active', productsViewMode === 'today');
  document.getElementById('products-mode-date')?.classList.toggle('active', productsViewMode === 'date');
  document.getElementById('products-mode-week')?.classList.toggle('active', productsViewMode === 'week');

  if (dateInput) {
    dateInput.max = todayKey;
    dateInput.value = currentVal;
    dateInput.disabled = productsReportLoading;
  }
  if (prevBtn) prevBtn.disabled = productsReportLoading;
  if (nextBtn) nextBtn.disabled = productsReportLoading || currentVal >= todayKey;
  if (todayBtn) todayBtn.textContent = '回到今天';
  if (rankingToggle) {
    rankingToggle.textContent = productsRankingExpanded ? '收起榜单' : '展开全部';
    rankingToggle.disabled = productsReportLoading;
  }

  document.getElementById('products-sort-qty')?.classList.toggle('active', productsSortMode === 'qty');
  document.getElementById('products-sort-revenue')?.classList.toggle('active', productsSortMode === 'revenue');
  document.getElementById('products-sort-profit')?.classList.toggle('active', productsSortMode === 'profit');
  document.getElementById('products-trend-7d')?.classList.toggle('active', productsTrendRange === '7d');
  document.getElementById('products-trend-30d')?.classList.toggle('active', productsTrendRange === '30d');
  document.getElementById('products-trend-metric-qty')?.classList.toggle('active', productsTrendMetric === 'qty');
  document.getElementById('products-trend-metric-revenue')?.classList.toggle('active', productsTrendMetric === 'revenue');
  document.getElementById('products-trend-metric-profit')?.classList.toggle('active', productsTrendMetric === 'profit');
}

function updateProductsPageTitle() {
  if (currentPage !== 'products') return;

  const refreshLabel = '每5分钟自动刷新';
  let subtitle = `商品排行分析 · ${refreshLabel}`;
  if (productsViewMode === 'today') subtitle = `今日热销排行 · ${refreshLabel}`;
  if (productsViewMode === 'date') subtitle = `${productsViewDate || getMelbourneDateString()} 单日商品表现 · ${refreshLabel}`;
  if (productsViewMode === 'week') subtitle = `${getWeekRangeLabelFromDateKey(productsViewDate || getMelbourneDateString())} 周商品表现 · ${refreshLabel}`;

  setText('page-title', '热销菜品');
  setText('page-subtitle', subtitle);
}

function renderTopItems(scrapedProducts) {
  const el = document.getElementById('top-items');
  if (!el) return;

  const topDishes = scrapedProducts && scrapedProducts.length > 0
    ? scrapedProducts.slice(0, 5)
    : [];

  if (!topDishes.length) {
    el.innerHTML = '<div class="sales-empty-state">热销菜品会在 TapTouch 同步完成后显示。</div>';
    return;
  }

  const maxCount = Math.max(...topDishes.map(d => d.qty || d.count || 1), 1);

  el.innerHTML = topDishes.map((d, index) => {
    const rank = d.rank || (index + 1);
    const name = d.name || '';
    const qty = d.qty || d.count || 0;
    const amount = d.amount || d.revenue || 0.0;
    const colors = ['#ef4444', '#f59e0b', '#ea580c', '#10b981', '#3b82f6'];
    const icons = ['🍜', '🥟', '🌶️', '🍜', '🥩'];
    const color = d.color || colors[index % colors.length];
    const icon = d.icon || icons[index % icons.length];

    return `
      <div class="top-item-premium">
        <div class="top-item-header">
          <div class="top-item-rank-badge" style="background: ${color}15; color: ${color}; border: 1px solid ${color}30">
            ${rank}
          </div>
          <span class="top-item-icon-tag">${icon}</span>
          <div class="top-item-details">
            <div class="top-item-name-line">${escapeHtml(name)}</div>
            <div class="top-item-stats-line">
              <span class="top-item-count-badge-premium">${qty} 份</span>
              <span class="top-item-divider-dot"></span>
              <span class="top-item-revenue-tag">AUD $${amount.toFixed(2)}</span>
            </div>
          </div>
        </div>
        <div class="top-item-progress-track">
          <div class="top-item-progress-fill" style="width: ${Math.round(qty / maxCount * 100)}%; background: linear-gradient(90deg, ${color}, ${color}cc)"></div>
        </div>
      </div>`;
  }).join('');
}

function renderProductsInsights(analysis) {
  const el = document.getElementById('products-insights');
  if (!el) return;

  const champion = analysis?.insights?.champion;
  const growth = analysis?.insights?.growthLeader;
  const decline = analysis?.insights?.declineLeader;
  const concentration = analysis?.insights?.concentration;

  if (!analysis?.current?.products?.length) {
    el.innerHTML = '<div class="sales-empty-state" style="padding:20px">暂无分析数据</div>';
    return;
  }

  const stars = analysis?.menuEngineering?.quadrants?.stars || [];
  const traffic = analysis?.menuEngineering?.quadrants?.traffic || [];
  const potential = analysis?.menuEngineering?.quadrants?.potential || [];
  const weak = analysis?.menuEngineering?.quadrants?.weak || [];
  const actionTitle = concentration?.top5SharePct >= 60
    ? '降低爆款依赖'
    : potential.length
      ? '放大高利润潜力款'
      : traffic.length
        ? '优化高销量低利润款'
        : '继续放大冠军产品';
  const actionBody = concentration?.top5SharePct >= 60
    ? `TOP5 菜品贡献 ${percentText(concentration.top5SharePct, 0)}。参考菜单工程做法，优先把 ${potential[0]?.name || '潜力款'} 放到更高曝光位，并用套餐或加购分散风险。`
    : potential.length
      ? `${escapeHtml(potential[0]?.name || '潜力款')} 属于高利润低销量商品，适合放在点餐首屏、加照片或改名测试，提高转化。`
      : traffic.length
        ? `${escapeHtml(traffic[0]?.name || '高销量款')} 销量高但利润偏低，建议搭配饮品/小吃加购，或微调份量和配料成本。`
        : `${stars.length ? `${escapeHtml(stars[0]?.name)} 等明星商品` : '明星商品'} 可以继续作为门店主推，同时用次热销商品承接流量。`;

  const cards = [
    {
      title: '🔥 今日冠军',
      kicker: champion ? `贡献 ${percentText(champion.sharePct, 2)}` : '等待数据',
      body: champion
        ? `${escapeHtml(champion.name)} 销量 ${champion.qty} 份，销售额 ${formatCurrency(champion.amount)}，是当前最强引流单品。`
        : '暂无冠军单品数据。',
    },
    {
      title: '📈 增长最快',
      kicker: growth ? `${percentText(growth.qtyChangePct, 0)} 增长` : '等待数据',
      body: growth
        ? `${escapeHtml(growth.name)} 较上一周期 ${percentText(growth.qtyChangePct, 0)}，建议继续保留曝光位，观察它能否进入稳定热销。`
        : '暂无明显增长商品。',
    },
    {
      title: '⚠️ 下滑最快',
      kicker: decline ? `${percentText(decline.qtyChangePct, 0)} 变化` : '等待数据',
      body: decline
        ? `${escapeHtml(decline.name)} 较上一周期 ${percentText(decline.qtyChangePct, 0)}，要排查是否受时段、曝光位、缺货或价格影响。`
        : '暂无明显下滑商品。',
    },
    {
      title: '💡 经营动作',
      kicker: actionTitle,
      body: `${actionBody} ${weak.length ? `当前还有 ${weak.length} 个弱势 SKU，可以评估是否下架或限时替换。` : ''}`.trim(),
    }
  ];

  el.innerHTML = cards.map(card => `
    <div class="products-insight-card products-insight-rich-card">
      <div class="products-insight-title">${card.title}</div>
      <div class="products-insight-kicker">${card.kicker || ''}</div>
      <div class="products-insight-body">${card.body}</div>
    </div>
  `).join('');
}

function renderProductsKpis(analysis) {
  const statsGrid = document.getElementById('products-stats-grid');
  if (!statsGrid) return;

  if (!analysis?.kpis) {
    statsGrid.innerHTML = [
      ['总销量', '--份', '等待同步后显示较上一周期变化'],
      ['销售额', '--', '等待同步后显示营收变化'],
      ['SKU动销率', '-- / --', '等待同步后显示有销售记录的SKU占比'],
      ['冠军贡献度', '--', '等待同步后显示冠军单品贡献'],
    ].map(([label, value, sub]) => `
      <div class="products-stat-card">
        <div class="products-stat-label">${label}</div>
        <div class="products-stat-value">${value}</div>
        <div class="products-stat-sub neutral">${sub}</div>
      </div>
    `).join('');
    return;
  }

  const qty = analysis.kpis.totalQty;
  const revenue = analysis.kpis.totalRevenue;
  const active = analysis.kpis.activeSkuRate;
  const champion = analysis.kpis.championShare;

  const cards = [
    {
      label: '总销量',
      value: `${qty.value}份`,
      sub: `${analysis.comparisonLabel} ${percentText(Math.abs(qty.changePct), 1)} ${trendArrow(qty.changePct)}`,
      cls: trendClass(qty.changePct),
    },
    {
      label: '销售额',
      value: formatCurrency(revenue.value),
      sub: `${analysis.comparisonLabel} ${percentText(Math.abs(revenue.changePct), 1)} ${trendArrow(revenue.changePct)}`,
      cls: trendClass(revenue.changePct),
    },
    {
      label: 'SKU动销率',
      value: `${active.active} / ${active.total}`,
      sub: `${percentText(active.pct, 0)} · 有销售记录的SKU占全部SKU比例`,
      cls: 'neutral',
    },
    {
      label: '冠军贡献度',
      value: percentText(champion.pct, 2),
      sub: champion.name || '暂无冠军单品',
      cls: 'neutral',
    },
  ];

  statsGrid.innerHTML = cards.map(card => `
    <div class="products-stat-card">
      <div class="products-stat-label">${card.label}</div>
      <div class="products-stat-value">${card.value}</div>
      <div class="products-stat-sub ${card.cls}">${card.sub}</div>
    </div>
  `).join('');
}

function getActiveProductRanking(analysis) {
  if (!analysis?.rankings) return [];
  if (productsSortMode === 'revenue') return analysis.rankings.byRevenue || [];
  if (productsSortMode === 'profit') return analysis.rankings.byProfit || [];
  return analysis.rankings.byQty || [];
}

function getVisibleProductRanking(list = []) {
  return productsRankingExpanded ? list : list.slice(0, 5);
}

function renderProductsLoadingState(mode = productsViewMode, dateKey = productsViewDate || getMelbourneDateString()) {
  productsReportLoading = true;
  activeProductsReport = null;
  updateProductsControls();
  updateProductsPageTitle();

  const periodLabel = getProductsPeriodLabel(mode, dateKey);
  const reportSub = document.getElementById('products-report-sub');
  const listSub = document.getElementById('products-list-sub');
  const list = document.getElementById('products-list');
  const insights = document.getElementById('products-insights');
  const engineering = document.getElementById('products-menu-engineering');
  const concentrationCopy = document.getElementById('products-concentration-copy');
  const category = document.getElementById('products-category-analysis');
  const profit = document.getElementById('products-profit-board');
  const trendSub = document.getElementById('products-trend-sub');

  if (reportSub) reportSub.textContent = `${periodLabel} · 正在分析商品数据`;
  if (listSub) listSub.textContent = `正在切换到${getProductsSortLabel()}视角，请稍候`;

  renderProductsKpis(null);

  if (list) {
    list.innerHTML = `
      <div class="products-loading-block">
        <div class="products-loading-title">正在分析 ${escapeHtml(periodLabel)} 的热销结构...</div>
        <div class="products-loading-sub">会先清空旧数据，避免你看到上一天的结果。</div>
        <div class="products-loading-rows">
          <div class="products-skeleton-row"></div>
          <div class="products-skeleton-row"></div>
          <div class="products-skeleton-row"></div>
          <div class="products-skeleton-row"></div>
        </div>
      </div>
    `;
  }
  if (insights) insights.innerHTML = '<div class="products-loading-note">AI 正在重新判断冠军、增长、下滑和经营动作...</div>';
  if (engineering) engineering.innerHTML = '<div class="products-loading-note">正在重算菜单工程象限...</div>';
  if (concentrationCopy) concentrationCopy.innerHTML = '<div class="products-loading-note">正在分析销售集中度与经营风险...</div>';
  if (category) category.innerHTML = '<div class="products-loading-note">正在汇总品类贡献结构...</div>';
  if (profit) profit.innerHTML = '<div class="products-loading-note">正在计算利润贡献 TOP5...</div>';
  if (trendSub) trendSub.textContent = '正在生成趋势曲线';
  renderProductsTrend(null);
  renderProductsConcentration(null);
}

function renderProductsErrorState(error) {
  productsReportLoading = false;
  updateProductsControls();

  const message = escapeHtml(error?.message || '商品分析加载失败');
  const list = document.getElementById('products-list');
  const insights = document.getElementById('products-insights');

  renderProductsKpis(null);
  renderProductsMenuEngineering(null);
  renderProductsConcentration(null);
  renderProductsTrend(null);
  renderProductsCategoryAnalysis(null);
  renderProductsProfitBoard(null);

  if (list) {
    list.innerHTML = `<div class="sales-empty-state" style="padding:24px;text-align:center">商品报表加载失败：${message}</div>`;
  }
  if (insights) {
    insights.innerHTML = `<div class="sales-empty-state" style="padding:20px">AI 洞察暂时不可用：${message}</div>`;
  }
}

function renderProductsRanking(analysis) {
  const el = document.getElementById('products-list');
  if (!el) return;

  const reportSub = document.getElementById('products-report-sub');
  const listSub = document.getElementById('products-list-sub');
  const list = getActiveProductRanking(analysis);

  if (reportSub) {
    const mode = analysis?.mode || productsViewMode || 'today';
    const periodLabel = analysis?.current?.label
      || (mode === 'week'
        ? getWeekRangeLabelFromDateKey(productsViewDate || getMelbourneDateString())
        : '等待同步');
    if (mode === 'week') {
      reportSub.textContent = `${periodLabel} · 周商品销售与排行分析`;
    } else if (mode === 'date') {
      reportSub.textContent = `${periodLabel} · 单日商品销售与排行分析`;
    } else {
      reportSub.textContent = `${periodLabel} · 今日商品销售与排行分析`;
    }
  }
  if (listSub) {
    if (productsSortMode === 'revenue') {
      listSub.textContent = '按销售额排序，辅助判断真正带动营收的产品';
    } else if (productsSortMode === 'profit') {
      listSub.textContent = '按利润排序，优先识别最赚钱的产品';
    } else {
      listSub.textContent = '按销量排序，识别最受欢迎的产品';
    }
  }

  if (!list.length) {
    el.innerHTML = '<div class="sales-empty-state" style="padding:16px 20px">暂无实时热销菜品数据，请先完成 TapTouch 同步。</div>';
    return;
  }

  const visibleList = getVisibleProductRanking(list);

  const totalBase = productsSortMode === 'revenue'
    ? Math.max(1, list.reduce((sum, product) => sum + (Number(product.amount) || 0), 0))
    : productsSortMode === 'profit'
      ? Math.max(1, list.reduce((sum, product) => sum + (Number(product.profit) || 0), 0))
      : Math.max(1, list.reduce((sum, product) => sum + (Number(product.qty) || 0), 0));

  const maxBar = Math.max(...list.map(product => {
    if (productsSortMode === 'revenue') return Number(product.amount) || 0;
    if (productsSortMode === 'profit') return Number(product.profit) || 0;
    return Number(product.qty) || 0;
  }), 1);

  el.innerHTML = `
    <div class="products-ranking-stack">
      <div class="products-ranking-meta">
        <div class="products-ranking-chip">当前按${getProductsSortLabel()}排序</div>
        <div class="products-ranking-chip">${productsRankingExpanded ? `展示全部 ${list.length} 个 SKU` : `默认展开前 ${visibleList.length} 名`}</div>
      </div>
      ${visibleList.map((p, index) => {
        const primaryValue = productsSortMode === 'revenue'
          ? Number(p.amount) || 0
          : productsSortMode === 'profit'
            ? Number(p.profit) || 0
            : Number(p.qty) || 0;
        const sharePct = totalBase > 0 ? (primaryValue / totalBase) * 100 : 0;
        const barPct = maxBar > 0 ? (primaryValue / maxBar) * 100 : 0;
        const compared = (analysis?.current?.productsCompared || []).find(item => item.name === p.name) || p;
        const changePct = productsSortMode === 'revenue'
          ? compared.amountChangePct
          : productsSortMode === 'profit'
            ? compared.profitChangePct
            : compared.qtyChangePct;

        return `
        <div class="products-ranking-row">
          <div class="products-ranking-main">
            <div class="products-ranking-badge">
              ${medalForRank(index + 1)}
            </div>
            <div class="products-ranking-copy">
              <div class="products-ranking-name">${escapeHtml(p.name)}</div>
              <div class="products-ranking-sub">${p.qty} 份 · ${formatCurrency(p.amount)} · 销售占比 ${percentText((Number(p.sharePct) || sharePct), 1)}</div>
            </div>
          </div>
          <div class="products-ranking-side">
            <div class="products-ranking-value">
              ${productsSortMode === 'revenue' ? formatCurrency(p.amount) : productsSortMode === 'profit' ? formatCurrency(p.profit) : `${p.qty}份`}
            </div>
            <div class="products-stat-sub ${trendClass(changePct || 0)}">${percentText(Math.abs(changePct || 0), 1)} ${trendArrow(changePct || 0)}</div>
            <div class="products-ranking-bar">
              <div class="products-ranking-bar-fill" style="width:${barPct}%"></div>
            </div>
          </div>
        </div>`;
      }).join('')}
      ${list.length > visibleList.length ? `<div class="products-ranking-collapsed-note">还有 ${list.length - visibleList.length} 个 SKU 已折叠，点击右上角“展开全部”查看。</div>` : ''}
    </div>
  `;
}

function renderProductsMenuEngineering(analysis) {
  const el = document.getElementById('products-menu-engineering');
  if (!el) return;
  const menu = analysis?.menuEngineering;
  if (!menu) {
    el.innerHTML = '<div class="sales-empty-state" style="padding:20px">暂无菜单工程分析</div>';
    return;
  }

  const groups = [
    ['明星产品', '高销量 · 高利润', menu.quadrants?.stars || []],
    ['引流产品', '高销量 · 低利润', menu.quadrants?.traffic || []],
    ['潜力产品', '低销量 · 高利润', menu.quadrants?.potential || []],
    ['问题产品', '低销量 · 低利润', menu.quadrants?.weak || []],
  ];

  el.innerHTML = groups.map(([title, sub, items]) => `
    <div class="products-engineering-card">
      <div class="products-engineering-title">${title}</div>
      <div class="products-engineering-sub">${sub}</div>
      <div class="products-chip-list">
        ${items.length ? items.map(item => `
          <span class="products-chip">${escapeHtml(item.name)}</span>
        `).join('') : '<span class="sales-empty-state">暂无</span>'}
      </div>
    </div>
  `).join('');
}

function renderProductsConcentration(analysis) {
  const copy = document.getElementById('products-concentration-copy');
  const canvas = document.getElementById('products-concentration-chart');
  if (!copy || !canvas) return;

  const concentration = analysis?.insights?.concentration;
  if (!concentration) {
    if (productsConcentrationChartInst) {
      productsConcentrationChartInst.destroy();
      productsConcentrationChartInst = null;
    }
    copy.innerHTML = '<div class="sales-empty-state" style="padding:12px">暂无集中度数据</div>';
    return;
  }

  copy.innerHTML = `
    <div class="products-insight-card">
      <div class="products-insight-title">TOP5 菜品</div>
      <div class="products-insight-body">${percentText(concentration.top5SharePct, 0)} · ${formatCurrency(concentration.top5Revenue)}</div>
    </div>
    <div class="products-insight-card">
      <div class="products-insight-title">其它菜品</div>
      <div class="products-insight-body">${percentText(concentration.otherSharePct, 0)} · ${formatCurrency(concentration.otherRevenue)}</div>
    </div>
    <div class="products-insight-card">
      <div class="products-insight-title">经营提示</div>
      <div class="products-insight-body">
        ${concentration.riskLevel === 'high'
          ? '销售集中度偏高，建议丰富长尾产品销售，降低经营风险。'
          : concentration.riskLevel === 'medium'
            ? '销售集中度适中，可以继续强化爆款，同时推动次热销产品。'
            : '菜单结构较分散，建议集中资源打造更强爆款。'}
      </div>
    </div>
  `;

  if (productsConcentrationChartInst) productsConcentrationChartInst.destroy();
  const ctx = canvas.getContext('2d');
  productsConcentrationChartInst = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['TOP5 菜品', '其它菜品'],
      datasets: [{
        data: [concentration.top5Revenue, concentration.otherRevenue],
        backgroundColor: ['#3b82f6', '#cbd5e1'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      cutout: '68%',
    },
  });
}

function renderProductsTrend(analysis) {
  const canvas = document.getElementById('products-trend-chart');
  const sub = document.getElementById('products-trend-sub');
  if (!canvas) return;

  const pack = productsTrendRange === '30d' ? analysis?.trends?.range30 : analysis?.trends?.range7;
  if (!pack) {
    if (productsTrendChartInst) {
      productsTrendChartInst.destroy();
      productsTrendChartInst = null;
    }
    if (sub) sub.textContent = '等待趋势数据';
    return;
  }

  const metricMap = {
    qty: { key: 'qty', label: '销量趋势' },
    revenue: { key: 'revenue', label: '销售额趋势' },
    profit: { key: 'profit', label: '利润趋势' },
  };
  const selected = metricMap[productsTrendMetric] || metricMap.qty;
  const series = pack[selected.key] || [];
  if (sub) sub.textContent = `${productsTrendRange === '30d' ? '近30天' : '近7天'} · TOP5 菜品${selected.label}`;

  if (productsTrendChartInst) productsTrendChartInst.destroy();
  const ctx = canvas.getContext('2d');
  const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  productsTrendChartInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels: pack.labels,
      datasets: series.map((item, index) => ({
        label: item.name,
        data: item.data,
        borderColor: palette[index % palette.length],
        backgroundColor: palette[index % palette.length],
        tension: 0.35,
        fill: false,
      })),
    },
    options: chartOptions(productsTrendMetric === 'qty' ? '' : '$'),
  });
}

function renderProductsCategoryAnalysis(analysis) {
  const el = document.getElementById('products-category-analysis');
  if (!el) return;

  const list = analysis?.categoryAnalysis || [];
  if (!list.length) {
    el.innerHTML = '<div class="sales-empty-state" style="padding:20px">暂无品类分析</div>';
    return;
  }

  el.innerHTML = list.map(item => `
    <div class="products-category-row">
      <div class="products-category-top">
        <div class="products-category-name">${escapeHtml(item.category)}</div>
        <div class="products-stat-sub">${item.skuCount} SKU</div>
      </div>
      <div class="products-category-metrics">
        <div class="products-category-metric"><strong>${percentText(item.qtySharePct, 0)}</strong>销量占比</div>
        <div class="products-category-metric"><strong>${percentText(item.revenueSharePct, 0)}</strong>销售额占比</div>
        <div class="products-category-metric"><strong>${percentText(item.profitSharePct, 0)}</strong>利润占比</div>
      </div>
    </div>
  `).join('');
}

function renderProductsProfitBoard(analysis) {
  const el = document.getElementById('products-profit-board');
  if (!el) return;

  const rows = analysis?.profitLeaders || [];
  if (!rows.length) {
    el.innerHTML = '<div class="sales-empty-state" style="padding:20px">暂无利润榜</div>';
    return;
  }

  el.innerHTML = rows.map((item, index) => `
    <div class="products-profit-row">
      <div class="products-profit-main">
        <div class="products-profit-title">${escapeHtml(item.name)}</div>
        <div class="products-profit-rank">${medalForRank(index + 1)} · ${item.qty} 份</div>
      </div>
      <div class="products-profit-metric"><strong>${formatCurrency(item.amount)}</strong>销售额</div>
      <div class="products-profit-metric"><strong>${formatCurrency(item.cost)}</strong>成本</div>
      <div class="products-profit-metric"><strong>${formatCurrency(item.profit)}</strong>利润</div>
      <div class="products-profit-metric"><strong>${percentText(item.marginPct, 0)}</strong>利润率</div>
    </div>
  `).join('');
}

function renderProductsPage(analysis) {
  productsReportLoading = false;
  activeProductsReport = analysis || null;
  updateProductsControls();
  updateProductsPageTitle();
  renderProductsKpis(analysis);
  renderProductsRanking(analysis);
  renderProductsInsights(analysis);
  renderProductsMenuEngineering(analysis);
  renderProductsConcentration(analysis);
  renderProductsTrend(analysis);
  renderProductsCategoryAnalysis(analysis);
  renderProductsProfitBoard(analysis);
}

function renderDataContextPage(payload) {
  const summaryGrid = document.getElementById('context-summary-grid');
  const runtimeNote = document.getElementById('context-runtime-note');
  const sourcesGrid = document.getElementById('context-sources-grid');
  const dimensions = document.getElementById('context-dimensions');
  const metricsBody = document.getElementById('context-metrics-body');
  const patterns = document.getElementById('context-patterns');
  const gotchas = document.getElementById('context-gotchas');
  const prompts = document.getElementById('context-prompts');

  if (!summaryGrid || !runtimeNote || !sourcesGrid || !dimensions || !metricsBody || !patterns || !gotchas || !prompts) return;

  if (!payload) {
    runtimeNote.textContent = '把 TapTouch 仪表板的指标定义、数据来源和常见分析问题沉淀成可复用上下文';
    summaryGrid.innerHTML = `
      <div class="context-stat-card">
        <div class="context-stat-label">覆盖级别</div>
        <div class="context-stat-value">等待加载</div>
        <div class="context-stat-sub">正在读取语义层</div>
      </div>
      <div class="context-stat-card">
        <div class="context-stat-label">运行状态</div>
        <div class="context-stat-value">--</div>
        <div class="context-stat-sub">需要服务在线</div>
      </div>
      <div class="context-stat-card">
        <div class="context-stat-label">建议用途</div>
        <div class="context-stat-value">--</div>
        <div class="context-stat-sub">后续分析启动点</div>
      </div>
      <div class="context-stat-card">
        <div class="context-stat-label">默认时区</div>
        <div class="context-stat-value">--</div>
        <div class="context-stat-sub">等待加载</div>
      </div>
    `;
    sourcesGrid.innerHTML = '<div class="sales-empty-state" style="padding:20px">正在读取来源信息</div>';
    dimensions.innerHTML = '<span class="context-chip">等待加载</span>';
    metricsBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:24px">正在读取指标定义</td></tr>';
    patterns.innerHTML = '<div class="sales-empty-state" style="padding:20px">正在读取分析路径</div>';
    gotchas.innerHTML = '<div class="sales-empty-state" style="padding:20px">正在读取 caveats</div>';
    prompts.innerHTML = '<div class="sales-empty-state" style="padding:20px">正在读取推荐 prompt</div>';
    return;
  }

  const runtime = payload.runtime || {};
  const availableData = runtime.availableData || {};
  const summaryCards = [
    {
      label: '覆盖级别',
      value: payload.coverageLevel || 'Unknown',
      sub: payload.area || '未命名数据域',
    },
    {
      label: '运行状态',
      value: runtime.hasLiveData ? 'Live' : 'Cache',
      sub: runtime.hasLiveData
        ? `最近同步 ${String(runtime.scrapedAt || runtime.lastUpdated || '')}`
        : '当前以缓存或空数据为主',
    },
    {
      label: '可用数据面',
      value: `${availableData.products || 0} SKU`,
      sub: `${availableData.recentOrders || 0} 笔今日订单 · ${availableData.historicalDateCaches || 0} 个历史日期缓存`,
    },
    {
      label: '默认时区',
      value: payload.timeZone || 'Australia/Melbourne',
      sub: '日切、日期筛选和后续分析默认跟随门店本地时间',
    },
  ];

  summaryGrid.innerHTML = summaryCards.map(card => `
    <div class="context-stat-card">
      <div class="context-stat-label">${escapeHtml(card.label)}</div>
      <div class="context-stat-value">${escapeHtml(card.value)}</div>
      <div class="context-stat-sub">${escapeHtml(card.sub)}</div>
    </div>
  `).join('');

  runtimeNote.textContent = payload.freshnessExpectation || 'Data Analytics 会优先使用本页列出的指标定义和来源，然后再决定是否需要更深的外部数据源。';

  const sourceInventory = Array.isArray(payload.sourceInventory) ? payload.sourceInventory : [];
  sourcesGrid.innerHTML = sourceInventory.length
    ? sourceInventory.map(item => `
      <div class="context-source-card">
        <div class="context-source-type">${escapeHtml(item.type || 'source')}</div>
        <div class="context-source-name">${escapeHtml(item.name || 'Unnamed source')}</div>
        <div class="context-source-copy">${escapeHtml(item.useFor || '')}</div>
        <div class="context-source-meta">${escapeHtml(item.status || '')}</div>
        <div class="context-source-path">${escapeHtml(item.locator || '')}</div>
      </div>
    `).join('')
    : '<div class="sales-empty-state" style="padding:20px">暂无来源信息</div>';

  const dimensionList = Array.isArray(payload.dimensions) ? payload.dimensions : [];
  dimensions.innerHTML = dimensionList.length
    ? dimensionList.map(item => `<span class="context-chip">${escapeHtml(item)}</span>`).join('')
    : '<span class="context-chip">暂无默认维度</span>';

  const metrics = Array.isArray(payload.keyMetrics) ? payload.keyMetrics : [];
  metricsBody.innerHTML = metrics.length
    ? metrics.map(metric => `
      <tr>
        <td>${escapeHtml(metric.name || '')}</td>
        <td>${escapeHtml(metric.definition || '')}</td>
        <td>${escapeHtml(metric.grain || '')}</td>
        <td>${escapeHtml(metric.canonicalSource || '')}</td>
        <td>${escapeHtml(metric.caveats || '')}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:24px">暂无指标定义</td></tr>';

  const patternList = Array.isArray(payload.queryPatterns) ? payload.queryPatterns : [];
  patterns.innerHTML = patternList.length
    ? patternList.map(item => `
      <div class="context-stack-card">
        <div class="context-stack-title">${escapeHtml(item.name || '')}</div>
        <div class="context-stack-copy">${escapeHtml(item.useWhen || '')}</div>
        <div class="context-route-list">${(Array.isArray(item.apiRoutes) ? item.apiRoutes : []).map(route => `<span class="context-route-pill">${escapeHtml(route)}</span>`).join('')}</div>
      </div>
    `).join('')
    : '<div class="sales-empty-state" style="padding:20px">暂无分析路径</div>';

  const gotchaList = Array.isArray(payload.gotchas) ? payload.gotchas : [];
  gotchas.innerHTML = gotchaList.length
    ? gotchaList.map(item => `<div class="context-bullet-card">${escapeHtml(item)}</div>`).join('')
    : '<div class="sales-empty-state" style="padding:20px">暂无 caveats</div>';

  const promptList = Array.isArray(payload.futurePrompts) ? payload.futurePrompts : [];
  prompts.innerHTML = promptList.length
    ? promptList.map(item => `<div class="context-prompt-card">${escapeHtml(item)}</div>`).join('')
    : '<div class="sales-empty-state" style="padding:20px">暂无推荐 prompt</div>';
}

async function loadDataContext(force = false) {
  if (dataContextLoading) return;
  if (cachedDataContext && !force) {
    renderDataContextPage(cachedDataContext);
    return;
  }

  dataContextLoading = true;
  renderDataContextPage(cachedDataContext);

  try {
    const response = await fetch(`${CONFIG.apiBase}/api/data-context`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    cachedDataContext = payload;
    renderDataContextPage(payload);
  } catch (error) {
    console.error('[App] loadDataContext failed:', error.message);
    renderDataContextPage(cachedDataContext);
  } finally {
    dataContextLoading = false;
  }
}

function renderReportAgentList(items = [], emptyText = '暂无内容') {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!normalized.length) {
    return `<div class="sales-empty-state" style="padding:20px">${escapeHtml(emptyText)}</div>`;
  }

  return normalized.map(item => `
    <div class="report-agent-list-card">
      <div class="report-agent-list-copy">${escapeHtml(item)}</div>
    </div>
  `).join('');
}

function formatReportScheduleTime(value) {
  if (!value) return '--';
  return String(value).replace('T', ' ').slice(0, 16);
}

function renderDailyReportHistory(history = []) {
  const normalized = Array.isArray(history) ? history.filter(Boolean) : [];
  if (!normalized.length) {
    return '<div class="sales-empty-state" style="padding:20px">最近几天还没有缓存日报</div>';
  }

  return normalized.map(item => {
    const stageLabel = item.stage === 'final' ? '最终版' : '快照版';
    const generatedAt = item.generatedAt ? formatReportScheduleTime(item.generatedAt) : '等待生成';
    const link = item.htmlPath || '#';
    const disabledClass = item.htmlPath ? '' : ' disabled';
    const ariaDisabled = item.htmlPath ? 'false' : 'true';

    return `
      <div class="report-agent-list-card">
        <div class="report-agent-list-copy">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <strong>${escapeHtml(item.dateKey || '--')}</strong>
            <span>${escapeHtml(stageLabel)} · ${escapeHtml(generatedAt)}</span>
          </div>
          <div style="margin-top:8px;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
            <span>${item.hasFinal ? '已含最终版' : '仅保留营业中快照'}</span>
            <a class="report-agent-link-btn${disabledClass}" href="${escapeHtml(link)}" target="_blank" rel="noreferrer" aria-disabled="${ariaDisabled}">打开</a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderDailyReportPage(payload) {
  const summaryGrid = document.getElementById('daily-report-summary-grid');
  const executive = document.getElementById('daily-report-executive');
  const recommendations = document.getElementById('daily-report-recommendations');
  const findings = document.getElementById('daily-report-findings');
  const questions = document.getElementById('daily-report-questions');
  const preview = document.getElementById('daily-report-preview');
  const openLink = document.getElementById('daily-report-open-link');
  const historyEl = document.getElementById('daily-report-history');

  const report = payload?.report || null;
  const meta = payload?.meta || null;
  const state = payload?.state || null;
  const statusEl = document.getElementById('daily-report-status');
  const statusSubEl = document.getElementById('daily-report-status-sub');
  const dateEl = document.getElementById('daily-report-date');
  const generatedAtEl = document.getElementById('daily-report-generated-at');
  const modeEl = document.getElementById('daily-report-agent-mode');
  const htmlPathEl = document.getElementById('daily-report-html-path');
  const heroSubEl = document.getElementById('daily-report-hero-sub');

  if (!report) {
    if (statusEl) statusEl.textContent = dailyReportGenerating ? '生成中' : (dailyReportLoading ? '加载中' : '等待缓存');
    if (statusSubEl) statusSubEl.textContent = state?.lastError || `营业中每 2 小时自动更新一次，打烊后生成最终版。下次计划：${formatReportScheduleTime(state?.nextScheduledAt)}`;
    if (dateEl) dateEl.textContent = '--';
    if (generatedAtEl) generatedAtEl.textContent = '尚未生成';
    if (modeEl) modeEl.textContent = state?.agentMode || '--';
    if (htmlPathEl) htmlPathEl.textContent = '等待输出';
    if (heroSubEl) heroSubEl.textContent = '营业中每 2 小时缓存一次日报，打烊后自动切换为最终版';
    if (summaryGrid) {
      summaryGrid.innerHTML = `
        <div class="report-agent-summary-card">
          <div class="report-agent-summary-label">今日营业额</div>
          <div class="report-agent-summary-value">${dailyReportGenerating ? '生成中...' : '等待数据'}</div>
          <div class="report-agent-summary-sub">${escapeHtml(state?.lastError || '日报生成后这里会显示今天和昨天的核心对比')}</div>
        </div>
      `;
    }
    if (executive) executive.innerHTML = renderReportAgentList([], '日报生成后会出现老板先看摘要');
    if (recommendations) recommendations.innerHTML = renderReportAgentList([], '日报生成后会出现经营建议');
    if (findings) findings.innerHTML = renderReportAgentList([], '日报生成后会出现关键发现');
    if (questions) questions.innerHTML = renderReportAgentList([], '日报生成后会出现下一步问题');
    if (preview) preview.innerHTML = `<div class="sales-empty-state" style="padding:28px">${dailyReportGenerating ? '日报生成中，请稍候...' : '日报生成后会在这里预览'}</div>`;
    if (historyEl) historyEl.innerHTML = renderDailyReportHistory(payload?.history || []);
    if (openLink) {
      openLink.href = '#';
      openLink.classList.add('disabled');
      openLink.setAttribute('aria-disabled', 'true');
    }
    return;
  }

  const fullDayRevenuePct = Number(report?.comparison?.fullDay?.revenue?.pct || 0);
  const sameTimeRevenueDelta = Number(report?.comparison?.sameTime?.revenue?.delta || 0);
  const sameTimeAvgDelta = Number(report?.comparison?.sameTime?.avgTicket?.delta || 0);
  const topProduct = report?.products?.topRevenue?.[0] || null;
  const stage = meta?.stage || report?.lifecycle?.stage || state?.lastStage || 'snapshot';
  const stageLabel = stage === 'final' ? '最终版' : '快照版';

  if (statusEl) statusEl.textContent = dailyReportGenerating ? '更新中' : `${stageLabel}已生成`;
  if (statusSubEl) statusSubEl.textContent = state?.lastError || (stage === 'final'
    ? '今天已生成打烊最终版，明天营业后会继续按 2 小时更新快照。'
    : `营业中缓存版，不会因打开页面而重算。下次计划：${formatReportScheduleTime(state?.nextScheduledAt)}`);
  if (dateEl) dateEl.textContent = report.dateKey || '--';
  if (generatedAtEl) generatedAtEl.textContent = report.generatedAt ? `生成于 ${report.generatedAt.replace('T', ' ').slice(0, 16)}` : '生成时间未知';
  if (modeEl) modeEl.textContent = report?.agent?.mode || meta?.agentMode || '--';
  if (htmlPathEl) htmlPathEl.textContent = `${meta?.htmlPath || 'HTML 路径不可用'} · ${stageLabel}`;
  if (heroSubEl) heroSubEl.textContent = stage === 'final'
    ? '这是打烊后的最终版日报，适合直接发给老板或用于复盘'
    : `这是营业中快照版，截至 ${report?.comparison?.sameTime?.cutoffTime || '--:--'} 自动整理同时间对比、周内表现和菜品贡献。`;

  if (summaryGrid) {
    summaryGrid.innerHTML = [
      {
        label: '今日营业额',
        value: formatCurrency(report?.today?.totalRevenue || 0),
        sub: `昨天全天 ${formatCurrency(report?.yesterday?.totalRevenue || 0)} · 全天口径 ${fullDayRevenuePct >= 0 ? '+' : ''}${fullDayRevenuePct.toFixed(1)}%`,
      },
      {
        label: '今日订单数',
        value: `${report?.today?.totalOrders || 0} 单`,
        sub: `同时间较昨天 ${sameTimeRevenueDelta >= 0 ? '多' : '少'} ${Math.abs(report?.comparison?.sameTime?.orders?.delta || 0)} 单`,
      },
      {
        label: '平均客单价',
        value: formatCurrency(report?.today?.avgTicket || 0),
        sub: `同时间较昨天 ${sameTimeAvgDelta >= 0 ? '+' : ''}${sameTimeAvgDelta.toFixed(2)}`,
      },
      {
        label: '头部菜品',
        value: topProduct?.name || '--',
        sub: topProduct ? `${formatCurrency(topProduct.amount || 0)} · ${topProduct.qty || 0} 份` : '等待菜品贡献数据',
      },
    ].map(card => `
      <div class="report-agent-summary-card">
        <div class="report-agent-summary-label">${escapeHtml(card.label)}</div>
        <div class="report-agent-summary-value">${escapeHtml(card.value)}</div>
        <div class="report-agent-summary-sub">${escapeHtml(card.sub)}</div>
      </div>
    `).join('');
  }

  if (executive) executive.innerHTML = renderReportAgentList(report?.sections?.executiveSummary, '暂无老板先看摘要');
  if (recommendations) recommendations.innerHTML = renderReportAgentList(report?.sections?.recommendations, '暂无经营建议');
  if (findings) findings.innerHTML = renderReportAgentList(report?.sections?.keyFindings, '暂无关键发现');
  if (questions) questions.innerHTML = renderReportAgentList(report?.sections?.furtherQuestions, '暂无下一步问题');
  if (preview) {
    preview.innerHTML = meta?.htmlPath
      ? `<iframe src="${meta.htmlPath}" title="每日日报预览" loading="lazy"></iframe>`
      : '<div class="sales-empty-state" style="padding:28px">报告 HTML 路径不可用</div>';
  }
  if (openLink) {
    openLink.href = meta?.htmlPath || '#';
    openLink.classList.toggle('disabled', !meta?.htmlPath);
    openLink.setAttribute('aria-disabled', meta?.htmlPath ? 'false' : 'true');
  }
  if (historyEl) historyEl.innerHTML = renderDailyReportHistory(payload?.history || []);
}

async function loadDailyReport(force = false) {
  if (dailyReportLoading) return;
  if (cachedDailyReport && !force) {
    renderDailyReportPage(cachedDailyReport);
    return;
  }

  dailyReportLoading = true;
  renderDailyReportPage(cachedDailyReport);

  try {
    const response = await fetch(`${CONFIG.apiBase}/api/reports/daily/latest`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    cachedDailyReport = payload;
    renderDailyReportPage(payload);
  } catch (error) {
    console.error('[App] loadDailyReport failed:', error.message);
    renderDailyReportPage(cachedDailyReport ? {
      ...cachedDailyReport,
      state: {
        ...(cachedDailyReport.state || {}),
        lastError: error.message,
      },
    } : { state: { lastError: error.message } });
  } finally {
    dailyReportLoading = false;
  }
}

async function generateDailyReport() {
  if (dailyReportGenerating) return;
  dailyReportGenerating = true;
  renderDailyReportPage(cachedDailyReport);

  const button = document.getElementById('daily-report-generate-btn');
  if (button) {
    button.disabled = true;
    button.textContent = '生成中...';
  }

  try {
    const response = await fetch(`${CONFIG.apiBase}/api/reports/daily/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    cachedDailyReport = payload;
    renderDailyReportPage(payload);
  } catch (error) {
    console.error('[App] generateDailyReport failed:', error.message);
    renderDailyReportPage(cachedDailyReport ? {
      ...cachedDailyReport,
      state: {
        ...(cachedDailyReport.state || {}),
        lastError: error.message,
      },
    } : { state: { lastError: error.message } });
  } finally {
    dailyReportGenerating = false;
    if (button) {
      button.disabled = false;
      button.textContent = '立即更新日报缓存';
    }
  }
}

async function loadProductsReport(options = {}) {
  const mode = options.mode || productsViewMode || 'today';
  const dateKey = options.dateKey || productsViewDate || getMelbourneDateString();
  const requestId = ++productsReportRequestId;

  productsViewMode = mode;
  productsViewDate = mode === 'today' ? getMelbourneDateString() : dateKey;
  renderProductsLoadingState(mode, productsViewDate);

  if (mode === 'today' && cachedProductsToday && cachedProductsToday.source && cachedProductsToday.source !== 'empty') {
    renderProductsPage(cachedProductsToday);
    return;
  }

  try {
    const query = new URLSearchParams({ mode });
    if (mode !== 'today') query.set('date', productsViewDate);
    const response = await fetch(`${CONFIG.apiBase}/api/products/analysis?${query.toString()}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const report = await response.json();
    if (requestId !== productsReportRequestId) return;

    if (mode === 'today') cachedProductsToday = report;
    renderProductsPage(report);
  } catch (error) {
    if (requestId !== productsReportRequestId) return;
    renderProductsErrorState(error);
  }
}

function setProductsViewMode(mode = 'today') {
  const normalized = ['today', 'date', 'week'].includes(mode) ? mode : 'today';
  const todayKey = getMelbourneDateString();
  const fallbackDate = normalized === 'today'
    ? todayKey
    : (productsViewDate || todayKey);
  loadProductsReport({ mode: normalized, dateKey: fallbackDate });
}

function handleProductsDateChange(value) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    ? String(value)
    : getMelbourneDateString();
  const nextMode = normalized === getMelbourneDateString() && productsViewMode === 'today'
    ? 'today'
    : (productsViewMode === 'today' ? 'date' : productsViewMode);
  loadProductsReport({ mode: nextMode, dateKey: normalized });
}

function shiftProductsDate(delta = 0) {
  const current = productsViewDate || getMelbourneDateString();
  const [y, m, d] = current.split('-').map(Number);
  const next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + delta * (productsViewMode === 'week' ? 7 : 1));

  const normalized = [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, '0'),
    String(next.getDate()).padStart(2, '0'),
  ].join('-');

  if (normalized > getMelbourneDateString()) return;
  loadProductsReport({
    mode: normalized === getMelbourneDateString() ? 'today' : (productsViewMode === 'today' ? 'date' : productsViewMode),
    dateKey: normalized,
  });
}

function setProductsSortMode(mode = 'qty') {
  productsSortMode = ['qty', 'revenue', 'profit'].includes(mode) ? mode : 'qty';
  updateProductsControls();
  renderProductsRanking(activeProductsReport);
}

function toggleProductsRankingExpanded() {
  productsRankingExpanded = !productsRankingExpanded;
  updateProductsControls();
  renderProductsRanking(activeProductsReport);
}

function setProductsTrendRange(range = '7d') {
  productsTrendRange = range === '30d' ? '30d' : '7d';
  updateProductsControls();
  renderProductsTrend(activeProductsReport);
}

function setProductsTrendMetric(metric = 'qty') {
  productsTrendMetric = ['qty', 'revenue', 'profit'].includes(metric) ? metric : 'qty';
  updateProductsControls();
  renderProductsTrend(activeProductsReport);
}

// ============================================================
// SHARED CHART OPTIONS
// ============================================================
function chartOptions(prefix = '') {
  const palette = getThemePalette();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: palette.tooltipBg,
        borderColor: 'rgba(99,179,237,0.3)',
        borderWidth: 1,
        titleColor: palette.tooltipTitle,
        bodyColor: palette.tooltipText,
        padding: 10,
        callbacks: {
          label: (i) => ` ${prefix}${Number(i.raw).toFixed(2)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: palette.chartGridSoft, drawBorder: false },
        ticks: { color: palette.chartAxis, font: { size: 10, family: 'Inter' } },
        border: { display: false },
      },
      y: {
        grid: { color: palette.chartGrid, drawBorder: false },
        ticks: {
          color: palette.chartAxis, font: { size: 10, family: 'Inter' },
          callback: (v) => `${prefix}${v}`,
          maxTicksLimit: 5,
        },
        border: { display: false },
        beginAtZero: true,
      },
    },
    animation: { duration: 600, easing: 'easeInOutQuart' },
  };
}

// ============================================================
// CAMERAS
// ============================================================
function renderCameraStrip() {
  const strip    = document.getElementById('cameras-strip');
  const fullGrid = document.getElementById('cameras-full-grid');
  if (!strip) return;

  const renderTiles = (cameras) => cameras.map((cam, i) => `
    <div class="cam-tile ${cam.go2rtcUrl ? 'live-cam' : ''}" onclick="openCamModal(${i})" id="cam-tile-${cam.id}">
      <div class="cam-tile-preview" ${cam.previewRatio ? `style="aspect-ratio:${cam.previewRatio}"` : ''}>
        ${cam.appOnly
          ? `<div class="cam-offline-ph">
               <div class="cam-offline-icon">📱</div>
               <div class="cam-offline-txt">米家查看</div>
             </div>
             <div class="cam-tile-overlay">
               <div class="cam-live-pill"><span class="cam-live-dot"></span>APP</div>
               <span class="cam-type-pill">${cam.type}</span>
             </div>`
          : cam.go2rtcUrl
          ? `${cam.previewImageUrl
              ? `<img src="${cam.previewImageUrl}" alt="${cam.name}" class="cam-live-feed" loading="lazy" />`
              : `<iframe src="${cam.go2rtcUrl}" title="${cam.name}" loading="lazy"
                   style="width:100%;height:100%;border:0;background:#050913"></iframe>`
            }
             <div class="cam-tile-overlay">
               <div class="cam-live-pill"><span class="cam-live-dot"></span>LIVE</div>
               <span class="cam-type-pill">${cam.type}</span>
             </div>`
          : cam.isOnline
          ? `<video id="vid-${cam.id}" autoplay muted playsinline></video>
             <div class="cam-tile-overlay">
               <div class="cam-live-pill"><span class="cam-live-dot"></span>LIVE</div>
               <span class="cam-type-pill">${cam.type}</span>
             </div>`
          : `<div class="cam-offline-ph">
               <div class="cam-offline-icon">📷</div>
               <div class="cam-offline-txt">未连接</div>
             </div>
             <div class="cam-tile-overlay">
               <div></div>
               <span class="cam-type-pill">${cam.type}</span>
             </div>`
        }
        <div class="cam-meta-overlay">
          <span class="cam-meta-pill cam-meta-name">${cam.name}</span>
          <span class="cam-meta-pill cam-meta-state ${cam.appOnly || cam.isOnline ? 'online' : 'offline'}">
            <span class="dot-s ${cam.appOnly || cam.isOnline ? 'dot-green' : 'dot-red'}"></span>
            ${cam.appOnly ? '米家可用' : (cam.isOnline ? '在线' : '离线')}
          </span>
        </div>
      </div>
    </div>
  `).join('');

  const dashboardCameras = CONFIG.cameras.slice(0, 3);
  strip.innerHTML = renderTiles(dashboardCameras);
  if (fullGrid) fullGrid.innerHTML = renderTiles(CONFIG.cameras);
  setText('nav-cam-badge', CONFIG.cameras.length);
}

function openCamModal(index) {
  const cam   = CONFIG.cameras[index];
  const modal = document.getElementById('cam-modal');
  const title = document.getElementById('cam-modal-title');
  const body  = document.getElementById('cam-modal-body');
  if (title) title.textContent = `📷 ${cam.name} — ${cam.type}`;
  if (cam.appOnly) {
    if (body) {
      body.innerHTML = `
        <div class="cam-offline-ph" style="gap:12px">
          <div style="font-size:56px;opacity:0.8">📱</div>
          <div style="font-size:14px;color:var(--text-1);font-weight:600">${cam.name}</div>
          <div style="font-size:12px;color:var(--text-2);text-align:center;max-width:360px">
            ${cam.note || '该摄像头通过米家查看实时画面。'}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:8px">
            <a href="${cam.go2rtcUrl || 'http://localhost:1984/stream.html?src=dining_room'}" target="_blank" rel="noreferrer"
               style="display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;
               color:#93c5fd;text-decoration:none;font-size:12px;font-weight:700;background:rgba(59,130,246,0.14);border:1px solid rgba(59,130,246,0.28)">
              重试 go2rtc
            </a>
            <a href="${cam.externalUrl || 'https://home.mi.com/'}" target="_blank" rel="noreferrer"
             style="display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:10px;
             color:#dbeafe;text-decoration:none;font-size:12px;font-weight:700;background:linear-gradient(135deg, rgba(59,130,246,0.24), rgba(6,182,212,0.22));border:1px solid rgba(59,130,246,0.3)">
              打开米家查看
            </a>
          </div>
        </div>
      `;
    }
    if (modal) modal.classList.add('active');
    return;
  }
  if (cam.go2rtcUrl) {
    if (body) {
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px;width:100%;height:100%">
          <iframe src="${cam.go2rtcUrl}" title="${cam.name}" loading="lazy"
            style="width:100%;height:min(72vh,700px);border:1px solid var(--border);border-radius:12px;background:#050913"></iframe>
          <div style="font-size:12px;color:var(--text-3)">
            如无法出画面，请先确认 go2rtc 中 dining_room 流已可播放。
          </div>
        </div>
      `;
    }
    if (modal) modal.classList.add('active');
    return;
  }
  if (body) {
    body.innerHTML = `
      <div class="cam-offline-ph" style="gap:12px">
        <div style="font-size:56px;opacity:0.3">📷</div>
        <div style="font-size:14px;color:var(--text-2)">${cam.name}</div>
        <div style="font-size:12px;color:var(--text-3);text-align:center;max-width:320px">
          摄像头未连接。<br>请在店内电脑安装 go2rtc 并配置 RTSP 流后启用。
        </div>
      </div>
    `;
  }
  if (modal) modal.classList.add('active');
}
function closeCamModal() { document.getElementById('cam-modal')?.classList.remove('active'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCamModal(); });

// ============================================================
// NAVIGATION
// ============================================================
function showPage(page) {
  currentPage = page;
  ['dashboard','cameras','sales','orders','products','context','reports'].forEach(p => {
    const panel = document.getElementById(`page-${p}`);
    if (!panel) return;
    const isActive = p === page;
    panel.classList.toggle('hidden', !isActive);
    panel.classList.toggle('page-active', isActive);
  });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`nav-${page}`)?.classList.add('active');

  const refreshLabel = '每5分钟自动刷新';
  const salesModeLabel = salesViewMode === 'daily' ? '每日分析' : '营销总览';
  const titles = {
    dashboard: ['Dashboard', `实时运营概览 · ${refreshLabel}`],
    cameras:   ['摄像头监控', `实时画面 · ${refreshLabel}`],
    sales:     ['营销报表', `${salesModeLabel} · 今日 ${cachedSummary ? '$'+cachedSummary.totalRevenue : '--'} | ${cachedSummary?.totalOrders || '--'} 单 · ${refreshLabel}`],
    orders:    ['订单记录', `共 ${allOrdersCache.length} 笔 — 点击查看详情 · ${refreshLabel}`],
    products:  ['热销菜品', `商品排行分析 · ${refreshLabel}`],
    context:   ['数据语义', 'Data Analytics 可复用上下文 · 指标定义、来源与常见分析路径'],
    reports:   ['每日日报', '营业报告 Agent · 自动生成老板可读的日结摘要与完整 HTML 报告'],
  };
  const [t, s] = titles[page] || ['', ''];
  setText('page-title', t);
  setText('page-subtitle', s);

  // Re-render sales chart when switching to sales page
  if (page === 'sales' && cachedSummary) {
    renderSalesPage(cachedSummary, currentSalesData);
    renderSourceChart(currentPayments);   // ensure payment donut is populated
    initSalesDatePicker();
  }
  if (page === 'sales') {
    setSalesViewMode(salesViewMode);
  }
  if (page === 'orders') {
    updateOrdersViewLabels();
    syncOrdersDateControls(false);
  }
  if (page === 'products') {
    updateProductsPageTitle();
    updateProductsControls();
    loadProductsReport({ mode: productsViewMode, dateKey: productsViewDate || getMelbourneDateString() });
  }
  if (page === 'context') {
    loadDataContext();
  }
  if (page === 'reports') {
    loadDailyReport();
  }

  const activePanel = document.getElementById(`page-${page}`);
  if (activePanel) {
    activePanel.classList.remove('page-animate');
    requestAnimationFrame(() => activePanel.classList.add('page-animate'));
  }
}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('collapsed');
  requestAnimationFrame(() => {
    renderCameraStrip();
    window.dispatchEvent(new Event('resize'));
  });
}

function showSettings() {
  alert(`⚙️ 设置\n\n服务器: ${CONFIG.apiBase}\n数据来源: TapTouch (backoffice.taptouch.net)\n摄像头: 需配置 go2rtc RTSP`);
}

// ============================================================
// CHART TOGGLE
// ============================================================
function switchChart(type) {
  currentChartType = type;
  document.getElementById('btn-bar')?.classList.toggle('active', type === 'bar');
  document.getElementById('btn-line')?.classList.toggle('active', type === 'line');
  renderSalesChart(currentSalesData);
}

// ============================================================
// COUNTDOWN & AUTO-REFRESH
// ============================================================
function startCountdown() {
  countdownSec = CONFIG.refreshIntervalMs / 1000;
  clearInterval(countdownTimer);
  applyRefreshCountdownUI(countdownSec);
  countdownTimer = setInterval(async () => {
    countdownSec--;
    applyRefreshCountdownUI(countdownSec);
    if (countdownSec <= 0) {
      clearInterval(countdownTimer);
      await refreshData();
    }
  }, 1000);
}

// ============================================================
// MAIN REFRESH — ONLY REAL DATA
// ============================================================
let cachedSummary     = null;
let cachedSalesHourly = [];
let cookieRefreshRunning = false;
let pageOpenSyncPromise = null;


async function refreshData() {
  const statusBar = document.getElementById('sync-label');
  const footer = document.getElementById('footer-data-source');
  const syncDot = document.querySelector('.sync-dot');

  try {
    const { hourly, summary, orders } = await fetchLiveData();
    const hasLiveData = !!summary?.hasLiveData;

    currentSalesData  = hourly;
    currentPayments   = summary.payments || [];
    cachedSummary     = summary;
    cachedProductsToday = null;
    cachedSalesHourly = Array.isArray(hourly) ? hourly : [];
    todayOrdersCache  = Array.isArray(orders) ? orders : [];
    allOrdersCache    = todayOrdersCache;

    const todayDateKey = summary.ordersDateKey || getMelbourneDateString();
    if (!selectedOrdersDate) selectedOrdersDate = todayDateKey;

    // Dashboard page
    renderKPIs(summary, hourly);
    renderSalesChart(hourly);
    renderSourceChart(summary.payments || []);
    renderOrders(orders.slice(0, 10));  // Show latest 10 on dashboard
    renderPerf(hourly);
    renderTopItems(summary.products);
    if (currentPage === 'products' && productsViewMode === 'today') {
      loadProductsReport({ mode: 'today', dateKey: todayDateKey });
    } else if (currentPage === 'products') {
      updateProductsPageTitle();
    }
    if (currentPage === 'context' || cachedDataContext) {
      loadDataContext(true);
    }
    if (currentPage === 'reports' || cachedDailyReport) {
      loadDailyReport(true);
    }

    if (selectedOrdersDate === todayDateKey) {
      renderOrdersPage(orders, {
        dateKey: todayDateKey,
        label: '今天',
        isToday: true,
        source: 'today_live',
        fetchedAt: summary.scrapedAt || null,
        totalOrders: Array.isArray(orders) ? orders.length : 0,
        totalRevenue: typeof summary.totalRevenue === 'number'
          ? summary.totalRevenue
          : (Array.isArray(orders) ? orders.reduce((sum, order) => sum + parseMoneyText(order.amount), 0) : 0),
      });
    } else {
      syncOrdersDateControls(false);
      updateOrdersViewLabels();
    }

    // Sales page (update if visible)
    renderSalesPage(summary, hourly);

    // Status
    serverOnline = true;
    if (syncDot) syncDot.classList.toggle('live', hasLiveData);
    if (statusBar) statusBar.textContent = hasLiveData ? 'TapTouch 实时数据' : '等待 TapTouch 同步';

    if (hasLiveData) {
      const now = new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Melbourne',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
      }).format(new Date());
      setText('last-updated', `最后更新: ${now}`);
      setText('chart-sub', `TapTouch 真实数据 — 抓取于 ${(summary.scrapedAt || '').replace('T',' ').substring(0,16)} · 每5分钟自动刷新`);
      if (footer) footer.textContent = 'TapTouch 真实数据';
    } else {
      setText('last-updated', '最后更新: 等待首次同步');
      setText('chart-sub', '当前为初始空数据，请运行“从 TapTouch 同步”后加载真实营业数据');
      if (footer) footer.textContent = '等待 TapTouch 同步';
    }

  } catch (err) {
    console.error('[App] refreshData failed:', err.message);
    serverOnline = false;
    if (syncDot) syncDot.classList.remove('live');
    if (statusBar) statusBar.textContent = '⚠️ 无法连接服务器';
    if (footer) {
      footer.textContent = cachedSummary ? 'TapTouch 上次成功数据（服务器离线）' : 'TapTouch 服务未连接';
    }
    setText(
      'chart-sub',
      cachedSummary
        ? '⚠️ 服务器暂时无响应 — 当前显示上次成功同步的数据'
        : '⚠️ 服务器未响应 — 请确认 node server.js 正在运行'
    );
  }

  startCountdown();
}

// ============================================================
// QUICK REFRESH (CURRENT COOKIE ONLY)
// ============================================================
function setRefreshButtonState(isRunning) {
  const btn = document.getElementById('refresh-btn');
  const icon = document.getElementById('refresh-btn-icon');
  const text = document.getElementById('refresh-btn-text');
  if (btn) btn.disabled = !!isRunning;
  if (icon) icon.classList.toggle('spinning', !!isRunning);
  if (text) text.textContent = isRunning ? '刷新中...' : '刷新';
}

function showSyncToast(title, log) {
  const toast = document.getElementById('scrape-toast');
  const spinner = document.getElementById('scrape-spinner');
  const toastTitle = document.getElementById('scrape-toast-title');
  const toastLog = document.getElementById('scrape-toast-log');

  if (spinner) {
    spinner.classList.remove('done');
    spinner.style.borderColor = '';
    spinner.style.borderTopColor = '';
  }
  if (toastTitle) toastTitle.textContent = title;
  if (toastLog) toastLog.textContent = log;
  toast?.classList.add('visible');
}

function updateSyncToast(title, log) {
  const toastTitle = document.getElementById('scrape-toast-title');
  const toastLog = document.getElementById('scrape-toast-log');
  if (toastTitle) toastTitle.textContent = title;
  if (toastLog) toastLog.textContent = log;
}

function markSyncToastDone(title, log, isError = false) {
  const spinner = document.getElementById('scrape-spinner');
  if (spinner) {
    spinner.style.borderColor = isError ? 'rgba(239,68,68,0.3)' : '';
    spinner.style.borderTopColor = isError ? '#ef4444' : '';
    spinner.classList.add('done');
  }
  updateSyncToast(title, log);
}

async function triggerCookieRefresh() {
  if (cookieRefreshRunning) return;
  cookieRefreshRunning = true;
  setRefreshButtonState(true);

  const toast = document.getElementById('scrape-toast');
  const spinner = document.getElementById('scrape-spinner');
  const toastTitle = document.getElementById('scrape-toast-title');
  const toastLog = document.getElementById('scrape-toast-log');

  spinner.classList.remove('done');
  spinner.style.borderColor = '';
  spinner.style.borderTopColor = '';
  toastTitle.textContent = '正在使用当前 Cookie 刷新...';
  toastLog.textContent = '直接请求 TapTouch URL 数据...';
  toast.classList.add('visible');

  try {
    const response = await fetch(`${CONFIG.apiBase}/api/auto-sync/run`, { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.needRelogin = !!payload.needRelogin;
      throw error;
    }

    await refreshData();
    toastTitle.textContent = '✅ 刷新完成';
    toastLog.textContent = '已使用当前 Cookie 获取最新数据';
    spinner.classList.add('done');
    setTimeout(hideScrapeToast, 2500);
  } catch (error) {
    const needRelogin = !!error.needRelogin;
    toastTitle.textContent = needRelogin ? '⚠️ Cookie 已失效' : '❌ 刷新失败';
    toastLog.textContent = needRelogin
      ? '请点击「从 TapTouch 同步」重新登录后再试'
      : (error.message || '请稍后重试');
    spinner.style.borderColor = 'rgba(239,68,68,0.3)';
    spinner.style.borderTopColor = '#ef4444';
    spinner.classList.add('done');
    setTimeout(hideScrapeToast, 5000);
  } finally {
    cookieRefreshRunning = false;
    setRefreshButtonState(false);
  }
}

async function waitForPageOpenSyncCompletion() {
  let coreDataRefreshed = false;

  for (let i = 0; i < 60; i += 1) {
    try {
      const scrapeState = await fetch(`${CONFIG.apiBase}/api/scrape/status`).then(r => r.json());
      const detailProgress = scrapeState.detailTotal ? `${scrapeState.detailReady || 0}/${scrapeState.detailTotal}` : '';

      if (scrapeState.coreReady && !coreDataRefreshed) {
        coreDataRefreshed = true;
        updateSyncToast(
          '⚡ 自动同步中，核心数据已更新',
          detailProgress ? `订单详情已就绪 ${detailProgress}` : '订单详情后台补齐中'
        );
        await refreshData();
      }

      if (scrapeState.running) {
        updateSyncToast(
          scrapeState.coreReady ? '⚡ 自动同步中，核心数据已更新' : '正在自动从 TapTouch 同步...',
          scrapeState.coreReady
            ? (detailProgress ? `后台继续补齐，订单详情 ${detailProgress}` : '后台继续补齐订单详情...')
            : (scrapeState.lastLog || '处理中...')
        );
      }

      if (!scrapeState.running) {
        if (scrapeState.error) {
          throw new Error(scrapeState.error || 'TapTouch sync failed');
        }
        await refreshData();
        markSyncToastDone(
          '✅ 自动同步完成',
          detailProgress ? `订单详情已就绪 ${detailProgress}` : 'TapTouch 数据已刷新'
        );
        setTimeout(hideScrapeToast, 2500);
        return true;
      }
    } catch (error) {
      if (i === 59) throw error;
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('TapTouch sync timed out');
}

async function autoSyncOnPageOpen() {
  if (pageOpenSyncPromise) return pageOpenSyncPromise;

  pageOpenSyncPromise = (async () => {
    const statusBar = document.getElementById('sync-label');
    const footer = document.getElementById('footer-data-source');

    if (statusBar) statusBar.textContent = '页面已打开，正在自动同步...';
    if (footer) footer.textContent = '正在自动同步 TapTouch';
    showSyncToast('页面已打开，正在自动同步...', '准备获取最新 TapTouch 数据...');

    try {
      const response = await fetch(`${CONFIG.apiBase}/api/auto-sync/run`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));

      if (response.ok && payload.ok !== false) {
        updateSyncToast('⚡ 自动同步中', '正在使用当前 Cookie 获取最新数据...');
        await refreshData();
        markSyncToastDone('✅ 自动同步完成', '已使用当前 Cookie 获取最新数据');
        setTimeout(hideScrapeToast, 2500);
        return true;
      }

      if (response.status === 409 || /正在运行|请稍后再试/i.test(payload.error || '')) {
        updateSyncToast('页面已打开，正在自动同步...', '已有同步任务在运行，正在等待结果...');
        await waitForPageOpenSyncCompletion();
        return true;
      }

      if (payload.needRelogin) {
        updateSyncToast('正在自动从 TapTouch 同步...', '当前 Cookie 已失效，准备重新登录 TapTouch...');
        const scrapeResp = await fetch(`${CONFIG.apiBase}/api/scrape/run`, { method: 'POST' });
        const scrapePayload = await scrapeResp.json().catch(() => ({}));

        if (!scrapeResp.ok) {
          throw new Error(scrapePayload.error || `HTTP ${scrapeResp.status}`);
        }

        if (scrapePayload.ok === false && !/正在运行/.test(scrapePayload.message || '')) {
          throw new Error(scrapePayload.message || 'TapTouch sync failed');
        }

        await waitForPageOpenSyncCompletion();
        return true;
      }

      throw new Error(payload.error || `HTTP ${response.status}`);
    } catch (error) {
      console.error('[App] autoSyncOnPageOpen failed:', error.message);
      if (statusBar) statusBar.textContent = '⚠️ 自动同步失败，请手动重试';
      if (footer) footer.textContent = '自动同步失败';
      markSyncToastDone('❌ 自动同步失败', error.message || '请手动重试', true);
      setTimeout(hideScrapeToast, 5000);
      return false;
    } finally {
      pageOpenSyncPromise = null;
    }
  })();

  return pageOpenSyncPromise;
}

// ============================================================
// TAPTOUCH SYNC BUTTON
// ============================================================
async function triggerScrape() {
  const btn      = document.getElementById('sync-btn');
  const btnIcon  = document.getElementById('sync-btn-icon');
  const btnText  = document.getElementById('sync-btn-text');
  const toast    = document.getElementById('scrape-toast');
  const spinner  = document.getElementById('scrape-spinner');
  const toastTitle = document.getElementById('scrape-toast-title');
  const toastLog   = document.getElementById('scrape-toast-log');

  btn.disabled = true;
  btnIcon.classList.add('spinning');
  btnText.textContent = '同步中...';

  spinner.classList.remove('done');
  spinner.style.borderColor = '';
  spinner.style.borderTopColor = '';
  toastTitle.textContent = '正在从 TapTouch 获取最新数据...';
  toastLog.textContent = '启动 Chrome 浏览器...';
  toast.classList.add('visible');

  try {
    const resp = await fetch(`${CONFIG.apiBase}/api/scrape/run`, { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    if (!json.ok) {
      toastTitle.textContent = '⚠️ ' + json.message;
      resetSyncBtn();
      return;
    }

    // Poll for completion every 2s
    let coreDataRefreshed = false;
    clearInterval(scrapePoller);
    scrapePoller = setInterval(async () => {
      try {
        const s = await fetch(`${CONFIG.apiBase}/api/scrape/status`).then(r => r.json());
        const detailProgress = s.detailTotal ? `${s.detailReady || 0}/${s.detailTotal}` : '';
        const detailMessage = detailProgress ? `订单详情 ${detailProgress}` : '订单详情后台补齐中';

        if (s.coreReady && !coreDataRefreshed) {
          coreDataRefreshed = true;
          toastTitle.textContent = '⚡ 核心数据已更新';
          toastLog.textContent = detailProgress
            ? `销售汇总已刷新，${detailMessage}`
            : '销售汇总已刷新，订单详情后台补齐中';
          btnText.textContent = '后台补详情...';
          await refreshData();
        } else if (s.running) {
          if (s.phase === 'starting') {
            toastTitle.textContent = '正在准备同步...';
          } else if (s.coreReady) {
            toastTitle.textContent = '⚡ 核心数据已更新';
          }
          toastLog.textContent = s.coreReady
            ? (detailProgress ? `后台继续补齐，${detailMessage}` : '后台继续补齐订单详情...')
            : (s.lastLog || '处理中...');
        }

        if (!s.running) {
          clearInterval(scrapePoller);

          if (s.error) {
            toastTitle.textContent = '❌ 同步失败';
            spinner.style.borderColor = 'rgba(239,68,68,0.3)';
            spinner.style.borderTopColor = '#ef4444';
            spinner.classList.add('done');
          } else {
            toastTitle.textContent = coreDataRefreshed ? '✅ 全部同步完成' : '✅ 数据已更新！';
            toastLog.textContent = s.detailTotal
              ? `订单详情已就绪 ${s.detailReady || 0}/${s.detailTotal}`
              : 'TapTouch 数据已刷新';
            spinner.classList.add('done');
            await refreshData();   // Immediately show new data
          }

          setTimeout(hideScrapeToast, 4000);
          resetSyncBtn();
        }
      } catch {
        toastLog.textContent = '等待服务器响应...';
      }
    }, 2000);

  } catch (err) {
    toastTitle.textContent = '❌ 无法连接服务器';
    toastLog.textContent = `请确认同步服务正在运行：${CONFIG.apiBase}`;
    spinner.style.borderColor = 'rgba(239,68,68,0.3)';
    spinner.style.borderTopColor = '#ef4444';
    spinner.classList.add('done');
    resetSyncBtn();
    setTimeout(hideScrapeToast, 6000);
  }
}

function resetSyncBtn() {
  const btn     = document.getElementById('sync-btn');
  const btnIcon = document.getElementById('sync-btn-icon');
  const btnText = document.getElementById('sync-btn-text');
  if (btn)     btn.disabled = false;
  if (btnIcon) btnIcon.classList.remove('spinning');
  if (btnText) btnText.textContent = '从 TapTouch 同步';
}

function hideScrapeToast() {
  document.getElementById('scrape-toast')?.classList.remove('visible');
}

// ============================================================
// INIT
// ============================================================
async function init() {
  setText('store-name-sidebar', CONFIG.restaurantName);
  selectedOrdersDate = getMelbourneDateString();
  productsViewDate = getMelbourneDateString();

  try {
    const savedThemePref = localStorage.getItem(THEME_PREF_KEY) || 'light';
    applyThemePreference(savedThemePref, { persist: false, rerender: false });
  } catch {
    applyThemePreference('light', { persist: false, rerender: false });
  }
  // No system-theme listener needed (we removed system mode)

  updateClock();
  setInterval(updateClock, 1000);
  applyRefreshCountdownUI(CONFIG.refreshIntervalMs / 1000);

  renderCameraStrip();
  setSalesViewMode(salesViewMode);
  syncOrdersDateControls(false);
  showPage(currentPage);

  renderTopItems();
  renderProductsPage(null);
  renderDataContextPage(null);
  renderDailyReportPage(null);
  // Load real data immediately
  await refreshData();
  await autoSyncOnPageOpen();
}

let appBootstrapped = false;

function bootApp() {
  if (appBootstrapped) return;
  appBootstrapped = true;
  void init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}

window.addEventListener('legacy-shell-ready', bootApp);

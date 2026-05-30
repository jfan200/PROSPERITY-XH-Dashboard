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

function renderOrdersPage(orders) {
  allOrdersCache = orders || [];
  setText('orders-page-sub', `共 ${allOrdersCache.length} 笔订单 · 点击行查看菜品明细`);
  _renderOrdersTable(allOrdersCache);
}

function _renderOrdersTable(orders) {
  const tbody = document.getElementById('orders-page-tbody');
  if (!tbody) return;
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:32px">暂无订单</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map(o => {
    const statusCls = o.status === 'paid' ? 'paid' : o.status === 'refunded' ? 'refund' : 'pending';
    const hasDetail = !!orderDetailsCache[o.txId || o.id];
    return `
      <tr onclick="openOrderModal('${o.txId || o.id}','${o.id}')" style="cursor:pointer">
        <td>
          <span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;color:var(--text-1)">${o.id}</span>
          ${hasDetail ? '<span style="font-size:9px;color:var(--blue);margin-left:4px">●详情</span>' : ''}
        </td>
        <td style="color:var(--text-2);font-size:12px">${o.source || '-'}</td>
        <td><span style="background:rgba(99,179,237,0.12);color:var(--cyan);padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">${o.type || '-'}</span></td>
        <td style="color:var(--text-2);font-size:12px;white-space:nowrap">${o.date}</td>
        <td style="color:var(--text-3);font-size:11px">${o.cashier || '-'}</td>
        <td style="color:var(--text-3);font-size:12px">${o.tax || '$0'}</td>
        <td style="font-weight:700;color:var(--text-1)">${o.amount}</td>
        <td><span class="order-status ${statusCls}">${o.status === 'paid' ? '✓ 已付款' : o.status === 'refunded' ? '↩ 退款' : '◷ 处理中'}</span></td>
      </tr>`;
  }).join('');
}

function filterOrders(query) {
  const q = query.toLowerCase().trim();
  if (!q) { _renderOrdersTable(allOrdersCache); return; }
  _renderOrdersTable(allOrdersCache.filter(o =>
    o.id?.toLowerCase().includes(q) ||
    o.txId?.toLowerCase().includes(q) ||
    o.type?.toLowerCase().includes(q) ||
    o.source?.toLowerCase().includes(q) ||
    o.date?.includes(q)
  ));
}

// ============================================================
// ORDER DETAIL MODAL
// ============================================================
async function openOrderModal(txId, orderId) {
  const modal = document.getElementById('order-modal');
  const title = document.getElementById('order-modal-title');
  const body  = document.getElementById('order-modal-body');
  if (!modal) return;

  title.textContent = `订单 ${orderId} 详情`;
  body.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:24px">
    <div style="font-size:24px;margin-bottom:8px">⏳</div>加载中...
  </div>`;
  modal.classList.add('active');

  // Check local cache first
  let detail = orderDetailsCache[txId] || orderDetailsCache[orderId];

  // Try API if not in cache
  if (!detail) {
    try {
      const res = await fetch(`${CONFIG.apiBase}/api/orders/detail/${txId}`);
      if (res.ok) {
        detail = await res.json();
        orderDetailsCache[txId] = detail;
        if (orderId) orderDetailsCache[orderId] = detail;
        _renderOrdersTable(allOrdersCache);
      }
    } catch {}
  }

  if (detail && detail.items && detail.items.length > 0) {
    const receiptMeta = detail.receipt || {};
    const totals = detail.totals || {};
    const paymentMethods = detail.payment?.methods || [];

    // Render item breakdown
    const itemRows = detail.items.map(item => `
      <tr>
        <td style="color:var(--text-1);font-weight:500">
          <div>${item.name}</div>
          ${item.note ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px;line-height:1.5;white-space:pre-line">${item.note}</div>` : ''}
        </td>
        <td style="color:var(--text-2);text-align:center">${item.qty}</td>
        <td style="color:var(--text-2);text-align:right">${formatDetailAmount(item.price)}</td>
        <td style="color:var(--text-1);font-weight:600;text-align:right">${formatDetailAmount(item.subtotal || item.price)}</td>
      </tr>
    `).join('');

    // Find order in allOrdersCache for extra info
    const order = allOrdersCache.find(o => o.txId === txId || o.id === orderId) || {};
    const primaryTotal = totals.totalPaid || totals.total || parseMoneyText(order.amount);
    const totalRows = [
      totals.subtotal ? ['小计', formatCurrency(totals.subtotal)] : null,
      totals.gst ? ['GST', formatCurrency(totals.gst)] : null,
      totals.surcharge ? ['Surcharge', formatCurrency(totals.surcharge)] : null,
      ...paymentMethods.map(method => [method.label, formatCurrency(method.amount)]),
    ].filter(Boolean);

    body.innerHTML = `
      <!-- Order Meta -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
        <div style="background:var(--bg-card);border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:var(--text-3);margin-bottom:4px">时间</div>
          <div style="font-size:13px;font-weight:600">${receiptMeta.orderTime || order.date || '-'}</div>
        </div>
        <div style="background:var(--bg-card);border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:var(--text-3);margin-bottom:4px">类型</div>
          <div style="font-size:13px;font-weight:600">${receiptMeta.fulfillment || order.type || '-'}</div>
        </div>
        <div style="background:var(--bg-card);border-radius:8px;padding:12px;text-align:center">
          <div style="font-size:10px;color:var(--text-3);margin-bottom:4px">交易ID</div>
          <div style="font-size:13px;font-weight:600">${detail.txId || order.txId || txId || '-'}</div>
        </div>
      </div>

      <!-- Items Table -->
      <div style="font-size:11px;color:var(--text-3);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">菜品明细</div>
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--bg-card)">
              <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-3);font-weight:600">菜品</th>
              <th style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-3);font-weight:600">数量</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-3);font-weight:600">单价</th>
              <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-3);font-weight:600">小计</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
      </div>

      <!-- Totals -->
      <div style="border-top:1px solid var(--border);padding-top:12px;display:flex;flex-direction:column;gap:6px">
        ${totalRows.map(([label, value]) => `
          <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-2)">
            <span>${label}</span>
            <span>${value}</span>
          </div>
        `).join('')}
        <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;color:var(--text-1);margin-top:4px">
          <span>${totals.totalPaid ? '实付' : '合计'}</span>
          <span style="color:var(--blue)">${primaryTotal ? formatCurrency(primaryTotal) : (order.amount || '-')}</span>
        </div>
      </div>
      ${detail.url ? `
        <div style="margin-top:14px;text-align:right">
          <a href="${detail.url}" target="_blank" rel="noreferrer" style="font-size:12px;color:var(--blue);text-decoration:none">
            在 TapTouch 打开 receipt
          </a>
        </div>
      ` : ''}
    `;
  } else {
    // No detail scraped — show basic info from order list
    const order = allOrdersCache.find(o => o.txId === txId || o.id === orderId) || {};
    body.innerHTML = `
      <div style="background:var(--bg-card);border-radius:8px;padding:16px;margin-bottom:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          ${[
            ['订单号', order.id || orderId],
            ['交易ID', order.txId || txId],
            ['时间', order.date || '-'],
            ['类型', order.type || '-'],
            ['来源', order.source || '-'],
            ['收银员', order.cashier || '-'],
            ['税', order.tax || '$0'],
            ['总额', order.amount || '-'],
          ].map(([k,v]) => `
            <div>
              <div style="font-size:10px;color:var(--text-3);margin-bottom:2px">${k}</div>
              <div style="font-size:13px;font-weight:600;color:var(--text-1)">${v}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div style="color:var(--text-3);font-size:12px;text-align:center;padding:8px">
        💡 这笔订单的详情暂时未缓存，可稍后重试
      </div>
    `;
  }
}

function closeOrderModal() {
  document.getElementById('order-modal')?.classList.remove('active');
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

function renderSalesDailyBreakdown(weeklyOverview) {
  const el = document.getElementById('sales-daily-breakdown');
  if (!el) return;

  const days = weeklyOverview?.daily || [];
  if (!days.length) {
    el.innerHTML = `<div class="sales-empty-state">暂无每周分析数据</div>`;
    return;
  }

  el.innerHTML = days.map(day => `
    <div class="sales-daily-item ${day.isToday ? 'is-today' : ''}">
      <div class="sales-daily-head">
        <div>
          <div class="sales-daily-label">${day.weekday}</div>
          <div class="sales-daily-date">${day.fullLabel}</div>
        </div>
        <span class="sales-daily-badge ${day.hasData ? 'has-data' : 'is-empty'}">
          ${day.hasData ? `${day.orders} 单` : '暂无数据'}
        </span>
      </div>
      <div class="sales-daily-metric">${formatCurrency(day.revenue)}</div>
      <div class="sales-daily-sub">平均客单价 ${formatCurrency(day.avgTicket)}</div>
    </div>
  `).join('');
}

function renderSalesPage(summary, hourlySales) {
  const container = document.getElementById('sales-summary-cards');
  if (!container || !summary) return;
  const weeklyContainer = document.getElementById('sales-weekly-cards');
  const salesSummarySub = document.getElementById('sales-summary-sub');
  const weeklySub = document.getElementById('sales-weekly-sub');
  const weeklyOverview = summary.weeklyOverview || null;

  const cards = [
    { icon: '💰', label: '今日总销售', value: formatCurrency(summary.totalRevenue),                          color: '#3b82f6' },
    { icon: '📋', label: '今日订单数', value: `${summary.totalOrders || 0} 单`,                  color: '#10b981' },
    { icon: '📊', label: '平均客单价', value: formatCurrency(summary.avgTicket),                           color: '#f59e0b' },
    ...(summary.payments || []).map(p => ({
      icon: p.label === 'Card' ? '💳' : p.label === 'Cash' ? '💵' : '🔗',
      label: p.label,
      value: formatCurrency(p.value),
      sub: `${p.pct}%`,
      color: p.color,
    })),
  ];

  container.innerHTML = cards.map(c => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;
                padding:16px 20px;min-width:140px;flex:1;position:relative;overflow:hidden">
      <div style="position:absolute;top:0;left:0;width:3px;height:100%;background:${c.color};border-radius:10px 0 0 10px"></div>
      <div style="font-size:20px;margin-bottom:6px">${c.icon}</div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:4px">${c.label}</div>
      <div style="font-size:20px;font-weight:700;color:var(--text-1)">${c.value}</div>
      ${c.sub ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${c.sub}</div>` : ''}
    </div>
  `).join('');

  if (salesSummarySub) {
    salesSummarySub.textContent = weeklyOverview?.dateRangeLabel
      ? `今日实时数据 + 本周历史汇总（${weeklyOverview.dateRangeLabel}）`
      : '来自 TapTouch 实时数据';
  }

  if (weeklySub) {
    weeklySub.textContent = weeklyOverview?.dateRangeLabel
      ? `${weeklyOverview.dateRangeLabel} 销售额与订单量走势`
      : '最近 7 天销售额与订单量';
  }

  if (weeklyContainer) {
    const insightCards = weeklyOverview ? [
      { icon: '🗓', label: '本周销售额', value: formatCurrency(weeklyOverview.totalRevenue), sub: `${weeklyOverview.activeDays} 天有营业数据`, color: '#3b82f6' },
      { icon: '🧾', label: '本周订单量', value: `${weeklyOverview.totalOrders || 0} 单`, sub: `周均客单价 ${formatCurrency(weeklyOverview.avgTicket)}`, color: '#10b981' },
      { icon: '🔥', label: '最佳营业日', value: weeklyOverview.bestDay?.fullLabel || '暂无', sub: weeklyOverview.bestDay ? `${formatCurrency(weeklyOverview.bestDay.revenue)} · ${weeklyOverview.bestDay.orders} 单` : '等待同步本周数据', color: '#f59e0b' },
      { icon: '📈', label: '周内分析', value: weeklyOverview.bestDay ? `峰值 ${weeklyOverview.bestDay.label}` : '数据不足', sub: weeklyOverview.bestDay ? `平均客单价 ${formatCurrency(weeklyOverview.bestDay.avgTicket)}` : '完成本周同步后显示', color: '#8b5cf6' },
    ] : [];

    weeklyContainer.innerHTML = insightCards.length
      ? insightCards.map(card => `
          <div class="sales-insight-card">
            <div class="sales-insight-accent" style="background:${card.color}"></div>
            <div class="sales-insight-icon">${card.icon}</div>
            <div class="sales-insight-label">${card.label}</div>
            <div class="sales-insight-value">${card.value}</div>
            <div class="sales-insight-sub">${card.sub || ''}</div>
          </div>
        `).join('')
      : `<div class="sales-empty-state">完成一次本周同步后，这里会显示历史分析。</div>`;
  }

  renderSalesDailyBreakdown(weeklyOverview);

  setTimeout(() => renderWeeklyChart(weeklyOverview), 50);
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
  refreshIntervalMs: 60 * 1000,

  cameras: [
    { id: 'cam-1', name: '前台收银', type: 'Xiaomi',     isOnline: false, go2rtcUrl: null },
    { id: 'cam-2', name: '厨房',     type: 'Dahua/DMSS', isOnline: false, go2rtcUrl: null },
    { id: 'cam-3', name: '店门口',   type: 'Dahua/DMSS', isOnline: false, go2rtcUrl: null },
    { id: 'cam-4', name: '用餐区',   type: 'Xiaomi',     isOnline: false, go2rtcUrl: null },
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
let countdownSec     = 60;
let countdownTimer   = null;
let scrapePoller     = null;
let serverOnline     = false;

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
  if (salesChartInst) salesChartInst.destroy();

  const labels   = hourlySales.map(d => d.hour);
  const revenues = hourlySales.map(d => d.revenue);

  const barColors = hourlySales.map(d =>
    d.isFuture  ? 'rgba(255,255,255,0.04)' :
    d.isCurrent ? 'rgba(245,158,11,0.8)'  : 'rgba(59,130,246,0.75)'
  );
  const borderColors = hourlySales.map(d =>
    d.isFuture  ? 'rgba(255,255,255,0.06)' :
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
        pointBorderColor: '#fff',
        pointBorderWidth: 1.5,
        pointRadius: currentChartType === 'line' ? 4 : 0,
        pointHoverRadius: 6,
      }],
    },
    options: chartOptions('$'),
  });
}

// ============================================================
// PAYMENT METHOD DONUT
// ============================================================
function renderSourceChart(payments) {
  const canvas = document.getElementById('source-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (sourceChartInst) sourceChartInst.destroy();

  if (!payments || payments.length === 0) return;

  sourceChartInst = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: payments.map(p => p.label),
      datasets: [{
        data: payments.map(p => p.value),
        backgroundColor: payments.map(p => p.color),
        borderColor: '#161e2e',
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
          backgroundColor: '#161e2e',
          borderColor: 'rgba(99,179,237,0.3)',
          borderWidth: 1,
          titleColor: '#8899bb',
          bodyColor: '#f0f4ff',
          padding: 10,
          callbacks: {
            label: (i) => ` $${Number(i.raw).toFixed(2)} (${payments[i.dataIndex]?.pct || 0}%)`,
          },
        },
      },
    },
  });

  // Legend
  const legend = document.getElementById('donut-legend');
  if (legend) {
    legend.innerHTML = payments.map(p => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${p.color}"></span>
        <span>${p.label}</span>
        <span class="legend-val">$${p.value.toFixed(2)} (${p.pct}%)</span>
      </div>
    `).join('');
  }
}

// ============================================================
// WEEKLY CHART
// ============================================================
function renderWeeklyChart(weeklyOverview) {
  const canvas = document.getElementById('weekly-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (weeklyChartInst) weeklyChartInst.destroy();

  const daily = weeklyOverview?.daily || [];
  if (!daily.length) return;

  weeklyChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: daily.map(day => day.label),
      datasets: [
        {
          label: '销售额 AUD',
          data: daily.map(day => day.revenue),
          backgroundColor: daily.map(day =>
            day.isToday ? 'rgba(245,158,11,0.78)' :
            day.hasData ? 'rgba(59,130,246,0.72)' :
            'rgba(255,255,255,0.05)'
          ),
          borderColor: daily.map(day =>
            day.isToday ? '#f59e0b' :
            day.hasData ? '#3b82f6' :
            'rgba(255,255,255,0.08)'
          ),
          borderWidth: 1,
          borderRadius: 5,
          yAxisID: 'y',
        },
        {
          label: '订单数',
          data: daily.map(day => day.orders),
          type: 'line',
          tension: 0.35,
          fill: false,
          borderColor: 'rgba(16,185,129,0.72)',
          borderWidth: 2,
          pointBackgroundColor: daily.map(day => day.hasData ? '#10b981' : 'rgba(255,255,255,0.18)'),
          pointRadius: 3,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#8899bb', font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161e2e',
          borderColor: 'rgba(99,179,237,0.3)',
          borderWidth: 1,
          titleColor: '#8899bb',
          bodyColor: '#f0f4ff',
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
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#8899bb', font: { size: 10 } },
          border: { display: false },
        },
        y: {
          position: 'left',
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#8899bb',
            callback: v => `$${v}`,
            maxTicksLimit: 5,
          },
          border: { display: false },
        },
        y1: {
          position: 'right',
          beginAtZero: true,
          grid: { display: false },
          ticks: {
            color: '#10b981',
            callback: v => `${v}单`,
            maxTicksLimit: 5,
          },
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
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:24px">暂无订单数据</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => `
    <tr>
      <td>
        <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-1);font-weight:600">${o.id}</span>
        <span style="font-size:10px;color:var(--text-3);margin-left:4px">${o.source || ''}</span>
      </td>
      <td style="color:var(--text-2)">${o.date}</td>
      <td>
        <span style="background:rgba(99,179,237,0.12);color:var(--cyan);
                     padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">
          ${o.type || 'Dine In'}
        </span>
      </td>
      <td style="font-weight:700;color:var(--text-1)">${o.amount}</td>
      <td>
        <span class="order-status ${o.status === 'paid' ? 'paid' : o.status === 'refunded' ? 'refund' : 'pending'}">
          ${o.status === 'paid' ? '✓ 已付款' : o.status === 'refunded' ? '↩ 退款' : '◷ 处理中'}
        </span>
      </td>
    </tr>
  `).join('');
}

// ============================================================
// PERIOD PERFORMANCE BARS
// ============================================================
function renderPerf(hourlySales) {
  const list = document.getElementById('perf-list');
  if (!list) return;

  const periods = [
    { label: '早市 11AM–2PM', hours: ['11:00','12:00','13:00'] },
    { label: '下午 2PM–5PM',  hours: ['14:00','15:00','16:00'] },
    { label: '晚市 5PM–9PM',  hours: ['17:00','18:00','19:00','20:00'] },
  ];

  const maxRev = Math.max(...hourlySales.map(d => d.revenue), 1);

  list.innerHTML = periods.map(p => {
    const rev = hourlySales.filter(d => p.hours.includes(d.hour)).reduce((s, d) => s + d.revenue, 0);
    const pct = Math.min(Math.round(rev / maxRev * 100), 100);
    return `
      <div class="perf-item">
        <div class="perf-item-row">
          <span class="perf-item-label">${p.label}</span>
          <span class="perf-item-val">$${rev.toFixed(0)}</span>
        </div>
        <div class="perf-bar-bg">
          <div class="perf-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// TOP ITEMS (placeholder — extend scraper to get product data)
// ============================================================
function renderTopItems() {
  const el = document.getElementById('top-items');
  if (el) el.innerHTML = `<div style="color:var(--text-3);font-size:12px;padding:12px 0">点击"同步"按钮后获取菜品数据</div>`;
}

// ============================================================
// SHARED CHART OPTIONS
// ============================================================
function chartOptions(prefix = '') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#161e2e',
        borderColor: 'rgba(99,179,237,0.3)',
        borderWidth: 1,
        titleColor: '#8899bb',
        bodyColor: '#f0f4ff',
        padding: 10,
        callbacks: {
          label: (i) => ` ${prefix}${Number(i.raw).toFixed(2)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
        ticks: { color: '#8899bb', font: { size: 10, family: 'Inter' } },
        border: { display: false },
      },
      y: {
        grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
        ticks: {
          color: '#8899bb', font: { size: 10, family: 'Inter' },
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

  const html = CONFIG.cameras.map((cam, i) => `
    <div class="cam-tile" onclick="openCamModal(${i})" id="cam-tile-${cam.id}">
      <div class="cam-tile-preview">
        ${cam.isOnline
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
      </div>
      <div class="cam-tile-foot">
        <span class="cam-tile-name">${cam.name}</span>
        <span class="cam-tile-status">
          <span class="dot-s ${cam.isOnline ? 'dot-green' : 'dot-red'}"></span>
          ${cam.isOnline ? '在线' : '离线'}
        </span>
      </div>
    </div>
  `).join('');

  strip.innerHTML = html;
  if (fullGrid) fullGrid.innerHTML = html;
  setText('nav-cam-badge', CONFIG.cameras.length);
}

function openCamModal(index) {
  const cam   = CONFIG.cameras[index];
  const modal = document.getElementById('cam-modal');
  const title = document.getElementById('cam-modal-title');
  const body  = document.getElementById('cam-modal-body');
  if (title) title.textContent = `📷 ${cam.name} — ${cam.type}`;
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
  ['dashboard','cameras','sales','orders','products'].forEach(p => {
    document.getElementById(`page-${p}`)?.classList.toggle('hidden', p !== page);
  });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`nav-${page}`)?.classList.add('active');

  const titles = {
    dashboard: ['仪表板',   '实时运营概览'],
    cameras:   ['摄像头监控', '实时画面'],
    sales:     ['销售报表', `今日 ${cachedSummary ? '$'+cachedSummary.totalRevenue : '--'} | ${cachedSummary?.totalOrders || '--'} 单`],
    orders:    ['今日订单', `共 ${allOrdersCache.length} 笔 — 点击查看详情`],
    products:  ['热销菜品', '今日排行'],
  };
  const [t, s] = titles[page] || ['', ''];
  setText('page-title', t);
  setText('page-subtitle', s);

  // Re-render sales chart when switching to sales page
  if (page === 'sales' && cachedSummary) {
    renderSalesPage(cachedSummary, currentSalesData);
  }
}

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('collapsed');
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
  countdownTimer = setInterval(async () => {
    countdownSec--;
    setText('countdown-text', `${countdownSec}s`);
    setText('footer-countdown', `${countdownSec}s`);
    if (countdownSec <= 0) {
      clearInterval(countdownTimer);
      await refreshData();
    }
  }, 1000);
}

// ============================================================
// MAIN REFRESH — ONLY REAL DATA
// ============================================================
let cachedSummary = null;

async function refreshData() {
  const statusBar = document.getElementById('sync-label');
  const footer = document.getElementById('footer-data-source');
  const syncDot = document.querySelector('.sync-dot');

  try {
    const { hourly, summary, orders } = await fetchLiveData();

    currentSalesData = hourly;
    currentPayments  = summary.payments || [];
    cachedSummary    = summary;

    // Dashboard page
    renderKPIs(summary, hourly);
    renderSalesChart(hourly);
    renderSourceChart(summary.payments || []);
    renderOrders(orders.slice(0, 10));  // Show latest 10 on dashboard
    renderPerf(hourly);

    // Orders page (all orders + details)
    renderOrdersPage(orders);

    // Sales page (update if visible)
    renderSalesPage(summary, hourly);

    // Status
    serverOnline = true;
    if (syncDot) syncDot.classList.add('live');
    if (statusBar) statusBar.textContent = 'TapTouch 实时数据';

    const now = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
    }).format(new Date());
    setText('last-updated', `最后更新: ${now}`);
    setText('chart-sub', `TapTouch 真实数据 — 抓取于 ${(summary.scrapedAt || '').replace('T',' ').substring(0,16)}`);
    if (footer) footer.textContent = 'TapTouch 真实数据';

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

  updateClock();
  setInterval(updateClock, 1000);

  renderCameraStrip();

  // Load real data immediately
  await refreshData();
}

document.addEventListener('DOMContentLoaded', init);

'use strict';

// ============================================================
// MOBILE DASHBOARD - JAVASCRIPT
// ============================================================

// Configuration
const CONFIG = {
  apiBase: window.location.origin,
  refreshInterval: 300000, // 5 minutes
  cameras: [
    {
      id: 'cam-1',
      name: '厨房',
      type: 'Xiaomi 云台2K',
      isOnline: true,
      go2rtcUrl: 'http://localhost:1984/stream.html?src=dining_room&mode=webrtc',
      note: '已接入 go2rtc 实时视频流',
    },
    {
      id: 'cam-2',
      name: '前台收银',
      type: 'Xiaomi',
      isOnline: false,
      go2rtcUrl: null,
      note: '当前离线',
    },
    {
      id: 'cam-3',
      name: '店门口',
      type: 'Dahua/DMSS',
      isOnline: false,
      go2rtcUrl: null,
      note: '等待接入',
    },
    {
      id: 'cam-4',
      name: '用餐区',
      type: 'Dahua/DMSS',
      isOnline: false,
      go2rtcUrl: null,
      note: '等待接入',
    },
  ],
};

// State
const state = {
  currentPage: 'dashboard',
  selectedDate: getMelbourneDateString(),
  ordersCache: [],
  orderDetailsCache: {},
  summary: null,
  hourlySales: [],
  weeklyOverview: null,
  products: [],
  recentOrders: [],
  productsMode: 'today',
  productsAnalysis: null,
  dataContext: null,
  dailyReport: null,
  activeCamera: null,
  activeOrder: null,
  orderSearchQuery: '',
  theme: localStorage.getItem('theme') || 'dark',
  lastSync: null,
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function getMelbourneDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  const msg = document.getElementById('toast-message');
  
  icon.textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  msg.textContent = message;
  toast.className = `toast ${type} show`;
  
  setTimeout(() => {
    toast.className = 'toast';
  }, 3000);
}

function switchToDesktop() {
  window.DashboardViewSwitch?.switchTo('desktop');
}

// ============================================================
// THEME MANAGEMENT
// ============================================================

function initTheme() {
  document.body.setAttribute('data-theme', state.theme);
  updateThemeIcon();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', state.theme);
  document.body.setAttribute('data-theme', state.theme);
  updateThemeIcon();
  updateChartsTheme();
}

function updateThemeIcon() {
  const icon = document.getElementById('theme-icon');
  icon.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function getThemeColors() {
  const isLight = state.theme === 'light';
  return {
    text: isLight ? '#1a1a1a' : '#f0f6ff',
    textSecondary: isLight ? '#666666' : '#8b949e',
    grid: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)',
    accent: isLight ? '#2563eb' : '#3b82f6',
    success: isLight ? '#059669' : '#10b981',
    warning: isLight ? '#d97706' : '#f59e0b',
    purple: isLight ? '#7c3aed' : '#8b5cf6',
  };
}

// ============================================================
// NAVIGATION
// ============================================================

function showPage(pageName) {
  state.currentPage = pageName;
  
  // Update pages
  document.querySelectorAll('.page').forEach(page => {
    page.classList.remove('active');
  });
  document.getElementById(`page-${pageName}`).classList.add('active');
  
  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });
  document.querySelector(`.nav-item[data-page="${pageName}"]`).classList.add('active');
  
  // Scroll to top
  document.querySelector('.mobile-main').scrollTop = 0;
  
  // Load page specific data
  if (pageName === 'orders') {
    loadOrdersForDate(state.selectedDate);
  }
  if (pageName === 'products') {
    loadProductsAnalysis(state.productsMode);
  }
  if (pageName === 'more') {
    loadMorePage();
  }
}

// ============================================================
// DATA FETCHING
// ============================================================

async function fetchJson(path) {
  try {
    const response = await fetch(`${CONFIG.apiBase}${path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`Fetch error: ${path}`, error);
    throw error;
  }
}

async function fetchSummary() {
  try {
    const data = await fetchJson('/api/sales/summary');
    state.summary = data;
    return data;
  } catch (error) {
    console.error('Failed to fetch summary:', error);
    return null;
  }
}

async function fetchHourlySales() {
  try {
    const data = await fetchJson('/api/sales/hourly');
    state.hourlySales = data;
    return data;
  } catch (error) {
    console.error('Failed to fetch hourly sales:', error);
    return [];
  }
}

async function fetchRecentOrders() {
  try {
    const data = await fetchJson('/api/orders/recent');
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Failed to fetch recent orders:', error);
    return [];
  }
}

async function fetchOrdersForDate(dateKey) {
  try {
    const data = await fetchJson(`/api/orders/by-date?date=${encodeURIComponent(dateKey)}`);
    return data;
  } catch (error) {
    console.error('Failed to fetch orders:', error);
    return { orders: [], dateKey };
  }
}

async function fetchOrderDetail(txId) {
  try {
    const data = await fetchJson(`/api/orders/detail/${encodeURIComponent(txId)}`);
    return data;
  } catch (error) {
    console.error('Failed to fetch order detail:', error);
    return null;
  }
}

async function fetchProductsAnalysis(mode = 'today') {
  try {
    return await fetchJson(`/api/products/analysis?mode=${encodeURIComponent(mode)}`);
  } catch (error) {
    console.error('Failed to fetch product analysis:', error);
    return null;
  }
}

async function fetchDataContext() {
  try {
    return await fetchJson('/api/data-context');
  } catch (error) {
    console.error('Failed to fetch data context:', error);
    return null;
  }
}

async function fetchDailyReport() {
  try {
    const data = await fetchJson('/api/reports/daily/latest');
    return data?.ok === false ? null : data;
  } catch (error) {
    console.error('Failed to fetch daily report:', error);
    return null;
  }
}

// ============================================================
// SYNC DATA
// ============================================================

async function syncData() {
  const syncBtn = document.querySelector('.sync-btn');
  const banner = document.getElementById('sync-banner');
  
  syncBtn.classList.add('syncing');
  banner.className = 'sync-banner';
  banner.querySelector('.sync-banner-title').textContent = '正在同步...';
  banner.querySelector('.sync-banner-sub').textContent = '从 TapTouch 获取最新数据';
  
  try {
    // Try cookie refresh first
    const response = await fetch(`${CONFIG.apiBase}/api/auto-sync/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Sync failed');
    }
    
    const result = await response.json();
    
    // Wait a bit for data to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Reload all data
    await loadDashboardData();
    if (state.currentPage === 'products') {
      await loadProductsAnalysis(state.productsMode, true);
    }
    if (state.currentPage === 'more') {
      await loadMorePage(true);
    }
    
    banner.className = 'sync-banner success';
    banner.querySelector('.sync-banner-title').textContent = '已完成同步';
    banner.querySelector('.sync-banner-sub').textContent = `最后更新: ${new Date().toLocaleTimeString()}`;
    
    showToast('数据同步成功', 'success');
    
  } catch (error) {
    console.error('Sync failed:', error);
    banner.className = 'sync-banner error';
    banner.querySelector('.sync-banner-title').textContent = '同步失败';
    banner.querySelector('.sync-banner-sub').textContent = error.message;
    
    showToast('同步失败: ' + error.message, 'error');
    
  } finally {
    syncBtn.classList.remove('syncing');
    state.lastSync = new Date();
  }
}

// ============================================================
// DASHBOARD RENDERING
// ============================================================

async function loadDashboardData() {
  const [summary, hourly, orders] = await Promise.all([
    fetchSummary(),
    fetchHourlySales(),
    fetchRecentOrders(),
  ]);
  
  state.recentOrders = orders;
  renderKPIs(summary);
  renderHourlyChart(hourly);
  renderWeeklyOverview(summary?.weeklyOverview);
  renderRecentOrders(orders);
  renderTopItems(summary?.products);
}

function renderKPIs(summary) {
  if (!summary) return;
  
  document.getElementById('kpi-revenue').textContent = formatCurrency(summary.totalRevenue);
  document.getElementById('kpi-orders').textContent = `${summary.totalOrders || 0} 单`;
  document.getElementById('kpi-avg').textContent = formatCurrency(summary.avgTicket);
  
  // Find peak hour
  const peakHour = state.hourlySales.reduce((peak, hour) => 
    hour.revenue > (peak?.revenue || 0) ? hour : peak, null);
  
  if (peakHour) {
    document.getElementById('kpi-peak').textContent = peakHour.hour;
    document.getElementById('kpi-peak-rev').textContent = formatCurrency(peakHour.revenue);
  }
  
  // Update sync banner
  if (summary.hasLiveData) {
    const banner = document.getElementById('sync-banner');
    banner.className = 'sync-banner success';
    banner.querySelector('.sync-banner-title').textContent = '实时数据';
    banner.querySelector('.sync-banner-sub').textContent = 
      `最后更新: ${new Date(summary.lastUpdated).toLocaleTimeString()}`;
  }
}

let hourlyChartInst = null;

function renderHourlyChart(hourlySales) {
  if (!hourlySales?.length) return;
  
  const canvas = document.getElementById('hourly-chart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const colors = getThemeColors();
  
  // Filter business hours
  const BUSINESS_HOURS = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', 
    '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '00:00'];
  
  const filtered = BUSINESS_HOURS.map(h => {
    const found = hourlySales.find(d => d.hour === h);
    return found || { hour: h, revenue: 0, orders: 0, isFuture: true };
  });
  
  const peakIdx = filtered.reduce((peak, v, i) => v.revenue > (filtered[peak]?.revenue || 0) ? i : peak, 0);
  
  if (hourlyChartInst) hourlyChartInst.destroy();
  
  hourlyChartInst = new Chart(ctx, {
    type: currentChartType,
    data: {
      labels: filtered.map(d => d.hour),
      datasets: [{
        label: '销售额',
        data: filtered.map(d => d.revenue),
        backgroundColor: filtered.map((d, i) => 
          i === peakIdx ? colors.warning : 
          d.isFuture ? 'rgba(128,128,128,0.1)' : 
          colors.accent
        ),
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.text,
          titleColor: state.theme === 'dark' ? '#1a1a1a' : '#ffffff',
          bodyColor: state.theme === 'dark' ? '#1a1a1a' : '#ffffff',
          callbacks: {
            label: (item) => ` ${formatCurrency(item.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { 
            color: colors.textSecondary,
            font: { size: 10 },
            maxRotation: 0,
            callback: (val, idx) => idx % 2 === 0 ? filtered[idx]?.hour : '',
          },
        },
        y: {
          grid: { color: colors.grid },
          ticks: { 
            color: colors.textSecondary,
            callback: (v) => `$${v}`,
            maxTicksLimit: 4,
          },
          border: { display: false },
        },
      },
    },
  });
}

let weeklyChartInst = null;

function renderWeeklyOverview(weekly) {
  if (!weekly) return;
  
  document.getElementById('week-range').textContent = weekly.dateRangeLabel || '--';
  document.getElementById('weekly-revenue').textContent = formatCurrency(weekly.totalRevenue);
  document.getElementById('weekly-days').textContent = `${weekly.activeDays} 天`;
  document.getElementById('weekly-best').textContent = weekly.bestDay?.label || '--';
  
  const canvas = document.getElementById('weekly-chart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const colors = getThemeColors();
  
  if (weeklyChartInst) weeklyChartInst.destroy();
  
  weeklyChartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: weekly.daily.map(d => d.label),
      datasets: [{
        label: '销售额',
        data: weekly.daily.map(d => d.revenue),
        backgroundColor: weekly.daily.map(d => 
          d.isToday ? colors.accent : 
          d.hasData ? colors.accent + '80' : 
          'rgba(128,128,128,0.1)'
        ),
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.text,
          titleColor: state.theme === 'dark' ? '#1a1a1a' : '#ffffff',
          bodyColor: state.theme === 'dark' ? '#1a1a1a' : '#ffffff',
          callbacks: {
            label: (item) => ` ${formatCurrency(item.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { 
            color: colors.textSecondary,
            font: { size: 11 },
          },
        },
        y: {
          grid: { color: colors.grid },
          ticks: { 
            color: colors.textSecondary,
            callback: (v) => `$${v}`,
            maxTicksLimit: 3,
          },
          border: { display: false },
        },
      },
    },
  });
}

function renderRecentOrders(orders) {
  const container = document.getElementById('recent-orders');
  if (!orders?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧾</div>
        <div class="empty-text">暂无订单数据</div>
      </div>
    `;
    return;
  }
  
  container.innerHTML = orders.slice(0, 5).map(order => renderOrderItem(order)).join('');
}

function renderOrderItem(order) {
  const typeClass = (order.type || '').toLowerCase().includes('dine') ? 'dine-in' : 
                    (order.type || '').toLowerCase().includes('take') ? 'take-away' : 'delivery';
  const typeIcon = typeClass === 'dine-in' ? '🍽️' : typeClass === 'take-away' ? '🥡' : '🚗';
  const statusClass = (order.status || 'paid').toLowerCase();
  const statusLabel = statusClass === 'paid' ? '已付款' : statusClass === 'refunded' ? '已退款' : '处理中';
  const time = order.date || order.dateTime?.split(' ')[1] || '--:--';
  
  return `
    <div class="order-item" onclick="openOrderDetail('${escapeHtml(order.txId || '')}', '${escapeHtml(order.id || '')}')">
      <div class="order-icon ${typeClass}">${typeIcon}</div>
      <div class="order-content">
        <div class="order-id">${escapeHtml(order.id || '-')}</div>
        <div class="order-meta">
          <span>${escapeHtml(order.type || '-')}</span>
          <span>${escapeHtml(time)}</span>
        </div>
      </div>
      <div class="order-amount">${escapeHtml(order.amount || '$0')}</div>
      <div class="order-status ${statusClass}">${statusLabel}</div>
    </div>
  `;
}

function renderTopItems(products) {
  const container = document.getElementById('top-items');
  if (!products?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🍜</div>
        <div class="empty-text">同步数据后显示</div>
      </div>
    `;
    return;
  }
  
  container.innerHTML = products.slice(0, 5).map((item, index) => `
    <div class="top-item">
      <div class="top-item-rank ${index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : ''}">${index + 1}</div>
      <div class="top-item-info">
        <div class="top-item-name">${escapeHtml(item.name)}</div>
        <div class="top-item-stats">${item.qty} 份 · ${escapeHtml(item.category || '未分类')}</div>
      </div>
      <div class="top-item-amount">${formatCurrency(item.amount)}</div>
    </div>
  `).join('');
}

function getTrendClass(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function formatPercent(value, digits = 1) {
  const numeric = Number(value || 0);
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)}%`;
}

function setProductsMode(mode, button) {
  state.productsMode = mode === 'week' ? 'week' : 'today';
  document.querySelectorAll('#page-products .card-actions .tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  button?.classList.add('active');
  loadProductsAnalysis(state.productsMode, true);
}

async function loadProductsAnalysis(mode = state.productsMode, force = false) {
  const ranking = document.getElementById('products-ranking');
  const insights = document.getElementById('products-insights');

  if (!force && state.productsAnalysis && state.productsMode === mode) {
    renderProductsAnalysis(state.productsAnalysis);
    return;
  }

  if (ranking) {
    ranking.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <div class="loading-text">正在分析商品表现...</div>
      </div>
    `;
  }
  if (insights) {
    insights.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <div class="loading-text">正在生成经营提示...</div>
      </div>
    `;
  }

  const analysis = await fetchProductsAnalysis(mode);
  state.productsAnalysis = analysis;
  renderProductsAnalysis(analysis);
}

function renderProductsAnalysis(analysis) {
  const kpis = document.getElementById('products-kpis');
  const ranking = document.getElementById('products-ranking');
  const insights = document.getElementById('products-insights');
  const periodLabel = document.getElementById('products-period-label');

  if (!analysis?.current) {
    if (kpis) kpis.innerHTML = '<div class="empty-state"><div class="empty-text">暂无商品分析数据</div></div>';
    if (ranking) ranking.innerHTML = '<div class="empty-state"><div class="empty-text">暂无商品分析数据</div></div>';
    if (insights) insights.innerHTML = '<div class="empty-state"><div class="empty-text">暂无经营提示</div></div>';
    if (periodLabel) periodLabel.textContent = state.productsMode === 'week' ? '本周' : '今天';
    return;
  }

  const cards = [
    {
      label: '销量',
      value: `${analysis.kpis?.totalQty?.value || 0} 份`,
      sub: `${analysis.comparisonLabel || '较前期'} ${formatPercent(analysis.kpis?.totalQty?.changePct || 0)}`,
      cls: getTrendClass(analysis.kpis?.totalQty?.changePct || 0),
    },
    {
      label: '销售额',
      value: formatCurrency(analysis.kpis?.totalRevenue?.value || 0),
      sub: `${analysis.comparisonLabel || '较前期'} ${formatPercent(analysis.kpis?.totalRevenue?.changePct || 0)}`,
      cls: getTrendClass(analysis.kpis?.totalRevenue?.changePct || 0),
    },
    {
      label: '利润',
      value: formatCurrency(analysis.kpis?.totalProfit?.value || 0),
      sub: `${analysis.comparisonLabel || '较前期'} ${formatPercent(analysis.kpis?.totalProfit?.changePct || 0)}`,
      cls: getTrendClass(analysis.kpis?.totalProfit?.changePct || 0),
    },
    {
      label: '冠军占比',
      value: `${Number(analysis.kpis?.championShare?.pct || 0).toFixed(0)}%`,
      sub: analysis.kpis?.championShare?.name || '暂无冠军单品',
      cls: 'neutral',
    },
  ];

  if (kpis) {
    kpis.innerHTML = cards.map(card => `
      <div class="products-kpi-card">
        <div class="products-kpi-label">${escapeHtml(card.label)}</div>
        <div class="products-kpi-value">${escapeHtml(card.value)}</div>
        <div class="products-kpi-sub ${card.cls}">${escapeHtml(card.sub)}</div>
      </div>
    `).join('');
  }

  if (periodLabel) {
    periodLabel.textContent = analysis.current.label || (state.productsMode === 'week' ? '本周' : '今天');
  }

  const products = analysis.rankings?.byQty || analysis.current.products || [];
  if (ranking) {
    ranking.innerHTML = products.length
      ? products.slice(0, 10).map((item, index) => `
        <div class="top-item">
          <div class="top-item-rank ${index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : ''}">${index + 1}</div>
          <div class="top-item-info">
            <div class="top-item-name">${escapeHtml(item.name)}</div>
            <div class="top-item-stats">${item.qty} 份 · ${escapeHtml(item.category || '未分类')} · 利润 ${formatCurrency(item.profit || 0)}</div>
          </div>
          <div class="top-item-amount">${formatCurrency(item.amount || 0)}</div>
        </div>
      `).join('')
      : '<div class="empty-state"><div class="empty-text">当前周期暂无菜品数据</div></div>';
  }

  const insightRows = [
    {
      title: '冠军单品',
      body: analysis.insights?.champion
        ? `${analysis.insights.champion.name} 贡献 ${Number(analysis.insights.champion.sharePct || 0).toFixed(1)}% 销售额`
        : '暂无冠军单品',
    },
    {
      title: '增长机会',
      body: analysis.insights?.growthLeader
        ? `${analysis.insights.growthLeader.name} 增长 ${formatPercent(analysis.insights.growthLeader.changePct || 0)}`
        : '暂无明显增长项',
    },
    {
      title: '经营建议',
      body: analysis.insights?.recommendation || '暂无经营建议',
    },
  ];

  if (insights) {
    insights.innerHTML = insightRows.map(item => `
      <div class="insight-card">
        <div class="insight-title">${escapeHtml(item.title)}</div>
        <div class="insight-body">${escapeHtml(item.body)}</div>
      </div>
    `).join('');
  }
}

// ============================================================
// ORDERS PAGE
// ============================================================

async function loadOrdersForDate(dateKey) {
  const container = document.getElementById('orders-list');
  const meta = document.getElementById('orders-meta');
  container.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载订单中...</div>
    </div>
  `;
  if (meta) {
    meta.innerHTML = '<span class="orders-meta-pill">正在同步当天订单...</span>';
  }
  
  try {
    const data = await fetchOrdersForDate(dateKey);
    state.ordersCache = data.orders || [];
    state.orderSearchQuery = '';
    const searchInput = document.querySelector('#page-orders .search-input');
    if (searchInput) searchInput.value = '';
    renderOrdersList(state.ordersCache);
    updateDateLabel(dateKey);
  } catch (error) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">❌</div>
        <div class="empty-text">加载失败: ${escapeHtml(error.message)}</div>
      </div>
    `;
  }
}

function renderOrdersList(orders) {
  const container = document.getElementById('orders-list');
  
  if (!orders?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">暂无订单</div>
      </div>
    `;
    updateOrdersMeta(0, state.ordersCache.length, state.selectedDate);
    return;
  }
  
  container.innerHTML = orders.map(order => renderOrderItem(order)).join('');
  updateOrdersMeta(orders.length, state.ordersCache.length, state.selectedDate);
}

function updateOrdersMeta(visibleCount, totalCount, dateKey) {
  const meta = document.getElementById('orders-meta');
  if (!meta) return;

  const pills = [
    `${dateKey === getMelbourneDateString() ? '今天' : dateKey} ${totalCount} 单`,
    state.orderSearchQuery ? `筛选后 ${visibleCount} 单` : '点击订单查看详情',
  ];

  if (state.orderSearchQuery) {
    pills.push(`关键词: ${state.orderSearchQuery}`);
  }

  meta.innerHTML = pills.map(text => `
    <span class="orders-meta-pill">${escapeHtml(text)}</span>
  `).join('');
}

function findOrderInState(txId, orderId) {
  const keys = [txId, orderId].filter(Boolean).map(value => String(value));
  const pools = [state.ordersCache, state.recentOrders];

  for (const pool of pools) {
    const match = (pool || []).find(order => {
      const orderKeys = [order?.txId, order?.id].filter(Boolean).map(value => String(value));
      return orderKeys.some(key => keys.includes(key));
    });
    if (match) return match;
  }

  return null;
}

function updateDateLabel(dateKey) {
  const today = getMelbourneDateString();
  const label = document.getElementById('date-label');
  
  if (dateKey === today) {
    label.textContent = '今天';
  } else {
    const date = new Date(dateKey + 'T00:00:00');
    label.textContent = date.toLocaleDateString('zh-CN', { 
      month: 'long', 
      day: 'numeric',
      weekday: 'short',
    });
  }
  
  document.getElementById('order-date').value = dateKey;
  document.getElementById('date-today').disabled = dateKey === today;
}

function changeDate(dateKey) {
  if (!dateKey) return;
  state.selectedDate = dateKey;
  loadOrdersForDate(dateKey);
}

function openDatePicker() {
  const input = document.getElementById('order-date');
  if (!input) return;

  if (typeof input.showPicker === 'function') {
    input.showPicker();
    return;
  }

  input.focus();
  input.click();
}

function navDate(delta) {
  const current = new Date(state.selectedDate + 'T00:00:00');
  current.setDate(current.getDate() + delta);
  const newDate = getMelbourneDateString(current);
  
  if (newDate <= getMelbourneDateString()) {
    changeDate(newDate);
  }
}

function goToday() {
  changeDate(getMelbourneDateString());
}

function searchOrders(query) {
  const q = query.toLowerCase().trim();
  state.orderSearchQuery = query.trim();
  if (!q) {
    renderOrdersList(state.ordersCache);
    return;
  }
  
  const filtered = state.ordersCache.filter(order => {
    const id = (order.id || '').toLowerCase();
    const txId = (order.txId || '').toLowerCase();
    const amount = (order.amount || '').toLowerCase();
    const type = (order.type || '').toLowerCase();
    
    return id.includes(q) || txId.includes(q) || amount.includes(q) || type.includes(q);
  });
  
  renderOrdersList(filtered);
}

// ============================================================
// ORDER DETAIL MODAL
// ============================================================

async function openOrderDetail(txId, orderId) {
  const modal = document.getElementById('order-modal');
  const title = document.getElementById('modal-title');
  const content = document.getElementById('modal-content');
  state.activeOrder = findOrderInState(txId, orderId);
  
  title.textContent = `订单 ${orderId || txId}`;
  content.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">加载收据中...</div>
    </div>
  `;
  
  modal.classList.add('active');
  
  // Prevent body scroll
  document.body.style.overflow = 'hidden';
  
  try {
    const detail = await fetchOrderDetail(txId || orderId);
    if (detail) {
      renderOrderDetail(detail);
    } else {
      throw new Error('无法获取订单详情');
    }
  } catch (error) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">❌</div>
        <div class="empty-text">${escapeHtml(error.message)}</div>
      </div>
    `;
  }
}

function formatRawReceiptText(bodyText = '') {
  const normalized = String(bodyText || '')
    .replace(/\s+(Receipt Receipt Receipt)/g, '\n$1')
    .replace(/\s+(Customer:)/g, '\n$1')
    .replace(/\s+(Fulfillment:)/g, '\n$1')
    .replace(/\s+(Order Time:)/g, '\n$1')
    .replace(/\s+(Transaction Id:)/g, '\n$1')
    .replace(/\s+(Item Name Price\\(\\$\\))/g, '\n$1')
    .replace(/\s+(Sub-Total)/g, '\n$1')
    .replace(/\s+(Total Paid)/g, '\n$1')
    .replace(/\s+(GST Included In Total)/g, '\n$1')
    .replace(/\s+(Flexible)/g, '\n$1')
    .replace(/\s+(Reward Points:)/g, '\n$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return normalized;
}

function buildReceiptFallbackSections(detail, sourceOrder, totals) {
  const raw = formatRawReceiptText(detail.bodyText || '');
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  const sections = [];

  const pushSection = (title, values = []) => {
    const cleanValues = values.map(value => String(value || '').trim()).filter(Boolean);
    if (!cleanValues.length) return;
    sections.push({ title, values: cleanValues });
  };

  const headerLines = lines.filter(line => /Foodie Fair|食集|ABN:|Phone:|Address:/i.test(line));
  pushSection('门店信息', headerLines);

  const orderInfo = [
    detail.receipt?.fulfillment || sourceOrder?.type || '',
    detail.receipt?.orderTime || sourceOrder?.dateTime || sourceOrder?.date || '',
    detail.txId || '',
  ];
  pushSection('订单信息', orderInfo);

  const itemStart = lines.findIndex(line => /^Item Name\b/i.test(line));
  const totalStart = lines.findIndex(line => /^Sub-Total\b/i.test(line));
  if (itemStart !== -1) {
    const itemLines = lines.slice(itemStart + 1, totalStart !== -1 ? totalStart : lines.length);
    pushSection('收据原文', itemLines);
  }

  const paymentLines = lines.filter(line =>
    /^Sub-Total\b/i.test(line)
    || /^Total\b/i.test(line)
    || /^GST Included In Total\b/i.test(line)
    || /^Surcharge\b/i.test(line)
    || /^Total Paid\b/i.test(line)
    || /^(Visa|Mastercard|EFTPOS|Flexible|Cash|Card)\b/i.test(line)
  );
  pushSection('支付信息', paymentLines);

  if (!sections.length) {
    pushSection('收据原文', [raw || '暂无可用收据内容']);
  }

  if (!paymentLines.length && (totals.subtotal || totals.totalPaid)) {
    pushSection('金额汇总', [
      totals.subtotal ? `小计 ${formatCurrency(totals.subtotal)}` : '',
      totals.gst ? `GST ${formatCurrency(totals.gst)}` : '',
      totals.surcharge ? `附加费 ${formatCurrency(totals.surcharge)}` : '',
      totals.totalPaid ? `总计 ${formatCurrency(totals.totalPaid)}` : '',
    ]);
  }

  return sections;
}

function extractReceiptStoreProfile(bodyText = '') {
  const raw = formatRawReceiptText(bodyText);
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  const profile = {
    brand: '',
    phone: '',
    address: '',
    abn: '',
  };

  for (const line of lines) {
    if (!profile.brand && /Foodie Fair|食集/i.test(line)) {
      profile.brand = line
        .replace(/^Transaction Receipt(?:\s+Receipt){0,3}\s*/i, '')
        .replace(/^Receipt(?:\s+Receipt){0,3}\s*/i, '')
        .replace(/\s+https?:\/\/\S+.*$/i, '')
        .trim();
    }
    if (!profile.abn && /ABN:/i.test(line)) profile.abn = line.match(/ABN:\s*.+/i)?.[0] || line;
    if (!profile.phone && /Phone:/i.test(line)) {
      profile.phone = (line.match(/Phone:\s*(.+)/i)?.[1] || line).trim();
    }
    if (!profile.address && /Address:/i.test(line)) profile.address = line.match(/Address:\s*.+/i)?.[0] || line;
  }

  return profile;
}

function formatReceiptOptionLine(line = '') {
  const raw = String(line || '').replace(/^\+\s*/, '').trim();
  if (!raw) return '';

  const match = raw.match(/^(.*?)\s+x\s*(\d+)\s+(\d+\.\d{2})$/i);
  if (!match) return raw;

  const name = match[1].trim();
  const qty = Number(match[2]) || 1;
  const amount = Number(match[3]) || 0;
  const qtyText = qty > 1 ? ` x${qty}` : '';
  const amountText = amount > 0 ? ` (+${formatCurrency(amount)})` : '';
  return `${name}${qtyText}${amountText}`;
}

function renderReceiptOptionLines(note = '') {
  const lines = String(note || '')
    .split('\n')
    .map(line => formatReceiptOptionLine(line))
    .filter(Boolean);

  if (!lines.length) return '';

  return lines.map(line => `<div class="receipt-paper-item-note-line">${escapeHtml(line)}</div>`).join('');
}

function parseVisualReceiptItems(detail = {}, sourceOrder = null) {
  if (Array.isArray(detail.items) && detail.items.length) {
    return detail.items.map(item => ({
      name: item.name || '未命名',
      qty: Number(item.qty || 1) || 1,
      subtotal: item.subtotal || item.price || '$0.00',
      note: item.note || '',
    }));
  }

  const raw = formatRawReceiptText(detail.bodyText || '');
  const match = raw.match(/Item Name(?:\s+Qty)?\s+Price\(\$\)\s*([\s\S]*?)\nSub-Total\b/i);
  if (!match) {
    return sourceOrder ? [{
      name: sourceOrder.id || '订单金额',
      qty: 1,
      subtotal: sourceOrder.amount || '$0',
      note: sourceOrder.type || '',
    }] : [];
  }

  const compact = match[1]
    .replace(/\s+\+\s+/g, '\n+ ')
    .replace(/(\d+\.\d{2})\s+(?=[^\+\n][^+\n]{2,}?\s+\d+\s+\d+\.\d{2}\b)/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const lines = compact.split('\n').map(line => line.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (/^\+/.test(line)) {
      const previous = items[items.length - 1];
      if (!previous) continue;
      const addon = formatReceiptOptionLine(line);
      previous.note = previous.note ? `${previous.note}\n${addon}` : addon;
      continue;
    }

    const row = line.match(/^(.*?)\s+(\d+)\s+(\d+\.\d{2})$/);
    if (!row) continue;
    items.push({
      name: row[1].trim(),
      qty: Number(row[2]) || 1,
      subtotal: formatCurrency(Number(row[3]) || 0),
      note: '',
    });
  }

  return items;
}

function renderReceiptPaper(detail, sourceOrder, totals, paymentLabel, orderTime, fulfillment) {
  const profile = extractReceiptStoreProfile(detail.bodyText || '');
  const items = parseVisualReceiptItems(detail, sourceOrder);
  const paperTotal = totals.totalPaid || totals.total || parseMoneyText(sourceOrder?.amount || 0);
  const paymentRows = [
    totals.subtotal ? { label: 'Sub-total', value: formatCurrency(totals.subtotal) } : null,
    totals.gst ? { label: 'GST', value: formatCurrency(totals.gst) } : null,
    totals.surcharge ? { label: 'Surcharge', value: formatCurrency(totals.surcharge) } : null,
  ].filter(Boolean);

  return `
    <section class="receipt-paper-wrap">
      <div class="receipt-paper">
        <div class="receipt-paper-top">
          <div class="receipt-paper-brand">${escapeHtml(profile.brand || 'PROSPERITY XH')}</div>
          ${profile.abn ? `<div class="receipt-paper-meta">${escapeHtml(profile.abn)}</div>` : ''}
          ${profile.phone ? `<div class="receipt-paper-meta">${escapeHtml(profile.phone)}</div>` : ''}
          ${profile.address ? `<div class="receipt-paper-meta">${escapeHtml(profile.address)}</div>` : ''}
        </div>

        <div class="receipt-paper-divider"></div>

        <div class="receipt-paper-grid">
          <div><span>Order</span><strong>${escapeHtml(detail.orderId || sourceOrder?.id || '-')}</strong></div>
          <div><span>Time</span><strong>${escapeHtml(orderTime)}</strong></div>
          <div><span>Type</span><strong>${escapeHtml(fulfillment)}</strong></div>
          <div><span>Payment</span><strong>${escapeHtml(paymentLabel)}</strong></div>
          <div class="receipt-paper-grid-full"><span>Tx ID</span><strong>${escapeHtml(detail.txId || sourceOrder?.txId || '-')}</strong></div>
        </div>

        <div class="receipt-paper-divider receipt-paper-divider--dashed"></div>

        <div class="receipt-paper-items">
          ${items.length ? items.map(item => `
            <div class="receipt-paper-item">
              <div class="receipt-paper-item-main">
                <div class="receipt-paper-item-name">${escapeHtml(item.name)}</div>
                ${item.note ? `<div class="receipt-paper-item-note">${renderReceiptOptionLines(item.note)}</div>` : ''}
              </div>
              <div class="receipt-paper-item-side">
                <span class="receipt-paper-item-qty">x${escapeHtml(String(item.qty || 1))}</span>
                <strong>${escapeHtml(item.subtotal || '$0.00')}</strong>
              </div>
            </div>
          `).join('') : `
            <div class="receipt-paper-empty">当前小票明细仍在整理中，下面保留了原始收据。</div>
          `}
        </div>

        <div class="receipt-paper-divider receipt-paper-divider--dashed"></div>

        <div class="receipt-paper-totals">
          ${paymentRows.map(row => `
            <div class="receipt-paper-total-row">
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.value)}</strong>
            </div>
          `).join('')}
          <div class="receipt-paper-total-row receipt-paper-total-row--grand">
            <span>Total Paid</span>
            <strong>${formatCurrency(paperTotal)}</strong>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderOrderDetail(detail) {
  const content = document.getElementById('modal-content');
  const receipt = detail.receipt || {};
  const sourceOrder = state.activeOrder || findOrderInState(detail.txId, detail.orderId);
  const rawTotals = detail.totals || {};
  const fallbackTotal = parseMoneyText(sourceOrder?.amount || 0);
  const fallbackTax = parseMoneyText(sourceOrder?.tax || 0);
  const totals = {
    subtotal: Number(rawTotals.subtotal || 0) || fallbackTotal,
    total: Number(rawTotals.total || 0) || fallbackTotal,
    gst: Number(rawTotals.gst || 0) || fallbackTax,
    surcharge: Number(rawTotals.surcharge || 0) || 0,
    totalPaid: Number(rawTotals.totalPaid || 0) || fallbackTotal,
  };
  const items = Array.isArray(detail.items) ? detail.items : [];
  const formattedRawReceipt = formatRawReceiptText(detail.bodyText || '');
  const hasStructuredItems = items.length > 0;
  const fallbackSections = buildReceiptFallbackSections(detail, sourceOrder, totals);
  const paymentLabel = detail.payment?.methods?.[0]?.label || (fallbackTotal > 0 ? '已付款' : '-');
  const orderTime = receipt.orderTime || sourceOrder?.dateTime || sourceOrder?.date || '-';
  const fulfillment = receipt.fulfillment || sourceOrder?.type || '-';
  
  content.innerHTML = `
    <div class="order-detail-shell">
      <div class="order-detail-hero">
        <div class="order-detail-kicker">Transaction Receipt</div>
        <div class="order-detail-id">${escapeHtml(detail.orderId || '-')}</div>
        <div class="order-detail-total">${formatCurrency(totals.totalPaid || totals.total || 0)}</div>
        <div class="order-detail-meta">
          <div class="order-meta-item">
            <div class="order-meta-label">时间</div>
            <div class="order-meta-value">${escapeHtml(orderTime)}</div>
          </div>
          <div class="order-meta-item">
            <div class="order-meta-label">类型</div>
            <div class="order-meta-value">${escapeHtml(fulfillment)}</div>
          </div>
          <div class="order-meta-item">
            <div class="order-meta-label">交易号</div>
            <div class="order-meta-value">${escapeHtml(detail.txId || '-')}</div>
          </div>
          <div class="order-meta-item">
            <div class="order-meta-label">支付方式</div>
            <div class="order-meta-value">${escapeHtml(paymentLabel)}</div>
          </div>
        </div>
      </div>

      ${renderReceiptPaper(detail, sourceOrder, totals, paymentLabel, orderTime, fulfillment)}

      <section class="receipt-section">
        <div class="receipt-title-row">
          <div class="receipt-title-block">
            <div class="receipt-kicker">Backup View</div>
            <div class="receipt-title">${hasStructuredItems ? '解析明细' : '收据补充信息'}</div>
          </div>
          <span class="receipt-count">${hasStructuredItems ? `${items.length} 项` : '辅助视图'}</span>
        </div>
        ${hasStructuredItems
          ? items.map(item => `
            <div class="receipt-item">
              <div class="receipt-item-info">
                <div class="receipt-item-name">${escapeHtml(item.name || '未命名')}</div>
                ${item.note ? `<div class="receipt-item-note">${escapeHtml(item.note)}</div>` : ''}
              </div>
              <div class="receipt-item-price">${escapeHtml(item.subtotal || item.price || '-')}</div>
            </div>
          `).join('')
          : `
            <div class="receipt-fallback-stack">
              ${fallbackSections.map(section => `
                <div class="receipt-fallback-card">
                  <div class="receipt-fallback-title">${escapeHtml(section.title)}</div>
                  <div class="receipt-fallback-body">
                    ${section.values.map(value => `<div class="receipt-fallback-line">${escapeHtml(value)}</div>`).join('')}
                  </div>
                </div>
              `).join('')}
              ${formattedRawReceipt ? `<details class="receipt-raw-details"><summary>查看完整原始收据</summary><pre class="receipt-raw">${escapeHtml(formattedRawReceipt)}</pre></details>` : ''}
            </div>
          `
        }
      </section>

      <section class="payment-summary">
        <div class="receipt-title-row receipt-title-row--summary">
          <div class="receipt-title-block">
            <div class="receipt-kicker">Settlement</div>
            <div class="receipt-title">金额汇总</div>
          </div>
        </div>
        ${totals.subtotal ? `
          <div class="payment-row">
            <span class="payment-label">小计</span>
            <span class="payment-value">${formatCurrency(totals.subtotal)}</span>
          </div>
        ` : ''}
        ${totals.gst ? `
          <div class="payment-row">
            <span class="payment-label">GST</span>
            <span class="payment-value">${formatCurrency(totals.gst)}</span>
          </div>
        ` : ''}
        ${totals.surcharge ? `
          <div class="payment-row">
            <span class="payment-label">附加费</span>
            <span class="payment-value">${formatCurrency(totals.surcharge)}</span>
          </div>
        ` : ''}
        <div class="payment-row total">
          <span class="payment-label">总计</span>
          <span class="payment-value">${formatCurrency(totals.totalPaid || totals.total || 0)}</span>
        </div>
      </section>
    </div>
  `;
}

function closeModal() {
  const modal = document.getElementById('order-modal');
  modal.classList.remove('active');
  document.body.style.overflow = '';
}

function printOrder() {
  window.print();
}

function renderCameras() {
  const container = document.getElementById('cameras-grid');
  if (!container) return;

  container.innerHTML = CONFIG.cameras.map((camera, index) => `
    <div class="camera-card ${camera.isOnline ? 'camera-card--interactive' : 'camera-card--offline'}" onclick="openCameraModal(${index})">
      <div class="camera-preview">
        ${camera.isOnline && camera.go2rtcUrl
          ? `<iframe src="${escapeHtml(camera.go2rtcUrl)}" title="${escapeHtml(camera.name)}" loading="lazy" allowfullscreen></iframe>
             <div class="camera-preview-badge">点按全屏</div>`
          : '📷'}
      </div>
      <div class="camera-info">
        <div class="camera-name-row">
          <div class="camera-name">${escapeHtml(camera.name)}</div>
          <div class="camera-action-hint">${camera.isOnline ? '查看' : '离线'}</div>
        </div>
        <div class="camera-meta">${escapeHtml(camera.type || '')}</div>
        <div class="camera-status">
          <span class="camera-status-dot ${camera.isOnline ? '' : 'offline'}"></span>
          <span>${camera.isOnline ? '在线' : '离线'}</span>
        </div>
        <div class="camera-note">${escapeHtml(camera.note || '')}</div>
      </div>
    </div>
  `).join('');
}

function openCameraModal(index) {
  const camera = CONFIG.cameras[index];
  if (!camera) return;

  state.activeCamera = camera;

  if (!camera.isOnline || !camera.go2rtcUrl) {
    showToast(`${camera.name} 当前离线`, 'error');
    return;
  }

  const modal = document.getElementById('camera-modal');
  const title = document.getElementById('camera-modal-title');
  const content = document.getElementById('camera-modal-content');
  const openBtn = document.getElementById('camera-modal-open-btn');

  if (title) title.textContent = camera.name;
  if (openBtn) openBtn.disabled = !camera.go2rtcUrl;
  if (content) {
    content.innerHTML = `
      <div class="camera-viewer">
        <div class="camera-viewer-frame">
          <iframe src="${escapeHtml(camera.go2rtcUrl)}" title="${escapeHtml(camera.name)}" loading="eager" allowfullscreen></iframe>
        </div>
        <div class="camera-viewer-meta">
          <div class="camera-viewer-title">${escapeHtml(camera.name)}</div>
          <div class="camera-viewer-sub">${escapeHtml(camera.type || '')}</div>
          <div class="camera-viewer-note">${escapeHtml(camera.note || '')}</div>
        </div>
      </div>
    `;
  }

  modal?.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeCameraModal() {
  const modal = document.getElementById('camera-modal');
  const content = document.getElementById('camera-modal-content');
  modal?.classList.remove('active');
  if (content) {
    content.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载画面中...</div>
      </div>
    `;
  }
  document.body.style.overflow = '';
}

function openCameraExternal() {
  const url = state.activeCamera?.go2rtcUrl;
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function renderReportBrief(payload) {
  const container = document.getElementById('report-brief');
  if (!container) return;

  const report = payload?.report;
  const htmlPath = payload?.meta?.htmlPath;

  if (!report) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <div class="empty-text">还没有可用日报，点击上方立即生成。</div>
      </div>
    `;
    return;
  }

  const executive = Array.isArray(report.sections?.executiveSummary)
    ? report.sections.executiveSummary.slice(0, 3)
    : [];

  container.innerHTML = `
    <div class="report-brief-grid">
      <div class="report-stat-card">
        <div class="products-kpi-label">日期</div>
        <div class="products-kpi-value">${escapeHtml(report.dateKey || '--')}</div>
        <div class="products-kpi-sub neutral">${escapeHtml(report.generatedAt || '已生成')}</div>
      </div>
      <div class="report-stat-card">
        <div class="products-kpi-label">营业额</div>
        <div class="products-kpi-value">${formatCurrency(report.today?.totalRevenue || 0)}</div>
        <div class="products-kpi-sub neutral">${report.today?.totalOrders || 0} 单</div>
      </div>
    </div>
    <div class="insight-list">
      ${executive.length ? executive.map(item => `
        <div class="insight-card">
          <div class="insight-body">${escapeHtml(item)}</div>
        </div>
      `).join('') : '<div class="empty-state"><div class="empty-text">暂无日报摘要</div></div>'}
    </div>
    ${htmlPath ? `<div class="quick-actions"><a class="quick-action-link" href="${escapeHtml(htmlPath)}" target="_blank" rel="noreferrer">打开完整 HTML 日报</a></div>` : ''}
  `;
}

function renderContextBrief(payload) {
  const container = document.getElementById('context-brief');
  if (!container) return;

  if (!payload) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧠</div>
        <div class="empty-text">暂无数据语义上下文</div>
      </div>
    `;
    return;
  }

  const metrics = Array.isArray(payload.keyMetrics) ? payload.keyMetrics.slice(0, 3) : [];
  const runtime = payload.runtime || {};

  container.innerHTML = `
    <div class="report-brief-grid">
      <div class="report-stat-card">
        <div class="products-kpi-label">覆盖级别</div>
        <div class="products-kpi-value">${escapeHtml(payload.coverageLevel || '--')}</div>
        <div class="products-kpi-sub neutral">${escapeHtml(payload.area || '')}</div>
      </div>
      <div class="report-stat-card">
        <div class="products-kpi-label">运行状态</div>
        <div class="products-kpi-value">${runtime.hasLiveData ? 'Live' : 'Cache'}</div>
        <div class="products-kpi-sub neutral">${escapeHtml(runtime.storeName || 'PROSPERITY XH')}</div>
      </div>
    </div>
    <div class="insight-list">
      ${metrics.length ? metrics.map(metric => `
        <div class="insight-card">
          <div class="insight-title">${escapeHtml(metric.name || '指标')}</div>
          <div class="insight-body">${escapeHtml(metric.definition || '')}</div>
        </div>
      `).join('') : '<div class="empty-state"><div class="empty-text">暂无指标定义</div></div>'}
    </div>
  `;
}

async function loadMorePage(force = false) {
  if (!force && state.dailyReport && state.dataContext) {
    renderReportBrief(state.dailyReport);
    renderContextBrief(state.dataContext);
    return;
  }

  const [dailyReport, dataContext] = await Promise.all([
    fetchDailyReport(),
    fetchDataContext(),
  ]);

  state.dailyReport = dailyReport;
  state.dataContext = dataContext;
  renderReportBrief(dailyReport);
  renderContextBrief(dataContext);
}

function refreshMorePage() {
  loadMorePage(true);
}

async function generateDailyReport() {
  const brief = document.getElementById('report-brief');
  if (brief) {
    brief.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <div class="loading-text">正在生成每日日报...</div>
      </div>
    `;
  }

  try {
    const response = await fetch(`${CONFIG.apiBase}/api/reports/daily/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    state.dailyReport = payload;
    renderReportBrief(payload);
    showToast('每日日报已生成', 'success');
  } catch (error) {
    console.error('Failed to generate daily report:', error);
    renderReportBrief(state.dailyReport);
    showToast(`日报生成失败: ${error.message}`, 'error');
  }
}

// ============================================================
// CHART TYPE SWITCHING
// ============================================================

let currentChartType = 'bar';

function switchChartType(type, button) {
  currentChartType = type;
  
  // Update button states
  document.querySelectorAll('#page-dashboard .card-actions .tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  button?.classList.add('active');
  
  // Re-render chart
  renderHourlyChart(state.hourlySales);
}

// ============================================================
// UPDATE CHARTS THEME
// ============================================================

function updateChartsTheme() {
  renderHourlyChart(state.hourlySales);
  renderWeeklyOverview(state.summary?.weeklyOverview);
}

// ============================================================
// TIME UPDATE
// ============================================================

function updateTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  
  document.getElementById('header-time').textContent = timeStr;
}

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  console.log('[Mobile] Initializing...');
  
  // Init theme
  initTheme();
  
  // Update time
  updateTime();
  setInterval(updateTime, 1000);
  
  // Load dashboard data
  await loadDashboardData();
  await loadProductsAnalysis('today', true);
  renderCameras();
  
  // Set up auto-refresh
  setInterval(() => {
    if (state.currentPage === 'dashboard') {
      loadDashboardData();
    }
  }, CONFIG.refreshInterval);
  
  // Set today's date for order picker
  document.getElementById('order-date').value = getMelbourneDateString();
  updateDateLabel(getMelbourneDateString());
  
  console.log('[Mobile] Initialized');
}

let mobileBootstrapped = false;

function bootMobileApp() {
  if (mobileBootstrapped) return;
  mobileBootstrapped = true;
  void init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootMobileApp);
} else {
  bootMobileApp();
}

window.addEventListener('legacy-shell-ready', bootMobileApp);

// Handle back button for modal
window.addEventListener('popstate', () => {
  const modal = document.getElementById('order-modal');
  if (modal.classList.contains('active')) {
    closeModal();
  }
  const cameraModal = document.getElementById('camera-modal');
  if (cameraModal?.classList.contains('active')) {
    closeCameraModal();
  }
});

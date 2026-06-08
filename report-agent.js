'use strict';

const fs = require('fs');
const path = require('path');

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function cleanMoney(value) {
  return parseFloat(String(value || '').replace(/[^0-9.-]/g, '')) || 0;
}

function shiftDateKey(dateKey, deltaDays) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + deltaDays);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function filterComparableOrders(orders = []) {
  return (Array.isArray(orders) ? orders : []).filter(order => String(order?.status || '').toLowerCase() !== 'refunded');
}

function aggregateOrders(orders = []) {
  const normalized = filterComparableOrders(orders);
  const totalRevenue = round2(normalized.reduce((sum, order) => sum + cleanMoney(order.amount), 0));
  const totalOrders = normalized.length;

  return {
    totalOrders,
    totalRevenue,
    avgTicket: totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0,
  };
}

function findLatestOrderTime(orders = []) {
  const normalized = filterComparableOrders(orders);
  return normalized.reduce((latest, order) => {
    const dateTime = String(order?.dateTime || '');
    return dateTime > latest ? dateTime : latest;
  }, '');
}

function aggregateToCutoff(orders = [], cutoffTime = '') {
  if (!cutoffTime) return aggregateOrders(orders);
  const scoped = filterComparableOrders(orders).filter(order => String(order?.dateTime || '').slice(11, 16) <= cutoffTime);
  return aggregateOrders(scoped);
}

function countBy(orders = [], key) {
  return filterComparableOrders(orders).reduce((accumulator, order) => {
    const group = String(order?.[key] || 'Unknown').trim() || 'Unknown';
    accumulator[group] = (accumulator[group] || 0) + 1;
    return accumulator;
  }, {});
}

function bucketOrdersByAmount(orders = []) {
  const buckets = { '<10': 0, '10-20': 0, '20-30': 0, '30+': 0 };

  filterComparableOrders(orders).forEach(order => {
    const amount = cleanMoney(order.amount);
    if (amount < 10) buckets['<10'] += 1;
    else if (amount < 20) buckets['10-20'] += 1;
    else if (amount < 30) buckets['20-30'] += 1;
    else buckets['30+'] += 1;
  });

  return buckets;
}

function pickTopHours(hourlySales = [], limit = 3) {
  return (Array.isArray(hourlySales) ? hourlySales : [])
    .filter(item => !item?.isFuture)
    .slice()
    .sort((left, right) => (Number(right?.revenue) || 0) - (Number(left?.revenue) || 0))
    .slice(0, limit)
    .map(item => ({
      hour: item.hourLabel || item.hour || item.label || '',
      revenue: round2(item.revenue),
      orders: Number(item.orders) || 0,
    }));
}

function buildExecutiveSummary(report) {
  const sameTimeDelta = report.comparison.sameTime.revenue.delta;
  const sameTimePct = report.comparison.sameTime.revenue.pct;
  const hasMeaningfulSameTimeGap = Math.abs(sameTimeDelta) >= 20;
  const sameTimeSentence = hasMeaningfulSameTimeGap
    ? `截至 ${report.comparison.sameTime.cutoffTime}，今天收入 ${sameTimeDelta >= 0 ? '比昨天同一时间高' : '只比昨天同一时间低'} AUD ${Math.abs(sameTimeDelta).toFixed(1)}（${sameTimePct >= 0 ? '+' : ''}${sameTimePct.toFixed(1)}%）。`
    : `截至 ${report.comparison.sameTime.cutoffTime}，今天和昨天同一时间的收入基本接近。`;

  const topProducts = report.products.topRevenue.slice(0, 2);
  const topProductsRevenue = round2(topProducts.reduce((sum, item) => sum + item.amount, 0));

  return [
    `今天营业额 AUD ${report.today.totalRevenue.toFixed(1)}，昨天全天 AUD ${report.yesterday.totalRevenue.toFixed(1)}，如果直接看全天口径，今天少了 ${Math.abs(report.comparison.fullDay.revenue.pct).toFixed(1)}%。`,
    `${sameTimeSentence} 但今天订单数更多，问题主要出在客单价从 AUD ${report.comparison.sameTime.yesterday.avgTicket.toFixed(2)} 掉到 AUD ${report.comparison.sameTime.today.avgTicket.toFixed(2)}。`,
    `今天低于 AUD 10 的订单有 ${report.today.mix.amountBuckets['<10']} 单，昨天同一时间是 ${report.comparison.sameTime.yesterday.amountBuckets['<10']} 单；同时 AUD 20-30 的订单从 ${report.comparison.sameTime.yesterday.amountBuckets['20-30']} 单降到 ${report.today.mix.amountBuckets['20-30']} 单。`,
    `${topProducts[0]?.name || '主力产品'} 和 ${topProducts[1]?.name || '第二主力产品'} 两款合计带来 AUD ${topProductsRevenue.toFixed(2)}，是今天最主要的营收支柱。`,
  ];
}

function buildRecommendations(report) {
  const recommendations = [];

  recommendations.push('晚市优先拉高每单金额，不要只追单量，重点推主食 + 小吃 / 饮品组合。');

  if (report.today.mix.amountBuckets['<10'] >= 6) {
    recommendations.push('今天低价单偏多，建议检查饮品、小吃和附加项是否抢走了主食预算，必要时强化套餐和加价升级。');
  }

  if (report.products.topRevenue.length > 0) {
    recommendations.push(`继续把 ${report.products.topRevenue[0].name} 放在最显眼位置，它仍然是今天最强的单品引流和营收来源。`);
  }

  recommendations.push('如果你要看真实低利润品而不是低销售贡献品，下一步要把菜品成本字段补进数据源。');

  return recommendations;
}

function buildFurtherQuestions(report) {
  return [
    `昨天 ${report.comparison.sameTime.cutoffTime} 前有哪些高金额组合单今天没有出现？`,
    '晚市结束后，客单价有没有被晚餐时段拉回到昨天水平？',
    '低于 AUD 10 的订单里，饮品、小吃和打包附加项各占多少？',
  ];
}

function buildRuleNarrative(report) {
  const keyFindings = [
    '今天的问题不是客流不足，而是高金额订单密度不够。',
    `本周目前最强的一天是 ${report.week.bestDay.fullLabel}，它同时赢了订单数和客单价。`,
    '热销主食仍然有稳定拉动作用，说明问题更像是结构性变薄，而不是核心招牌失灵。',
  ];

  const caveats = report?.lifecycle?.stage === 'final'
    ? [
      '这份报告已经按打烊后的最终口径生成，可直接用于复盘或发给老板。',
      '当前 low-profit 判断只能按低销售贡献近似，因为成本字段仍是 0。',
    ]
    : [
      '今天仍是营业中快照，不是收档后的全天最终结果。',
      '当前 low-profit 判断只能按低销售贡献近似，因为成本字段仍是 0。',
    ];

  return {
    executiveSummary: buildExecutiveSummary(report),
    keyFindings,
    recommendations: buildRecommendations(report),
    furtherQuestions: buildFurtherQuestions(report),
    caveats,
  };
}

async function buildOpenAINarrative(report, config = {}) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) return null;

  const model = String(config.model || 'gpt-4.1-mini').trim();
  const prompt = [
    'You are helping write a daily restaurant business report in concise Simplified Chinese.',
    'Return valid JSON only with keys: executiveSummary, keyFindings, recommendations, furtherQuestions, caveats.',
    'Each value except caveats should be an array of short bullet strings. caveats should also be an array.',
    'Ground every point in the provided numbers. Do not invent extra data.',
    '',
    JSON.stringify({
      dateKey: report.dateKey,
      today: report.today,
      yesterday: report.yesterday,
      comparison: report.comparison,
      week: report.week,
      products: report.products,
      topHours: report.today.topHours,
    }, null, 2),
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'daily_sales_report_narrative',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['executiveSummary', 'keyFindings', 'recommendations', 'furtherQuestions', 'caveats'],
            properties: {
              executiveSummary: { type: 'array', items: { type: 'string' } },
              keyFindings: { type: 'array', items: { type: 'string' } },
              recommendations: { type: 'array', items: { type: 'string' } },
              furtherQuestions: { type: 'array', items: { type: 'string' } },
              caveats: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI report agent failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const outputText = payload?.output_text || '{}';
  return JSON.parse(outputText);
}

async function createNarrative(report, options = {}) {
  const mode = String(options.mode || 'rules').trim().toLowerCase();

  if (mode === 'rules') {
    return {
      mode: 'rules',
      content: buildRuleNarrative(report),
    };
  }

  const wantsOpenAI = mode === 'openai' || mode === 'auto';
  if (wantsOpenAI) {
    try {
      const content = await buildOpenAINarrative(report, {
        apiKey: options.openAIApiKey,
        model: options.openAIModel,
      });
      if (content) {
        return {
          mode: 'openai',
          content,
        };
      }
    } catch (error) {
      if (mode === 'openai') throw error;
    }
  }

  return {
    mode: 'rules',
    content: buildRuleNarrative(report),
  };
}

function renderBarList(items = [], valueKey, formatter) {
  const maxValue = Math.max(...items.map(item => Number(item?.[valueKey]) || 0), 1);

  return items.map(item => {
    const value = Number(item?.[valueKey]) || 0;
    const width = Math.max(6, Math.round((value / maxValue) * 100));
    return `
      <div class="bar-list-row">
        <div class="bar-list-copy">
          <div class="bar-list-label">${escapeHtml(item.label)}</div>
          <div class="bar-list-value">${escapeHtml(formatter(value, item))}</div>
        </div>
        <div class="bar-list-track"><div class="bar-list-fill" style="width:${width}%"></div></div>
      </div>
    `;
  }).join('');
}

function renderListSection(title, items = []) {
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <ul class="bullet-list">
        ${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function renderDailyReportHTML(report) {
  const summaryCards = [
    {
      label: 'Today Revenue',
      value: `$${report.today.totalRevenue.toFixed(1)}`,
      sub: `Today to ${report.comparison.sameTime.cutoffTime || '--:--'}`,
    },
    {
      label: 'Vs Yesterday Full Day',
      value: `${report.comparison.fullDay.revenue.pct >= 0 ? '+' : ''}${report.comparison.fullDay.revenue.pct.toFixed(1)}%`,
      sub: `Yesterday full day was $${report.yesterday.totalRevenue.toFixed(1)}`,
    },
    {
      label: 'Vs Yesterday Same Time',
      value: `${report.comparison.sameTime.revenue.delta >= 0 ? '+' : '-'}$${Math.abs(report.comparison.sameTime.revenue.delta).toFixed(1)}`,
      sub: `Cutoff ${report.comparison.sameTime.cutoffTime || '--:--'}`,
    },
    {
      label: 'Avg Ticket',
      value: `$${report.today.avgTicket.toFixed(2)}`,
      sub: `Yesterday same time was $${report.comparison.sameTime.yesterday.avgTicket.toFixed(2)}`,
    },
  ];

  const weekRows = report.week.days.map(day => `
    <tr>
      <td>${escapeHtml(day.fullLabel || day.label || '')}</td>
      <td>$${day.revenue.toFixed(1)}</td>
      <td>${day.orders}</td>
      <td>$${day.avgTicket.toFixed(2)}</td>
      <td>${day.isToday ? 'Partial day' : 'Full day'}</td>
    </tr>
  `).join('');

  const productRows = report.products.topRevenue.slice(0, 6).map(product => `
    <tr>
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(product.category || '')}</td>
      <td>${product.qty}</td>
      <td>$${product.amount.toFixed(2)}</td>
      <td>${product.sharePct.toFixed(2)}%</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PROSPERITY XH Daily Report - ${escapeHtml(report.dateKey)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f8fc; color: #1f2430; }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 32px 20px 60px; }
    h1, h2 { margin: 0 0 12px; }
    h1 { font-size: 32px; }
    h2 { font-size: 22px; margin-top: 0; }
    p { line-height: 1.7; color: #3b4252; }
    .card { background: #fff; border: 1px solid #dde3ef; border-radius: 20px; padding: 22px; margin-top: 18px; box-shadow: 0 10px 25px rgba(32, 51, 84, 0.05); }
    .top-note { font-size: 13px; color: #6f768a; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
    .metric { background: #f9fbff; border: 1px solid #dde3ef; border-radius: 16px; padding: 16px; }
    .metric .label { font-size: 12px; text-transform: uppercase; color: #6f768a; font-weight: 700; letter-spacing: .06em; }
    .metric .value { font-size: 28px; font-weight: 800; margin-top: 8px; }
    .metric .sub { font-size: 13px; color: #6f768a; margin-top: 8px; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .bullet-list { padding-left: 20px; margin: 0; }
    .bullet-list li { margin: 10px 0; line-height: 1.65; color: #3b4252; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #e6e8f0; text-align: left; font-size: 14px; }
    th { color: #6f768a; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
    .bar-list-row { margin-bottom: 14px; }
    .bar-list-copy { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; font-size: 14px; }
    .bar-list-label { color: #1f2430; font-weight: 600; }
    .bar-list-value { color: #4c5467; }
    .bar-list-track { height: 10px; background: #eef2fa; border-radius: 999px; overflow: hidden; }
    .bar-list-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #7fa4f9 0%, #5477c4 100%); }
    .inline-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1f4fb; padding: 2px 6px; border-radius: 6px; }
    @media (max-width: 860px) { .summary-grid, .two-col { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>PROSPERITY XH 每日营业报告</h1>
    <p class="top-note">营业日 ${escapeHtml(report.dateKey)} · 生成时间 ${escapeHtml(report.generatedAt)} · Agent mode: <span class="inline-code">${escapeHtml(report.agent.mode)}</span></p>

    <section class="card">
      <h2>Executive Summary</h2>
      <ul class="bullet-list">
        ${report.sections.executiveSummary.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
      <div class="summary-grid">
        ${summaryCards.map(card => `
          <div class="metric">
            <div class="label">${escapeHtml(card.label)}</div>
            <div class="value">${escapeHtml(card.value)}</div>
            <div class="sub">${escapeHtml(card.sub)}</div>
          </div>
        `).join('')}
      </div>
    </section>

    ${renderListSection('Key Findings', report.sections.keyFindings)}

    <section class="card two-col">
      <div>
        <h2>本周营业表现</h2>
        <p>本周目前最好的营业日是 <strong>${escapeHtml(report.week.bestDay.fullLabel)}</strong>，收入 $${report.week.bestDay.revenue.toFixed(1)}，订单 ${report.week.bestDay.orders} 单，客单价 $${report.week.bestDay.avgTicket.toFixed(2)}。</p>
        <table>
          <thead>
            <tr><th>Date</th><th>Revenue</th><th>Orders</th><th>Avg Ticket</th><th>Status</th></tr>
          </thead>
          <tbody>${weekRows}</tbody>
        </table>
      </div>
      <div>
        <h2>今日高峰时段</h2>
        <p>今天的营业高峰仍然集中在午餐档，下面是当前已出数据里收入最高的时段。</p>
        ${renderBarList(report.today.topHours.map(item => ({
          label: `${item.hour} · ${item.orders} 单`,
          revenue: item.revenue,
        })), 'revenue', value => `$${value.toFixed(1)}`)}
      </div>
    </section>

    <section class="card two-col">
      <div>
        <h2>拉动营业额的菜品</h2>
        <p>今天营收主要由主食和头部小吃支撑。前两名单品合计贡献 $${report.products.topTwoRevenue.toFixed(2)}，占今天营业额 ${report.products.topTwoSharePct.toFixed(1)}%。</p>
        <table>
          <thead>
            <tr><th>Product</th><th>Category</th><th>Qty</th><th>Revenue</th><th>Share</th></tr>
          </thead>
          <tbody>${productRows}</tbody>
        </table>
      </div>
      <div>
        <h2>低贡献 / 待观察品项</h2>
        <p>当前接口里的成本字段仍是 0，所以这里先按低销售贡献展示，不把它误当作真实毛利率判断。</p>
        ${renderBarList(report.products.lowContribution.map(item => ({
          label: item.name,
          amount: item.amount,
        })), 'amount', value => `$${value.toFixed(2)}`)}
      </div>
    </section>

    ${renderListSection('Recommended Next Steps', report.sections.recommendations)}
    ${renderListSection('Further Questions', report.sections.furtherQuestions)}
    ${renderListSection('Caveats', report.sections.caveats)}
  </div>
</body>
</html>`;
}

async function createDailySalesReport(context, options = {}) {
  const dateKey = String(context?.summary?.ordersDateKey || '').trim();
  if (!dateKey) {
    throw new Error('Missing ordersDateKey for daily report generation');
  }

  const todayOrders = filterComparableOrders(context.todayOrders || []);
  const yesterdayOrders = filterComparableOrders(context.yesterdayOrders || []);
  const todayTotals = {
    totalRevenue: round2(context.summary?.totalRevenue),
    totalOrders: Number(context.summary?.totalOrders) || 0,
    avgTicket: round2(context.summary?.avgTicket),
    topHours: pickTopHours(context.hourlySales || []),
    mix: {
      type: countBy(todayOrders, 'type'),
      source: countBy(todayOrders, 'source'),
      amountBuckets: bucketOrdersByAmount(todayOrders),
    },
  };
  const yesterdayTotals = aggregateOrders(yesterdayOrders);
  const sameTimeCutoff = findLatestOrderTime(todayOrders).slice(11, 16);
  const yesterdaySameTimeOrders = sameTimeCutoff
    ? yesterdayOrders.filter(order => String(order?.dateTime || '').slice(11, 16) <= sameTimeCutoff)
    : yesterdayOrders;
  const yesterdaySameTimeTotals = aggregateOrders(yesterdaySameTimeOrders);
  const weekDays = (context.summary?.weeklyOverview?.daily || []).filter(item => item?.hasData);
  const bestDay = context.summary?.weeklyOverview?.bestDay || weekDays.slice().sort((left, right) => (right.revenue || 0) - (left.revenue || 0))[0] || {
    fullLabel: '',
    revenue: 0,
    orders: 0,
    avgTicket: 0,
  };
  const topRevenue = (context.summary?.products || []).slice().sort((left, right) => (right.amount || 0) - (left.amount || 0));
  const lowContribution = topRevenue.slice().sort((left, right) => (left.amount || 0) - (right.amount || 0)).slice(0, 5);
  const topTwoRevenue = round2(topRevenue.slice(0, 2).reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
  const topTwoSharePct = todayTotals.totalRevenue > 0 ? round2((topTwoRevenue / todayTotals.totalRevenue) * 100) : 0;

  const report = {
    version: 1,
    dateKey,
    generatedAt: new Date().toISOString(),
    generatedBy: 'PROSPERITY-XH report-agent',
    lifecycle: {
      stage: String(options.stage || 'snapshot').trim().toLowerCase() === 'final' ? 'final' : 'snapshot',
      trigger: String(options.trigger || 'manual').trim() || 'manual',
      storeState: String(options.storeState || '').trim() || null,
    },
    today: todayTotals,
    yesterday: {
      dateKey: shiftDateKey(dateKey, -1),
      ...yesterdayTotals,
      mix: {
        type: countBy(yesterdayOrders, 'type'),
        source: countBy(yesterdayOrders, 'source'),
        amountBuckets: bucketOrdersByAmount(yesterdayOrders),
      },
    },
    comparison: {
      fullDay: {
        revenue: {
          delta: round2(todayTotals.totalRevenue - yesterdayTotals.totalRevenue),
          pct: yesterdayTotals.totalRevenue > 0
            ? round2(((todayTotals.totalRevenue - yesterdayTotals.totalRevenue) / yesterdayTotals.totalRevenue) * 100)
            : 0,
        },
        orders: {
          delta: todayTotals.totalOrders - yesterdayTotals.totalOrders,
        },
      },
      sameTime: {
        cutoffTime: sameTimeCutoff,
        today: {
          totalOrders: todayTotals.totalOrders,
          totalRevenue: todayTotals.totalRevenue,
          avgTicket: todayTotals.avgTicket,
        },
        yesterday: {
          totalOrders: yesterdaySameTimeTotals.totalOrders,
          totalRevenue: yesterdaySameTimeTotals.totalRevenue,
          avgTicket: yesterdaySameTimeTotals.avgTicket,
          amountBuckets: bucketOrdersByAmount(yesterdaySameTimeOrders),
        },
        revenue: {
          delta: round2(todayTotals.totalRevenue - yesterdaySameTimeTotals.totalRevenue),
          pct: yesterdaySameTimeTotals.totalRevenue > 0
            ? round2(((todayTotals.totalRevenue - yesterdaySameTimeTotals.totalRevenue) / yesterdaySameTimeTotals.totalRevenue) * 100)
            : 0,
        },
        orders: {
          delta: todayTotals.totalOrders - yesterdaySameTimeTotals.totalOrders,
        },
        avgTicket: {
          delta: round2(todayTotals.avgTicket - yesterdaySameTimeTotals.avgTicket),
          pct: yesterdaySameTimeTotals.avgTicket > 0
            ? round2(((todayTotals.avgTicket - yesterdaySameTimeTotals.avgTicket) / yesterdaySameTimeTotals.avgTicket) * 100)
            : 0,
        },
      },
    },
    week: {
      rangeLabel: context.summary?.weeklyOverview?.dateRangeLabel || '',
      bestDay,
      days: weekDays,
    },
    products: {
      topRevenue,
      lowContribution,
      topTwoRevenue,
      topTwoSharePct,
    },
  };

  const narrative = await createNarrative(report, options);
  report.agent = {
    mode: narrative.mode,
    hasOpenAISummary: narrative.mode === 'openai',
  };
  report.sections = narrative.content;
  report.html = renderDailyReportHTML(report);

  return report;
}

function persistDailySalesReport(report, reportsDir) {
  const dailyDir = path.join(reportsDir, 'daily', report.dateKey);
  fs.mkdirSync(dailyDir, { recursive: true });

  const stage = report?.lifecycle?.stage === 'final' ? 'final' : 'snapshot';
  const stageSuffix = stage === 'final' ? '.final' : '.snapshot';
  const jsonPath = path.join(dailyDir, `report${stageSuffix}.json`);
  const htmlPath = path.join(dailyDir, `report${stageSuffix}.html`);
  const latestAliasJsonPath = path.join(dailyDir, 'report.json');
  const latestAliasHtmlPath = path.join(dailyDir, 'report.html');
  const indexPath = path.join(dailyDir, 'meta.json');
  const latestJsonPath = path.join(reportsDir, 'daily', 'latest.json');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(htmlPath, report.html, 'utf8');
  fs.writeFileSync(latestAliasJsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(latestAliasHtmlPath, report.html, 'utf8');

  let previousIndex = {};
  if (fs.existsSync(indexPath)) {
    try {
      previousIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch {
      previousIndex = {};
    }
  }

  const indexPayload = {
    dateKey: report.dateKey,
    latestStage: stage,
    latestGeneratedAt: report.generatedAt,
    latestJsonPath: `/reports/daily/${report.dateKey}/report.json`,
    latestHtmlPath: `/reports/daily/${report.dateKey}/report.html`,
    agentMode: report.agent.mode,
    snapshot: previousIndex.snapshot || null,
    final: previousIndex.final || null,
  };

  indexPayload[stage] = {
    generatedAt: report.generatedAt,
    jsonPath: `/reports/daily/${report.dateKey}/report${stageSuffix}.json`,
    htmlPath: `/reports/daily/${report.dateKey}/report${stageSuffix}.html`,
    agentMode: report.agent.mode,
  };
  fs.writeFileSync(indexPath, JSON.stringify(indexPayload, null, 2));

  fs.writeFileSync(latestJsonPath, JSON.stringify({
    dateKey: report.dateKey,
    generatedAt: report.generatedAt,
    stage,
    jsonPath: `/reports/daily/${report.dateKey}/report.json`,
    htmlPath: `/reports/daily/${report.dateKey}/report.html`,
    agentMode: report.agent.mode,
  }, null, 2));

  return {
    dateKey: report.dateKey,
    generatedAt: report.generatedAt,
    stage,
    jsonPath: `/reports/daily/${report.dateKey}/report.json`,
    htmlPath: `/reports/daily/${report.dateKey}/report.html`,
    agentMode: report.agent.mode,
    variantJsonPath: `/reports/daily/${report.dateKey}/report${stageSuffix}.json`,
    variantHtmlPath: `/reports/daily/${report.dateKey}/report${stageSuffix}.html`,
  };
}

module.exports = {
  createDailySalesReport,
  persistDailySalesReport,
};

// lib/db/orders.js
'use strict';

const { getSupabaseAdminClient } = require('../supabaseClient');

/**
 * 在事务中插入订单以及对应的明细。
 * 为简化示例，我们先分别插入主表再批量插入明细，
 * 在生产环境建议改为 PostgreSQL 存储过程实现原子性。
 * @param {Object} order 主订单对象（对应 orders 表字段）
 * @param {Array<Object>} items 明细数组（对应 order_items 表字段）
 * @returns {Promise<{order: Object, items: Array<Object>}>}
 */
async function insertOrderWithItems(order, items) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error('Supabase 未配置');

  // 插入主订单
  const { data: orderRow, error: orderErr } = await supabase
    .from('orders')
    .insert([
      {
        store_id: order.store_id,
        source_order_id: order.source_order_id,
        ordered_at: order.ordered_at,
        business_date: order.business_date,
        status: order.status,
        channel: order.channel,
        total_cents: order.total_cents,
        currency: order.currency,
        payment_methods: order.payment_methods,
        details_complete: order.details_complete,
        source_data: order.source_data,
      },
    ])
    .single();

  if (orderErr) throw orderErr;

  // 为每条明细补充 order_id
  const itemsPayload = items.map((it) => ({
    order_id: orderRow.id,
    product_id: it.product_id,
    source_line_id: it.source_line_id,
    product_name: it.product_name,
    quantity: it.quantity,
    unit_price_cents: it.unit_price_cents,
    total_cents: it.total_cents,
    source_data: it.source_data,
  }));

  const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload);
  if (itemsErr) throw itemsErr;

  return { order: orderRow, items: itemsPayload };
}

/**
 * 查询某门店某日期的 daily 销售统计（只读 API 使用）
 */
async function getDailySales(storeId, businessDate) {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('sales_daily')
    .select('*')
    .eq('store_id', storeId)
    .eq('business_date', businessDate)
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  insertOrderWithItems,
  getDailySales,
};

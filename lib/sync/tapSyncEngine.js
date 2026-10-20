// lib/sync/tapSyncEngine.js
'use strict';

const crypto = require('crypto');
const { getSupabaseAdminClient } = require('../supabaseClient');
const { insertOrderWithItems } = require('../db/orders');

/**
 * 生成增量数据的 MD5 指纹，用于去重。
 * @param {Object} data 完整的 TapTouch 抓取对象（JSON）
 * @returns {string} 十六进制 MD5
 */
function fingerprint(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

/**
 * 检查当前指纹是否已经同步完成。
 */
async function isAlreadySynced(fp) {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('sync_runs')
    .select('id')
    .eq('fingerprint', fp)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // 记录不存在时会报 404
  return !!data;
}

/**
 * 主同步函数，接受从 TapTouch 抓取的原始对象。
 * @param {Object} tapData 必须包含 { store_id, orders: [] }
 * @returns {Promise<Object>} 同步结果统计
 */
async function syncTapData(tapData) {
  const fp = fingerprint(tapData);
  if (await isAlreadySynced(fp)) {
    console.info('🟢 指纹已同步，跳过');
    return { skipped: true };
  }

  const supabase = getSupabaseAdminClient();
  // 写入 sync_runs（running）
  const { data: runRow, error: runErr } = await supabase
    .from('sync_runs')
    .insert([
      {
        source: 'taptouch',
        store_id: tapData.store_id,
        sync_type: 'incremental',
        status: 'running',
        fingerprint: fp,
        records_processed: 0,
        records_failed: 0,
      },
    ])
    .single();
  if (runErr) throw runErr;

  let processed = 0;
  let failed = 0;

  try {
    for (const order of tapData.orders) {
      const items = order.items.map((it) => ({
        product_id: it.product_id,
        source_line_id: it.source_line_id,
        product_name: it.product_name,
        quantity: it.quantity,
        unit_price_cents: it.unit_price_cents,
        total_cents: it.total_cents,
        source_data: it.source_data,
      }));

      await insertOrderWithItems(
        {
          store_id: tapData.store_id,
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
        items
      );
      processed += 1;
    }

    // 更新为成功状态
    await supabase
      .from('sync_runs')
      .update({
        status: 'success',
        finished_at: new Date().toISOString(),
        records_processed: processed,
        records_failed: failed,
      })
      .eq('id', runRow.id);
  } catch (e) {
    failed = processed;
    await supabase
      .from('sync_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        records_processed: processed,
        records_failed: failed,
        error_message: e.message,
      })
      .eq('id', runRow.id);
    throw e;
  }

  return { processed, failed };
}

module.exports = {
  syncTapData,
  fingerprint,
};

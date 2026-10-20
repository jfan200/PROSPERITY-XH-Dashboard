'use strict';

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

/**
 * 检查环境变量是否完整且符合基本格式要求
 * @returns {boolean} 是否已配置 Supabase
 */
function isSupabaseConfigured() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return Boolean(url && key && url.startsWith('https://') && key.length > 10);
}

/**
 * 返回一个管理员权限的 Supabase 客户端单例。
 * 如未配置返回 null，调用方自行处理。
 * @returns {object|null}
 */
function getSupabaseAdminClient() {
  if (!isSupabaseConfigured()) {
    return null;
  }
  if (!cachedClient) {
    const url = process.env.SUPABASE_URL.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY.trim();
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      db: {
        schema: 'public',
      },
    });
  }
  return cachedClient;
}

/**
 * 重置缓存的 client（用于测试或重新加载配置）
 */
function resetSupabaseClient() {
  cachedClient = null;
}

module.exports = {
  isSupabaseConfigured,
  getSupabaseAdminClient,
  resetSupabaseClient,
};

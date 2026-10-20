'use strict';

const { getSupabaseAdminClient, isSupabaseConfigured, resetSupabaseClient } = require('../lib/supabaseClient');

describe('lib/supabaseClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    resetSupabaseClient();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('isSupabaseConfigured returns false when env variables are missing', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isSupabaseConfigured()).toBe(false);
    expect(getSupabaseAdminClient()).toBeNull();
  });

  test('getSupabaseAdminClient returns singleton client when env is configured', () => {
    process.env.SUPABASE_URL = 'https://mock-proj.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key-12345';
    expect(isSupabaseConfigured()).toBe(true);
    const client1 = getSupabaseAdminClient();
    const client2 = getSupabaseAdminClient();
    expect(client1).not.toBeNull();
    expect(client1).toBe(client2);
  });
});

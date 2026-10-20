'use strict';

const request = require('supertest');
const { app } = require('../../server');

// Set test API key
process.env.DSH_API_KEY = 'testkey123';

describe('DSH API permission', () => {
  test('Missing API key returns 401', async () => {
    const res = await request(app).get('/api/v1/sales/summary');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  test('Invalid API key returns 401', async () => {
    const res = await request(app)
      .get('/api/v1/sales/summary')
      .set('x-api-key', 'wrongkey');
    expect(res.status).toBe(401);
  });

  test('Valid API key returns 200', async () => {
    const res = await request(app)
      .get('/api/v1/sales/summary')
      .set('x-api-key', process.env.DSH_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('meta');
  });
});

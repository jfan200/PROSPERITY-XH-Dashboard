'use strict';

const request = require('supertest');
const { app } = require('../../server'); // assuming server exports app

// Ensure a test API key is set
process.env.DSH_API_KEY = 'testkey123';

describe('DSH API contract', () => {
  test('GET /api/v1/sales/summary returns proper JSON schema', async () => {
    const res = await request(app)
      .get('/api/v1/sales/summary')
      .set('x-api-key', process.env.DSH_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta).toMatchObject({
      source: expect.any(String),
      fetchedAt: expect.any(String),
      integrity: expect.objectContaining({
        ordersCount: expect.any(Number),
        productCount: expect.any(Number),
        coverage: expect.any(String),
      }),
    });
    expect(res.body).toHaveProperty('data');
    expect(typeof res.body.data.totalRevenue).toBe('number');
    expect(typeof res.body.data.totalOrders).toBe('number');
    expect(typeof res.body.data.avgTicket).toBe('number');
  });
});

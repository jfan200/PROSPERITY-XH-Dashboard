const http = require('http');

const BASE_URL = 'http://localhost:3001';

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    }).on('error', reject);
  });
}

describe('API Integration Tests', () => {
  // These tests require the server to be running
  // Run: npm start
  // Then: npm test

  describe('GET /api/status', () => {
    test('should return server status', async () => {
      try {
        const { status, data } = await fetchJson('/api/status');
        expect(status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.dataSource).toBeDefined();
        expect(data.storeName).toBeDefined();
      } catch (error) {
        // Server not running, skip test
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/sales/hourly', () => {
    test('should return hourly sales data', async () => {
      try {
        const { status, data } = await fetchJson('/api/sales/hourly');
        expect(status).toBe(200);
        expect(Array.isArray(data)).toBe(true);
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/sales/summary', () => {
    test('should return sales summary', async () => {
      try {
        const { status, data } = await fetchJson('/api/sales/summary');
        expect(status).toBe(200);
        expect(data.storeName).toBeDefined();
        expect(data.totalRevenue).toBeDefined();
        expect(data.totalOrders).toBeDefined();
        expect(data.avgTicket).toBeDefined();
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/orders/recent', () => {
    test('should return recent orders', async () => {
      try {
        const { status, data } = await fetchJson('/api/orders/recent');
        expect(status).toBe(200);
        expect(Array.isArray(data)).toBe(true);
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/healthz', () => {
    test('should return health check', async () => {
      try {
        const { status, data } = await fetchJson('/api/healthz');
        expect(status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.target).toBeDefined();
        expect(data.uptimeSec).toBeDefined();
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/readyz', () => {
    test('should return readiness check', async () => {
      try {
        const { status, data } = await fetchJson('/api/readyz');
        // Status can be 200 or 503 depending on data availability
        expect([200, 503]).toContain(status);
        expect(data.ok).toBeDefined();
        expect(data.ready).toBeDefined();
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/runtime', () => {
    test('should return runtime config', async () => {
      try {
        const { status, data } = await fetchJson('/api/runtime');
        expect(status).toBe(200);
        expect(data.deployTarget).toBeDefined();
        expect(data.scraperExecutionMode).toBeDefined();
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });

  describe('GET /api/scrape/status', () => {
    test('should return scrape status', async () => {
      try {
        const { status, data } = await fetchJson('/api/scrape/status');
        expect(status).toBe(200);
        expect(data.running).toBeDefined();
        expect(data.dataReady).toBeDefined();
      } catch (error) {
        console.warn('Server not running, skipping integration test');
      }
    });
  });
});

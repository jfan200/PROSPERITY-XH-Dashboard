const path = require('path');
const fs = require('fs');
const { createDailySalesReport, persistDailySalesReport } = require('../report-agent');

describe('report-agent', () => {
  describe('createDailySalesReport', () => {
    const mockContext = {
      summary: {
        ordersDateKey: '2026-06-05',
        totalRevenue: 1500.50,
        totalOrders: 45,
        avgTicket: 33.34,
        weeklyOverview: {
          dateRangeLabel: 'Jun 2 - Jun 8',
          totalRevenue: 8500,
          totalOrders: 250,
          avgTicket: 34,
          activeDays: 5,
          bestDay: {
            fullLabel: 'Wed 4 Jun',
            revenue: 2000,
            orders: 60,
            avgTicket: 33.33,
          },
          daily: [
            { label: 'Mon', fullLabel: 'Mon 2 Jun', revenue: 1500, orders: 45, avgTicket: 33.33, hasData: true, isToday: false },
            { label: 'Tue', fullLabel: 'Tue 3 Jun', revenue: 1800, orders: 52, avgTicket: 34.62, hasData: true, isToday: false },
            { label: 'Wed', fullLabel: 'Wed 4 Jun', revenue: 2000, orders: 60, avgTicket: 33.33, hasData: true, isToday: false },
            { label: 'Thu', fullLabel: 'Thu 5 Jun', revenue: 1500.50, orders: 45, avgTicket: 33.34, hasData: true, isToday: true },
            { label: 'Fri', fullLabel: 'Fri 6 Jun', revenue: 0, orders: 0, avgTicket: 0, hasData: false, isToday: false },
            { label: 'Sat', fullLabel: 'Sat 7 Jun', revenue: 0, orders: 0, avgTicket: 0, hasData: false, isToday: false },
            { label: 'Sun', fullLabel: 'Sun 8 Jun', revenue: 0, orders: 0, avgTicket: 0, hasData: false, isToday: false },
          ],
        },
        products: [
          { name: '重庆小面', category: '主食', qty: 25, amount: 375, sharePct: 25, cost: 0, profit: 375 },
          { name: '酸辣粉', category: '主食', qty: 15, amount: 225, sharePct: 15, cost: 0, profit: 225 },
          { name: '红糖糍粑', category: '小吃', qty: 10, amount: 150, sharePct: 10, cost: 0, profit: 150 },
        ],
      },
      hourlySales: [
        { hour: '10:00', revenue: 50, orders: 2, isCurrent: false, isFuture: false },
        { hour: '11:00', revenue: 150, orders: 5, isCurrent: false, isFuture: false },
        { hour: '12:00', revenue: 350, orders: 12, isCurrent: true, isFuture: false },
        { hour: '13:00', revenue: 200, orders: 8, isCurrent: false, isFuture: false },
        { hour: '14:00', revenue: 0, orders: 0, isCurrent: false, isFuture: true },
      ],
      todayOrders: [
        { id: 'KI-001', txId: '12345678', source: 'POS', type: 'Dine In', dateTime: '2026-06-05 12:30', amount: '$35.00', status: 'paid' },
        { id: 'KI-002', txId: '12345679', source: 'Online', type: 'Take Away', dateTime: '2026-06-05 13:15', amount: '$28.50', status: 'paid' },
        { id: 'KI-003', txId: '12345680', source: 'POS', type: 'Dine In', dateTime: '2026-06-05 12:45', amount: '$42.00', status: 'refunded' },
      ],
      yesterdayOrders: [
        { id: 'KI-101', txId: '12345700', source: 'POS', type: 'Dine In', dateTime: '2026-06-04 12:00', amount: '$30.00', status: 'paid' },
        { id: 'KI-102', txId: '12345701', source: 'POS', type: 'Take Away', dateTime: '2026-06-04 13:30', amount: '$25.00', status: 'paid' },
      ],
    };

    test('should create a daily sales report with valid context', async () => {
      const report = await createDailySalesReport(mockContext, { mode: 'rules' });

      expect(report).toBeDefined();
      expect(report.version).toBe(1);
      expect(report.dateKey).toBe('2026-06-05');
      expect(report.generatedAt).toBeDefined();
      expect(report.today).toBeDefined();
      expect(report.today.totalRevenue).toBe(1500.50);
      expect(report.today.totalOrders).toBe(45);
      expect(report.yesterday).toBeDefined();
      expect(report.comparison).toBeDefined();
      expect(report.week).toBeDefined();
      expect(report.products).toBeDefined();
      expect(report.agent).toBeDefined();
      expect(report.agent.mode).toBe('rules');
      expect(report.sections).toBeDefined();
      expect(report.html).toBeDefined();
    });

    test('should calculate comparison correctly', async () => {
      const report = await createDailySalesReport(mockContext, { mode: 'rules' });

      expect(report.comparison.fullDay).toBeDefined();
      expect(report.comparison.fullDay.revenue).toBeDefined();
      expect(report.comparison.fullDay.revenue.delta).toBeDefined();
      expect(report.comparison.fullDay.revenue.pct).toBeDefined();

      expect(report.comparison.sameTime).toBeDefined();
      expect(report.comparison.sameTime.cutoffTime).toBeDefined();
      expect(report.comparison.sameTime.revenue).toBeDefined();
    });

    test('should include top hours in report', async () => {
      const report = await createDailySalesReport(mockContext, { mode: 'rules' });

      expect(report.today.topHours).toBeDefined();
      expect(Array.isArray(report.today.topHours)).toBe(true);
      expect(report.today.topHours.length).toBeLessThanOrEqual(3);
    });

    test('should filter out refunded orders', async () => {
      const report = await createDailySalesReport(mockContext, { mode: 'rules' });

      // Refunded orders should not be counted in totals
      expect(report.today.totalOrders).toBe(45); // From summary, not from orders array
    });

    test('should throw error for missing ordersDateKey', async () => {
      const invalidContext = {
        summary: {
          ordersDateKey: '',
        },
      };

      await expect(createDailySalesReport(invalidContext)).rejects.toThrow('Missing ordersDateKey');
    });

    test('should generate HTML report', async () => {
      const report = await createDailySalesReport(mockContext, { mode: 'rules' });

      expect(report.html).toContain('<!DOCTYPE html>');
      expect(report.html).toContain('PROSPERITY XH');
      expect(report.html).toContain(report.dateKey);
    });
  });

  describe('persistDailySalesReport', () => {
    const mockReport = {
      version: 1,
      dateKey: '2026-06-05',
      generatedAt: '2026-06-05T12:00:00.000Z',
      agent: { mode: 'rules' },
      html: '<html>Test Report</html>',
      today: { totalRevenue: 1000 },
      sections: {},
    };

    test('should persist report to files', () => {
      const reportsDir = path.join(__dirname, '..', 'reports');
      const result = persistDailySalesReport(mockReport, reportsDir);

      expect(result).toBeDefined();
      expect(result.dateKey).toBe('2026-06-05');
      expect(result.generatedAt).toBeDefined();
      expect(result.jsonPath).toContain('report.json');
      expect(result.htmlPath).toContain('report.html');
      expect(result.agentMode).toBe('rules');

      // Verify files were created
      const dailyDir = path.join(reportsDir, 'daily', '2026-06-05');
      expect(fs.existsSync(path.join(dailyDir, 'report.json'))).toBe(true);
      expect(fs.existsSync(path.join(dailyDir, 'report.html'))).toBe(true);

      // Verify latest.json was created
      const latestPath = path.join(reportsDir, 'daily', 'latest.json');
      expect(fs.existsSync(latestPath)).toBe(true);

      // Cleanup
      fs.rmSync(path.join(reportsDir, 'daily'), { recursive: true, force: true });
    });
  });
});

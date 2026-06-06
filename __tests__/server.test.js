const {
  round2,
  parseMoneyValue,
  parseLocalDateTime,
  formatDateKey,
  startOfWeekMonday,
  formatRangeLabel,
  getTodayDateKey,
  buildDayRange,
  isSummaryLikeOrder,
  mapRawOrdersToApiOrders,
  buildOrdersDataset,
  buildEmptyWeeklyOverview,
  buildEmptyDashboardData,
} = require('./server-helpers');

describe('server helpers', () => {
  describe('round2', () => {
    test('should round to 2 decimal places', () => {
      expect(round2(10.123)).toBe(10.12);
      expect(round2(10.125)).toBe(10.13);
      expect(round2(10.1)).toBe(10.1);
      expect(round2(0)).toBe(0);
      expect(round2(null)).toBe(0);
      expect(round2(undefined)).toBe(0);
    });
  });

  describe('parseMoneyValue', () => {
    test('should parse money strings correctly', () => {
      expect(parseMoneyValue('$10.50')).toBe(10.5);
      expect(parseMoneyValue('$1,234.56')).toBe(1234.56);
      expect(parseMoneyValue('10.50')).toBe(10.5);
      expect(parseMoneyValue('$0')).toBe(0);
      expect(parseMoneyValue('')).toBe(0);
      expect(parseMoneyValue(null)).toBe(0);
      expect(parseMoneyValue(undefined)).toBe(0);
    });
  });

  describe('parseLocalDateTime', () => {
    test('should parse datetime strings correctly', () => {
      const result1 = parseLocalDateTime('2026-06-05 12:30:00');
      expect(result1).toBeInstanceOf(Date);
      expect(result1.getFullYear()).toBe(2026);
      expect(result1.getMonth()).toBe(5); // June is 5
      expect(result1.getDate()).toBe(5);
      expect(result1.getHours()).toBe(12);
      expect(result1.getMinutes()).toBe(30);

      const result2 = parseLocalDateTime('2026-06-05T12:30');
      expect(result2).toBeInstanceOf(Date);
      expect(result2.getHours()).toBe(12);

      const result3 = parseLocalDateTime('2026-06-05');
      expect(result3).toBeInstanceOf(Date);
      expect(result3.getHours()).toBe(0);

      expect(parseLocalDateTime('')).toBeNull();
      expect(parseLocalDateTime(null)).toBeNull();
      expect(parseLocalDateTime('invalid')).toBeNull();
    });
  });

  describe('formatDateKey', () => {
    test('should format date to YYYY-MM-DD', () => {
      const date = new Date(2026, 5, 5); // June 5, 2026
      expect(formatDateKey(date)).toBe('2026-06-05');

      const date2 = new Date(2026, 0, 1); // January 1, 2026
      expect(formatDateKey(date2)).toBe('2026-01-01');
    });
  });

  describe('startOfWeekMonday', () => {
    test('should return Monday of the week', () => {
      // Thursday June 5, 2026
      const thursday = new Date(2026, 5, 5);
      const monday = startOfWeekMonday(thursday);
      expect(monday.getDay()).toBe(1); // Monday
      expect(monday.getDate()).toBe(1); // June 1

      // Sunday June 8, 2026
      const sunday = new Date(2026, 5, 8);
      const mondayFromSunday = startOfWeekMonday(sunday);
      expect(mondayFromSunday.getDay()).toBe(1);
      expect(mondayFromSunday.getDate()).toBe(1);

      // Monday June 1, 2026
      const mondayInput = new Date(2026, 5, 1);
      const mondayOutput = startOfWeekMonday(mondayInput);
      expect(mondayOutput.getDate()).toBe(1);
    });
  });

  describe('formatRangeLabel', () => {
    test('should format date range label', () => {
      const start = new Date(2026, 5, 1); // June 1
      const end = new Date(2026, 5, 7); // June 7
      expect(formatRangeLabel(start, end)).toBe('Jun 1 - 7');

      const start2 = new Date(2026, 5, 28); // June 28
      const end2 = new Date(2026, 6, 4); // July 4
      expect(formatRangeLabel(start2, end2)).toBe('Jun 28 - Jul 4');
    });
  });

  describe('getTodayDateKey', () => {
    test('should return today date key', () => {
      const today = new Date();
      const result = getTodayDateKey(today);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('buildDayRange', () => {
    test('should build day range from date key', () => {
      const { start, end } = buildDayRange('2026-06-05');
      expect(start.getFullYear()).toBe(2026);
      expect(start.getMonth()).toBe(5);
      expect(start.getDate()).toBe(5);
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);

      expect(end.getFullYear()).toBe(2026);
      expect(end.getMonth()).toBe(5);
      expect(end.getDate()).toBe(5);
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
      expect(end.getSeconds()).toBe(59);
    });

    test('should throw error for invalid date key', () => {
      expect(() => buildDayRange('invalid')).toThrow('Invalid date key');
      expect(() => buildDayRange('')).toThrow('Invalid date key');
      expect(() => buildDayRange(null)).toThrow('Invalid date key');
    });
  });

  describe('isSummaryLikeOrder', () => {
    test('should identify summary orders', () => {
      expect(isSummaryLikeOrder({ id: 'Total', txId: '', amount: '' })).toBe(true);
      expect(isSummaryLikeOrder({ id: 'Subtotal', txId: '', amount: '' })).toBe(true);
      expect(isSummaryLikeOrder({ id: 'Grand Total', txId: '', amount: '' })).toBe(true);
      expect(isSummaryLikeOrder({ id: '', txId: '', amount: '' })).toBe(true);
      expect(isSummaryLikeOrder(null)).toBe(true);
    });

    test('should identify real orders', () => {
      expect(isSummaryLikeOrder({
        id: 'KI-001',
        txId: '12345678',
        amount: '$35.00',
      })).toBe(false);

      expect(isSummaryLikeOrder({
        id: 'KT-021',
        txId: '98765432',
        amount: '$28.50',
      })).toBe(false);
    });
  });

  describe('mapRawOrdersToApiOrders', () => {
    test('should map raw orders to API format', () => {
      const rawOrders = [
        {
          id: 'KI-001',
          txId: '12345678',
          source: 'POS',
          type: 'Dine In',
          date: '2026-06-05 12:30',
          cashier: 'John',
          customer: 'Walk-in',
          tax: '$3.18',
          amount: '$35.00',
          status: 'paid',
          detailUrl: 'https://example.com',
        },
        {
          id: 'Total',
          txId: '',
          amount: '$35.00',
        },
      ];

      const result = mapRawOrdersToApiOrders(rawOrders);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('KI-001');
      expect(result[0].txId).toBe('12345678');
      expect(result[0].source).toBe('POS');
      expect(result[0].type).toBe('Dine In');
      expect(result[0].date).toBe('12:30');
      expect(result[0].dateTime).toBe('2026-06-05 12:30');
      expect(result[0].amount).toBe('$35.00');
      expect(result[0].status).toBe('paid');
    });

    test('should handle empty orders array', () => {
      const result = mapRawOrdersToApiOrders([]);
      expect(result).toEqual([]);
    });

    test('should handle null orders', () => {
      const result = mapRawOrdersToApiOrders(null);
      expect(result).toEqual([]);
    });
  });

  describe('buildOrdersDataset', () => {
    test('should build orders dataset', () => {
      const orders = [
        {
          id: 'KI-001',
          txId: '12345678',
          source: 'POS',
          type: 'Dine In',
          date: '2026-06-05 12:30',
          amount: '$35.00',
          status: 'paid',
        },
        {
          id: 'KI-002',
          txId: '12345679',
          source: 'Online',
          type: 'Take Away',
          date: '2026-06-05 13:15',
          amount: '$28.50',
          status: 'paid',
        },
      ];

      const result = buildOrdersDataset(orders, { dateKey: '2026-06-05' });

      expect(result.dateKey).toBe('2026-06-05');
      expect(result.totalOrders).toBe(2);
      expect(result.totalRevenue).toBe(63.5);
      expect(result.avgTicket).toBe(31.75);
      expect(result.orders.length).toBe(2);
    });

    test('should handle empty orders', () => {
      const result = buildOrdersDataset([], { dateKey: '2026-06-05' });
      expect(result.totalOrders).toBe(0);
      expect(result.totalRevenue).toBe(0);
      expect(result.avgTicket).toBe(0);
    });
  });

  describe('buildEmptyWeeklyOverview', () => {
    test('should build empty weekly overview', () => {
      const referenceDate = new Date(2026, 5, 5); // June 5, 2026
      const result = buildEmptyWeeklyOverview(referenceDate);

      expect(result.dateRangeLabel).toBeDefined();
      expect(result.totalRevenue).toBe(0);
      expect(result.totalOrders).toBe(0);
      expect(result.avgTicket).toBe(0);
      expect(result.activeDays).toBe(0);
      expect(result.bestDay).toBeNull();
      expect(result.daily.length).toBe(7);
      expect(result.daily[0].label).toBe('Mon');
      expect(result.daily[6].label).toBe('Sun');
    });
  });

  describe('buildEmptyDashboardData', () => {
    test('should build empty dashboard data', () => {
      const referenceDate = new Date(2026, 5, 5);
      const result = buildEmptyDashboardData(referenceDate);

      expect(result.storeName).toBe('PROSPERITY XH');
      expect(result.brandName).toBe('食集-重庆小面');
      expect(result.totalRevenue).toBe(0);
      expect(result.totalOrders).toBe(0);
      expect(result.avgTicket).toBe(0);
      expect(result.hourlySales).toEqual([]);
      expect(result.payments).toEqual([]);
      expect(result.recentOrders).toEqual([]);
      expect(result.ordersDateKey).toBe('2026-06-05');
      expect(result.weeklyOverview).toBeDefined();
      expect(result.syncState).toBeNull();
      expect(result.orderDetails).toEqual({});
      expect(result.salesReport).toEqual({});
      expect(result.scrapedAt).toBeNull();
      expect(result.products).toEqual([]);
    });
  });
});

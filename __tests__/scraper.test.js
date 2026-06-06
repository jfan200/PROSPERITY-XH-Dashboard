const {
  parseReceiptDetail,
} = require('../scraper');

describe('scraper', () => {
  describe('parseReceiptDetail', () => {
    const mockOrder = {
      id: 'KI-001',
      txId: '12345678',
      date: '2026-06-05 12:30',
      type: 'Dine In',
      amount: '$35.00',
    };

    test('should parse receipt with items and totals', () => {
      const bodyText = `
        Transaction Receipt
        Order Time: 2026-06-05 12:30
        Fulfillment: Dine In
        Transaction Id: 12345678
        
        Item Name Qty Price($)
        重庆小面 2 $24.00
        酸辣粉 1 $12.00
        + 加蛋 2 $4.00
        
        Sub-Total $40.00
        GST Included In Total $3.64
        Surcharge $0.00
        Card $40.00
        Total Paid $40.00
      `;

      const result = parseReceiptDetail(bodyText, mockOrder, 'https://example.com/receipt');

      expect(result).toBeDefined();
      expect(result.orderId).toBe('KI-001');
      expect(result.txId).toBe('12345678');
      expect(result.url).toBe('https://example.com/receipt');
      expect(result.receipt).toBeDefined();
      expect(result.receipt.fulfillment).toBe('Dine In');
      expect(result.receipt.orderTime).toBe('2026-06-05 12:30');
      expect(result.receipt.transactionId).toBe('12345678');

      expect(result.items).toBeDefined();
      expect(result.items.length).toBe(2);
      expect(result.items[0].name).toBe('重庆小面');
      expect(result.items[0].qty).toBe('2');
      expect(result.items[0].subtotal).toBe('$24.00');
      expect(result.items[0].note).toContain('加蛋');

      expect(result.totals).toBeDefined();
      expect(result.totals.subtotal).toBe(40);
      expect(result.totals.gst).toBe(3.64);
      expect(result.totals.totalPaid).toBe(40);

      expect(result.payment).toBeDefined();
      expect(result.payment.card).toBe(40);
      expect(result.payment.cash).toBe(0);
    });

    test('should handle receipt with cash payment', () => {
      const bodyText = `
        Transaction Receipt
        Order Time: 2026-06-05 13:00
        Fulfillment: Take Away
        
        Item Name Qty Price($)
        红糖糍粑 3 $18.00
        
        Sub-Total $18.00
        GST Included In Total $1.64
        Cash $18.00
        Total Paid $18.00
      `;

      const result = parseReceiptDetail(bodyText, { ...mockOrder, type: 'Take Away' }, 'https://example.com');

      expect(result.items.length).toBe(1);
      expect(result.items[0].name).toBe('红糖糍粑');
      expect(result.totals.subtotal).toBe(18);
      expect(result.payment.cash).toBe(18);
      expect(result.payment.card).toBe(0);
    });

    test('should handle empty or invalid receipt', () => {
      const bodyText = 'Invalid receipt content';

      const result = parseReceiptDetail(bodyText, mockOrder, 'https://example.com');

      expect(result).toBeDefined();
      expect(result.items).toBeDefined();
      expect(result.items.length).toBe(0);
      expect(result.totals.subtotal).toBe(0);
    });

    test('should parse addons correctly', () => {
      const bodyText = `
        Transaction Receipt
        
        Item Name Qty Price($)
        重庆小面 1 $15.00
        + 加辣 $0.00
        + 加面 $3.00
        酸辣粉 1 $12.00
        + 加醋 $0.00
        
        Sub-Total $30.00
        Total Paid $30.00
      `;

      const result = parseReceiptDetail(bodyText, mockOrder, 'https://example.com');

      expect(result.items.length).toBe(2);
      expect(result.items[0].note).toContain('加辣');
      expect(result.items[0].note).toContain('加面');
      expect(result.items[0].note).toContain('(+');
      expect(result.items[1].note).toContain('加醋');
    });

    test('should handle multiple payment methods', () => {
      const bodyText = `
        Transaction Receipt
        
        Item Name Qty Price($)
        重庆小面 2 $30.00
        
        Sub-Total $30.00
        GST Included In Total $2.73
        Card $20.00
        Cash $10.00
        Total Paid $30.00
      `;

      const result = parseReceiptDetail(bodyText, mockOrder, 'https://example.com');

      expect(result.payment.methods).toBeDefined();
      expect(result.payment.methods.length).toBe(2);
      expect(result.payment.card).toBe(20);
      expect(result.payment.cash).toBe(10);
    });

    test('should parse compact one-line receipt text from cached detail pages', () => {
      const bodyText = 'Transaction Receipt Receipt Receipt Foodie Fair The Glen 食集-重庆小面 https://spicynoodlesglen.lifeintouch.net ABN: 35 623 264 148 Phone: +61432201585 Address: 74-76 Kingsway, Glen Waverley, VIC, 3150 Customer: 278 Fulfillment: Dine In Order Time: Sat 06 Jun 2026 13:27 Transaction Id: 214658693660433 Item Name Price($) 老麻抄手(10pcs)Numbing Mala Wontons 1 16.80 + 不辣Not Spicy x 1 0.00 + 只要葱花(Scallions Only) x 1 0.00 老麻抄手(10pcs)Numbing Mala Wontons 1 16.80 + 不辣Not Spicy x 1 0.00 + 只要葱花(Scallions Only) x 1 0.00 Sub-Total 33.60 Total $33.60 GST Included In Total $3.05 Flexible $33.60 Total Paid $33.60 Reward Points: 0, Available Points: 0 Credit Balance: $0.00';

      const result = parseReceiptDetail(bodyText, {
        ...mockOrder,
        id: 'KI-026',
        txId: '214658693660433',
        amount: '$33.60',
      }, 'https://example.com/compact');

      expect(result.items.length).toBe(2);
      expect(result.items[0].name).toContain('老麻抄手');
      expect(result.items[0].subtotal).toBe('$16.80');
      expect(result.items[0].note).toContain('不辣');
      expect(result.totals.subtotal).toBe(33.6);
      expect(result.totals.totalPaid).toBe(33.6);
      expect(result.receipt.transactionId).toBe('214658693660433');
    });
  });
});

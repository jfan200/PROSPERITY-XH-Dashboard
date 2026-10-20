'use strict';

/** 商品报表归一化：回答「哪个菜卖得好、毛利多少」。 */

const { productsFromExport, REPORT_PATHS } = require('../../lib/adapters/taptouch-export');

const HEADER = ['Name','Variant','Code','Category','Online Quantity Sold','Online Net Sales($)',
  'Total Quantity Sold','Total Net Sales($)','Net Sales Share(%)','Total Cost($)','Total Profit($)'];

module.exports = function register({ assert, assertEqual }) {
  console.log('\n=== products export ===\n');

  {
    const rows = [
      HEADER,
      ['炸臭豆腐 Fried Stinky Tofu (6pcs)','-','','小吃 Snacks','0','0','5','50','15.5','0','50'],
      ['红烧牛肉面','-','A01','主食 Main','12','240','12','240','74.4','60','180'],
    ];
    const products = productsFromExport(rows);

    assertEqual(products.length, 2, '两行商品');
    const first = products[0];
    assertEqual(first.name, '炸臭豆腐 Fried Stinky Tofu (6pcs)', 'name 透传');
    assertEqual(first.category, '小吃 Snacks', 'category 透传');
    assertEqual(first.qtySold, 5, 'Total Quantity Sold 转数字');
    assertEqual(first.netSales, 50, 'Total Net Sales 转数字');
    assertEqual(first.netSalesShare, 15.5, '占比转数字');
    assertEqual(first.cost, 0, 'cost 转数字');
    assertEqual(first.profit, 50, 'profit 转数字');

    const second = products[1];
    assertEqual(second.qtySold, 12, '第二行数量');
    assertEqual(second.cost, 60, '第二行成本');
    assertEqual(second.profit, 180, '第二行利润');
  }


  {
    const rows = [
      HEADER,
      ['重庆小面','-','13','主食','121','2004.76','121','2004.76','100','0','2004.76'],
      ['Total','-','','','121','2004.76','121','2004.76','100','0','2004.76'],
    ];
    const products = productsFromExport(rows);
    assertEqual(products.length, 1, '汇总行 Total 被剔除，不会让营收翻倍');
  }
  {
    const products = productsFromExport([HEADER, ['', '-', '', '', '0', '0', '0', '0', '0', '0', '0']]);
    assertEqual(products.length, 0, '空名称行被跳过');
  }

  {
    assertEqual(REPORT_PATHS.orders, '/store/report/orders', '订单报表路径');
    assertEqual(REPORT_PATHS.products, '/store/report/product', '商品报表路径');
  }
};

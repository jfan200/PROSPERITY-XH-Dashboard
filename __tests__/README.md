# 测试说明

## 运行测试

### 运行所有单元测试
```bash
npm test
```

### 运行 Jest 测试（如果安装了 Jest）
```bash
npm run test:jest
```

### 运行语法检查
```bash
npm run check
```

## 测试文件结构

```
__tests__/
├── run-tests.js          # 自定义测试运行器（推荐）
├── server-helpers.js     # server.js 纯函数提取
├── server.test.js        # server.js 单元测试（Jest）
├── scraper.test.js       # scraper.js 单元测试（Jest）
├── report-agent.test.js  # report-agent.js 单元测试（Jest）
├── api.test.js           # API 集成测试（需要服务器运行）
└── simple.test.js        # 简单测试示例
```

## 测试覆盖范围

### Server Helpers (42 tests)
- `round2()` - 数值四舍五入
- `parseMoneyValue()` - 金额字符串解析
- `parseLocalDateTime()` - 日期时间解析
- `formatDateKey()` - 日期格式化
- `startOfWeekMonday()` - 周一计算
- `formatRangeLabel()` - 日期范围标签
- `getTodayDateKey()` - 今日日期
- `buildDayRange()` - 日期范围构建
- `isSummaryLikeOrder()` - 汇总订单识别
- `mapRawOrdersToApiOrders()` - 订单数据映射
- `buildOrdersDataset()` - 订单数据集构建
- `buildEmptyWeeklyOverview()` - 空周概览
- `buildEmptyDashboardData()` - 空仪表板数据

### Scraper (10 tests)
- `parseReceiptDetail()` - 收据解析
  - 基本解析
  - 现金支付
  - 多支付方式
  - Addon 解析
  - 空/无效收据处理

### Report Agent (Jest tests available)
- `createDailySalesReport()` - 日报生成
- `persistDailySalesReport()` - 日报持久化

## 添加新测试

### 使用自定义测试运行器
在 `run-tests.js` 中添加新的测试用例：

```javascript
console.log('\n新测试:');
assertEqual(actual, expected, '测试描述');
assert(condition, '条件测试');
```

### 使用 Jest
创建新的测试文件 `__tests__/new-test.test.js`：

```javascript
describe('模块名称', () => {
  test('测试用例', () => {
    expect(actual).toBe(expected);
  });
});
```

## 注意事项

1. API 集成测试需要服务器运行：`npm start`
2. Jest 测试可能需要额外配置
3. 自定义测试运行器会返回非零退出码表示失败

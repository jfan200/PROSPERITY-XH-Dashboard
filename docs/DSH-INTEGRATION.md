# DSH‑INTEGRATION.md

## 目标概述
本文件为 **DeepSeek Harness (DSH) AI Agent** 提供后端集成的设计与改造计划。核心目标是：
1. **复用现有的销售、订单、商品分析逻辑**（已在 `server.js`、`scraper.js` 与 `report‑agent.js` 中实现）。
2. **完善敏感 API 的访问控制**，仅允许只读查询。
3. **提升订单商品明细的覆盖率**，确保每笔订单的详情完整可用。
4. **为 AI Agent 设计统一的只读销售数据接口**，返回 JSON，包含数值类型校验及完整性元信息。
5. **保持原有 Dashboard 与日报功能不受影响**。
6. **新增 API 契约、权限、数据一致性测试**。

> **注意**：本阶段只在当前工作分支（`main`）下完成分析与方案文档，后续改动将通过 Pull Request 提交审核。

---

## 1️⃣ 现有代码关键点概览
| 文件 | 关键功能 | 关联路由/导出 |
|------|----------|---------------|
| `server.js` | Fastify 实例、公共静态资源、CORS、`/api/*` 路由的统一入口 | `app.get('/api/...')`、`app.post('/api/...')`（已存在的写操作） |
| `scraper.js` | 与 TapTouch 后端交互的爬虫实现，提供 **session**、**订单/商品抓取** 与 **单笔订单详情** | `fetchOrdersForDate*`、`fetchSingleOrderDetail*` |
| `report-agent.js` | 报表生成、每日快照、历史报告的调度器 | `createDailySalesReport`、`persistDailySalesReport` |
| `analytics-context.json` | 业务描述、维度、查询模式及 Gotchas（用于 UI 渲染） | 读取方式 `readAnalyticsContextConfig()` |
| `__tests__/` | Jest 单元/集成测试，覆盖 API、数据处理函数等 | 多文件，当前缺少 **只读 API 契约** 与 **权限** 测试 |

> 所有文件路径均使用 **GitHub‑style 链接**（如 `[server.js](file:///Users/jinhua/Documents/GitHub/PROSPERITY-XH-Dashboard/server.js)`）以便快速跳转。

---

## 2️⃣ 只读销售数据统一接口设计
### 2.1 API 端点
| 方法 | 路径 | 返回 | 说明 |
|------|------|------|------|
| `GET` | `/api/v1/sales/summary` | `{ dateKey, totalRevenue, totalOrders, avgTicket, fetchedAt, source, detailCoveragePct }` | 汇总今日/指定日期的销售概览（复用 `buildOrdersDataset`） |
| `GET` | `/api/v1/sales/orders` | `{ orders: [...], meta }` | 完整订单列表，分页支持 `?page=&limit=`（使用 `mapRawOrdersToApiOrders`） |
| `GET` | `/api/v1/sales/orders/:orderId` | `{ ...orderDetail }` | 单笔订单详情，确保 `detailCached:true` 并返回所有原始字段 |
| `GET` | `/api/v1/sales/products` | `{ products: [...], insights }` | 商品销售分析（复用 `buildProductReportDataset`） |
| `GET` | `/api/v1/analytics/context` | `analytics‑context.json` 内容 | 为前端/AI Agent 提供元数据 |

### 2.2 响应结构约定
* 所有数值字段（`totalRevenue`、`totalOrders`、`avgTicket`、`amount`、`qty`、`profit` 等）**使用 `Number` 类型**，通过 `round2` 统一保留两位小数。
* 每个响应体额外包含 `integrity` 元信息，例如：
```json
{"integrity": { "recordCount": 123, "hasMissingDetails": false, "generatedAt": "2026-10-15T22:00:00Z" }}
```
* 错误统一返回 `{ "error": { "code": "...", "message": "..." } }`，并使用合适的 HTTP 状态码。

---

## 3️⃣ 访问控制（ACL）方案
1. **全局只读中间件** – 在 `server.js` 中创建 `readonlyGuard`，拦截所有非 `GET` 方法并返回 `405 Method Not Allowed`（除仪表盘页面外的写接口保留内部调试使用）。
2. **API‑Key 鉴权** – 环境变量 `DSH_API_KEY`，请求需在 `Authorization: Bearer <key>` 头部提供。若缺失或不匹配，返回 `401 Unauthorized`。
3. **角色标记** – 可在 `req.context.role = 'dsh_reader'`，为后续细粒度权限检查预留。
4. **日志审计** – 所有 DSH 请求记录于 `logs/dsh-access.log`（通过 Fastify `onResponse` hook）。

---

## 4️⃣ 订单商品明细覆盖率提升
* **根因**：`fetchSingleOrderDetail*` 在网络错误或页面结构变化时返回 `null`，导致 `detailCached:false`。
* **改进措施**：
  - 在 `scraper.js` 为单笔订单详情增加 **重试机制**（最多 3 次）并在失败时记录错误。
  - 实现 **分页抓取**，确保所有订单都被遍历到。
  - 引入 **缓存失效策略**：若 `detailCached === false && order.dateTime < now - 24h`，在 API 返回中标记 `detailMissing:true` 并说明原因。
  - 在 `buildOrdersDataset` 中计算 `detailCoveragePct = cachedDetails / totalOrders * 100`，并在 `/sales/summary` 响应中返回。

---

## 5️⃣ 测试方案
### 5.1 契约测试（Contract Tests）
使用 **Jest + supertest**，对每个只读端点验证：
* HTTP 200
* `Content-Type: application/json`
* 响应符合预定义 **JSON Schema**（放在 `test/schemas/`）
* 所有数值字段为 `number`
* `integrity.recordCount` 与实际数组长度一致

### 5.2 权限测试
* 缺失 `Authorization` 头 → 401
* 错误 API‑Key → 401
* 非 `GET` 方法 → 405
* 正常 `GET` → 200

### 5.3 数据一致性测试
* `GET /sales/summary.totalRevenue` 与 `GET /sales/orders` 所有订单 `amount` 求和误差 ≤ 0.01。
* `GET /sales/products` 中 `insights.totalQty` 与订单商品 `qty` 汇总保持一致。

> 测试文件放在 `__tests__/dsh/`，在 `package.json` 添加脚本 `"test:dsh": "jest __tests__/dsh"`。

---

## 6️⃣ 实施路线图（分支 & PR）
1. **分支**：在当前分支上创建 `feature/dsh-integration`（如需要），本阶段文档已提交至 `main`。
2. **提交顺序**
   - `docs/DSH-INTEGRATION.md` – 本计划文档（已完成）
   - `server.js` – 添加只读中间件、API‑Key 鉴权、日志钩子
   - `scraper.js` – 加强单笔订单抓取的重试与缓存失效逻辑
   - `report-agent.js`（如需） – 确保每日快照仅内部使用
   - `analytics-context.json` – 增加 `dshReadOnly: true` 标记及完整性描述
   - `__tests__/dsh/` – 契约、权限、数据一致性测试
3. **Pull Request**：完成上述修改后，创建 PR 标题 `feat: DSH read‑only integration`，描述请引用本计划文件。
4. **审阅**：提交后我会通知您进行代码审查，批准后合并至 `main`。

---

## 7️⃣ 风险 & Mitigation
| 风险 | 影响 | 缓解措施 |
|------|------|-----------|
| TapTouch 页面结构突变 | 明细缺失，覆盖率下降 | 实现 **容错解析**（宽松正则）并加入 **自动报警**（邮件/Slack） |
| API‑Key 泄露 | 未授权读取数据 | 使用 **环境变量**，CI 中隐藏，生产仅内部网络访问 |
| 大量订单查询导致超时 | 响应性能下降 | 实现分页 (`limit`/`offset`) 并在前端做懒加载 |

---

## 8️⃣ 附录
* **文件链接**
  - `[server.js](file:///Users/jinhua/Documents/GitHub/PROSPERITY-XH-Dashboard/server.js)`
  - `[scraper.js](file:///Users/jinhua/Documents/GitHub/PROSPERITY-XH-Dashboard/scraper.js)`
  - `[report-agent.js](file:///Users/jinhua/Documents/GitHub/PROSPERITY-XH-Dashboard/report-agent.js)`
  - `[analytics-context.json](file:///Users/jinhua/Documents/GitHub/PROSPERITY-XH-Dashboard/analytics-context.json)`
* **参考文档**
  - Fastify 安全最佳实践
  - Jest 并发与超时配置

---

*此文档为后续实现提供蓝图，后续代码改动请严格遵循上述规划进行。*

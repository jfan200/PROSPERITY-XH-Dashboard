# PROSPERITY XH Dashboard

墨尔本 `食集-重庆小面 / PROSPERITY XH` 的店内运营看板。  
项目会从 TapTouch Backoffice 抓取真实营业数据，在本地或 Docker 中提供桌面端、移动端、日报和摄像头查看能力。

## 当前技术栈

- 前端: React + Vite
- 页面运行逻辑: 现有 `app.js` / `mobile.js` 业务逻辑由 React shell 承接
- 后端: Fastify
- 图表: Chart.js
- 抓取: Puppeteer Core
- 数据源: TapTouch Backoffice

## 当前功能

- 今日运营总览: 销售额、订单数、客单价、高峰时段
- 每小时销售图表: 柱状图 / 折线图切换
- 销售来源分析: 支付方式占比
- 本周历史分析: Mon-Sun 周维度营业表现
- 今日订单页: 搜索、详情查看、Receipt 按需抓取
- 商品分析: 排行、趋势、集中度、菜单工程
- 每日日报: 自动生成 JSON + HTML 报告
- 摄像头页: 通过 `go2rtc` 接入实时视频流
- 桌面端 / 移动端双入口

## 项目结构

```text
PROSPERITY-XH-Dashboard/
├── web/                     # React + Vite 入口与模板
│   ├── index.html
│   ├── mobile.html
│   └── src/
├── app.js                   # 桌面端现有业务逻辑
├── mobile.js                # 移动端现有业务逻辑
├── style.css
├── mobile.css
├── view-switch.js
├── server.js                # Fastify 服务入口
├── scraper.js               # TapTouch 抓取逻辑
├── report-agent.js          # 每日日报生成
├── runtime-config.js
├── analytics-context.json
├── go2rtc.yaml              # 摄像头流配置示例
├── reports/                 # 已生成日报
├── __tests__/
├── Dockerfile
├── docker-compose.yml
├── docker-compose.hub.yml
├── docker-build-push.sh
├── start.sh
└── README.md
```

## 本地启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env.local
```

至少建议配置：

```bash
TAPTOUCH_EMAIL=your-email@example.com
TAPTOUCH_PASSWORD=your-password
```

如果本机 Chrome 路径无法自动识别，再补：

```bash
TAPTOUCH_BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

### 3. 构建前端

```bash
npm run build
```

### 4. 启动服务

```bash
npm start
```

或直接一键启动：

```bash
bash start.sh
```

默认地址：

- 桌面端: `http://localhost:3001`
- 移动端: `http://localhost:3001/mobile.html`

## 常用命令

```bash
# 前端构建
npm run build

# 启动服务
npm start

# 本地一键启动
bash start.sh

# 单独运行一次 TapTouch 抓取
npm run scrape

# 语法检查
npm run check

# 测试
npm test
```

## API 概览

本地服务默认运行在 `http://localhost:3001`。

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/status` | 服务健康状态 |
| `GET` | `/api/runtime` | 当前运行模式 |
| `GET` | `/api/healthz` | 健康检查 |
| `GET` | `/api/readyz` | 就绪检查 |
| `GET` | `/api/sales/hourly` | 今日每小时销售额与订单数 |
| `GET` | `/api/sales/summary` | 今日汇总 + 本周概览 |
| `GET` | `/api/orders/recent` | 今日订单列表 |
| `GET` | `/api/orders/by-date` | 指定日期订单 |
| `GET` | `/api/orders/detail/:key` | 单笔 Receipt 明细 |
| `GET` | `/api/products/report` | 商品报表 |
| `GET` | `/api/products/analysis` | 商品分析 |
| `GET` | `/api/reports/daily/latest` | 最新日报 |
| `POST` | `/api/reports/daily/generate` | 手动生成日报 |
| `GET` | `/api/scrape/status` | 当前同步进度 |
| `POST` | `/api/scrape/run` | 触发一次抓取 |

## 环境变量

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务端口 | `3001` |
| `TAPTOUCH_EMAIL` | TapTouch 登录邮箱 | 无 |
| `TAPTOUCH_PASSWORD` | TapTouch 登录密码 | 无 |
| `TAPTOUCH_BROWSER_EXECUTABLE` | Chrome/Chromium 路径 | 自动查找 |
| `TAPTOUCH_AUTO_SYNC` | 是否开启自动同步 | `true` |
| `TAPTOUCH_AUTO_FETCH_MS` | 自动刷新核心数据间隔 | `300000` |
| `TAPTOUCH_COOKIE_REFRESH_MS` | Cookie 刷新间隔 | `1800000` |
| `TAPTOUCH_DETAIL_CONCURRENCY` | 详情抓取并发数 | `4` |
| `TAPTOUCH_DETAIL_PREFETCH_WORKERS` | 后台详情 worker 数 | `2` |
| `TAPTOUCH_DETAIL_PRIME_COUNT` | 主同步后预热几笔订单详情 | `8` |
| `TAPTOUCH_PREFETCH_DETAILS` | 是否主同步时预抓全部详情 | `false` |
| `REPORT_AGENT_AUTO_GENERATE` | 是否自动生成日报 | `true` |
| `DEPLOY_TARGET` | 运行环境标识 | `local` |
| `DATA_DIR` | 运行数据目录 | `./data` |

## Docker

### 本地构建运行

```bash
docker compose up -d --build
```

### 使用 Docker Hub 镜像

```bash
docker compose -f docker-compose.hub.yml up -d
```

### 推送镜像

```bash
export DOCKER_USERNAME=your-dockerhub-username
export VERSION=latest
./docker-build-push.sh
```

当前镜像会：

- 安装运行依赖和前端构建依赖
- 在镜像内执行 `npm run build`
- 保留最终运行所需依赖

## 摄像头接入

项目保留了 `go2rtc.yaml` 作为配置示例，推荐把 `go2rtc` 作为独立进程或独立容器运行，不再把可执行二进制直接放在仓库里。

示例：

```bash
docker run -d --name go2rtc \
  -p 1984:1984 -p 8554:8554 -p 8555:8555 \
  -v /path/to/go2rtc.yaml:/config/go2rtc.yaml \
  alexxit/go2rtc:latest
```

## 测试

```bash
npm test
```

当前仓库内主要覆盖：

- server helper 纯函数
- Receipt 解析
- 日报生成基础逻辑

## 当前整理结果

本次已移除这些不再需要或不应该留在仓库中的文件：

- 旧的静态入口 `index.html` / `mobile.html`
- 旧 HTTP 承载层 `mini-express.js`
- 独立移动端说明 `MOBILE.md`
- 仓库内的 `go2rtc` 二进制
- 未被引用的历史样例报告与截图

现在仓库只保留当前运行链路和仍然有参考价值的配置、代码与日报文件。

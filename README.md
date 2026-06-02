# PROSPERITY XH Dashboard

墨尔本 `食集-重庆小面 / PROSPERITY XH` 的店内运营仪表板。  
项目会从 TapTouch Backoffice 抓取真实营业数据，在本地生成一个适合门店日常查看的 Dashboard。

## 现在已经支持什么

- 今日运营总览：销售额、订单数、客单价、高峰时段
- 每小时销售图表：柱状图 / 折线图切换
- 销售来源分析：支付方式占比
- 本周历史分析：按 Mon-Sun 展示每天销售额、订单量、最佳营业日
- 今日订单页：实时搜索、点击订单查看 Receipt 明细
- Receipt 按需抓取：主同步先快，订单详情在需要时再抓并缓存
- 摄像头实时画面：已接入 Xiaomi 云台版2K（通过 go2rtc `dining_room` 流）
- 主题模式：支持跟随系统 / 夜间 / 白天切换

## 项目结构

```text
restaurant-dashboard/
├── index.html
├── style.css
├── app.js
├── server.js
├── scraper.js
├── start.sh
├── go2rtc.yaml
├── package.json
├── .env.example
└── README.md
```

## 本地启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 TapTouch 账号（可选但推荐）

先复制一份本地环境变量文件：

```bash
cp .env.example .env.local
```

然后把 `.env.local` 里的示例账号和密码改成你自己的真实值：

```bash
TAPTOUCH_EMAIL=your-email@example.com
TAPTOUCH_PASSWORD=your-password
```

`.env.local` 已经被 `.gitignore` 忽略，不会被提交到 GitHub。

> 只想先把页面跑起来时，可以暂时不填账号密码；后端会启动，TapTouch 自动同步会自动跳过。

### 3. 一键启动

```bash
bash start.sh
```

启动脚本会：

- 读取 `.env` / `.env.local`
- 如果配置了 TapTouch 账号，会自动安装轻量爬虫依赖 `puppeteer-core`
- 启动一个本地 Node 服务 `http://localhost:3001`
- 自动打开浏览器

现在 Dashboard 本身不依赖 npm 包即可启动；爬虫改为使用 `puppeteer-core`，不会再在 `npm install` 时下载一整份 Chromium。爬虫会优先使用你机器上已有的 Chrome/Chromium；如果脚本找不到浏览器，在 `.env.local` 里指定即可：

```bash
TAPTOUCH_BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# 或 Linux: TAPTOUCH_BROWSER_EXECUTABLE=/usr/bin/chromium
```

## 常用命令

```bash
# 启动本地服务
npm start

# 单独运行一次 TapTouch 抓取
npm run scrape

# 检查 JS 语法
npm run check

# 一键启动（推荐日常使用）
bash start.sh
```

## 同步机制

### 更少服务器的推荐方式

日常只需要 **1 台常开的机器** 跑 Node：

- `server.js` 同时提供 Dashboard 页面、API、TapTouch 自动同步和按需 receipt 抓取
- 店内屏幕、iPad、安卓点餐机只需要打开 `http://这台机器IP:3001`，不需要在每台设备上安装 Node 或爬虫依赖
- 摄像头不是必须项；只有需要实时视频时才额外跑 `go2rtc`

### 主同步

点击右上角 `从 TapTouch 同步` 后，系统会先抓：

1. Dashboard KPI
2. 每小时销售图表
3. 本周 Dashboard 数据
4. 今日订单列表
5. 本周订单列表

这一阶段通常比旧版本更快，页面会先拿到核心营业数据。

### 订单详情

订单详情不再全量预抓。

- 主同步默认只预热最近几笔 receipt，其余订单详情按需加载
- 当你打开某一笔订单时，后端才会去 TapTouch 拉对应 Receipt
- 拉到后会写入本地缓存
- 同一笔订单下次再打开会更快

## Receipt 明细

TapTouch 的订单详情实际是 Receipt 页面，不是普通表格页。  
当前版本已经针对 Receipt 做了解析，能提取：

- 菜品名
- 数量
- 单价 / 小计
- 加料或备注
- GST
- surcharge
- payment method
- total paid

如果直接打开 receipt URL 失败，系统会自动回退到订单报表页里重新定位并进入该订单。

## API 概览

本地服务默认跑在 `http://localhost:3001`。

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/status` | 服务健康状态 |
| `GET` | `/api/sales/hourly` | 今日每小时销售额与订单数 |
| `GET` | `/api/sales/summary` | 今日汇总 + 本周概览 |
| `GET` | `/api/orders/recent` | 今日订单列表 |
| `GET` | `/api/orders/detail/:txId` | 单笔订单 Receipt 明细 |
| `GET` | `/api/orders/details` | 已缓存的订单详情 |
| `GET` | `/api/scrape/status` | 当前同步进度 |
| `POST` | `/api/scrape/run` | 触发一次同步 |

## 环境变量

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `PORT` | Dashboard 服务端口 | `3001` |
| `TAPTOUCH_EMAIL` | TapTouch 登录邮箱；未配置时自动同步会跳过 | 无 |
| `TAPTOUCH_PASSWORD` | TapTouch 登录密码；未配置时自动同步会跳过 | 无 |
| `TAPTOUCH_BROWSER_EXECUTABLE` | Chrome/Chromium 路径；脚本自动找不到浏览器时再填 | 自动查找 |
| `TAPTOUCH_AUTO_SYNC` | 是否开启后端定时自动同步 | `true` |
| `TAPTOUCH_AUTO_FETCH_MS` | 自动刷新核心数据间隔 | `300000` |
| `TAPTOUCH_COOKIE_REFRESH_MS` | TapTouch 登录 cookie 刷新间隔 | `1800000` |
| `TAPTOUCH_DETAIL_CONCURRENCY` | 全量详情预抓并发数 | `4` |
| `TAPTOUCH_DETAIL_PREFETCH_WORKERS` | 后端按需/后台 receipt 抓取 worker 数 | `2` |
| `TAPTOUCH_DETAIL_PRIME_COUNT` | 主同步后优先预热最近几笔 receipt | `8` |
| `TAPTOUCH_DETAIL_SAVE_EVERY` | 详情抓取中间保存频率 | `10` |
| `TAPTOUCH_PREFETCH_DETAILS` | 是否在主同步时预抓全部详情；服务器压力小建议保持 `false` | `false` |

## 摄像头接入（已实测）

当前 Dashboard 已接入一台 `Xiaomi 云台版2K`，流地址使用 go2rtc：

```text
http://localhost:1984/stream.html?src=dining_room
```

前端配置位置（[app.js](/Users/jinhua/Desktop/restaurant-dashboard/app.js)）：

- `CONFIG.cameras[3].go2rtcUrl = "http://localhost:1984/stream.html?src=dining_room"`
- `CONFIG.cameras[3].appOnly = false`

go2rtc 推荐运行方式（示例）：

```bash
docker run -d --name go2rtc \
  -p 1984:1984 -p 8554:8554 -p 8555:8555 \
  -v /path/to/go2rtc.yaml:/config/go2rtc.yaml \
  alexxit/go2rtc:latest
```

### Xiaomi 配置示例

```yaml
xiaomi:
  "your_mi_id": "V1:your-token"

streams:
  dining_room:
    - "xiaomi://your_mi_id:cn@192.168.88.137?did=YOUR_DID&model=chuangmi.camera.029a02&subtype=sd"
```

### 常见问题

- `invalid port ":cn" after host`  
  说明 URL 格式写错了（通常是 `xiaomi://...:cn` 的位置不对）。

- `read udp ... i/o timeout`  
  说明语法正确，但摄像头链路没回包。建议：
  1. 先在米家 App 打开实时画面“唤醒”设备
  2. 确认电脑、摄像头在同一局域网且关闭 AP 隔离
  3. 重启 go2rtc 容器并重试 `dining_room` 流

## 技术栈

- Frontend: HTML + Vanilla JavaScript + CSS
- Chart: Chart.js
- Backend: Node.js（内置轻量 HTTP 路由，无需 Express/CORS 依赖）
- Scraper: Puppeteer Core（复用系统 Chrome/Chromium，减少安装体积）
- Data Source: TapTouch Backoffice

## 框架建议

当前项目是轻量架构（Vanilla JS + Node 内置 HTTP 服务），对于单店运营看板是可用且维护成本低的方案。
现阶段不强制需要上 React/Vue 这类前端框架，除非你后续有这些需求：

- 多角色、多页面复杂权限
- 前端模块多人并行开发
- 复杂状态管理和组件复用
- 要做成 SaaS/多门店平台

换句话说：你现在这版先稳定跑起来是正确路线。

## 部署建议（生产）

最省事的部署方式是 **1 台后端 + 多个展示端**：

1. **后端常开机器**
   - 运行 `server.js`（Dashboard 页面 + API + TapTouch 同步都在这一个 Node 进程里）
   - 建议用 `pm2` 或系统服务守护进程
   - 定期备份 `scrape-result.json`

2. **展示端（店内屏幕/安卓设备/iPad）**
   - 只打开 Dashboard 页面
   - 不安装 Node、不跑 Puppeteer、不跑爬虫

3. **摄像头视频（可选）**
   - 不看摄像头时不用部署 `go2rtc`
   - 需要摄像头实时画面时，再在后端机器或同局域网另一台机器跑 `go2rtc`

### 建议组件

- 进程守护：`pm2`（保证 Node 服务崩溃后自动重启）
- 反向代理：`nginx`（如果需要域名、HTTPS、外网访问）
- 视频服务：`go2rtc`（仅摄像头需要）
- 日志与备份：按天轮转日志，定时备份 `scrape-result.json`

### 安卓点餐机是否可部署

可以作为**展示端**使用，不建议作为后端主机。  
原因是 Puppeteer 抓取与视频流转发在安卓设备上稳定性较差，容易影响点餐机本身业务。

推荐方式：

- 后端跑在店内常开主机/NAS/云服务器
- 安卓点餐机开启 kiosk 模式，仅访问 Dashboard URL

## 注意事项

- 这个项目默认是本地自用，不是多租户 SaaS
- `scrape-result.json`、`server.log`、`debug-*` 都不会提交到仓库
- 如果同步失败，先检查 `.env.local`、TapTouch 登录状态和网络
- 如果 3001 端口被占用，可以设置 `PORT=3002` 后再启动，或先运行 `pkill -f 'node server.js'`

## 下一步可继续做

- 增加按时间范围的历史报表
- 增加商品维度、来源维度、时段维度的更细分析
- 给订单详情增加“已缓存 / 加载中”状态提示
- 增加多路摄像头自动健康检查与断流重连提示
- 增加部署脚本（PM2 + Nginx + Docker Compose）

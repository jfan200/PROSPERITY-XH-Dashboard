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
- 摄像头位占位：支持后续接入 Xiaomi / Dahua/DMSS + go2rtc

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
cd /Users/jinhua/Desktop/restaurant-dashboard
npm install
```

### 2. 配置 TapTouch 账号

先复制一份本地环境变量文件：

```bash
cp .env.example .env.local
```

然后把 `.env.local` 里的账号和密码改成你自己的：

```bash
TAPTOUCH_EMAIL=your-email@example.com
TAPTOUCH_PASSWORD=your-password
```

`.env.local` 已经被 `.gitignore` 忽略，不会被提交到 GitHub。

### 3. 一键启动

```bash
bash start.sh
```

启动后会：

- 检查依赖
- 读取 `.env.local`
- 启动本地服务 `http://localhost:3001`
- 自动打开浏览器

## 常用命令

```bash
# 启动本地服务
npm start

# 单独运行一次 TapTouch 抓取
npm run scrape

# 一键启动（推荐日常使用）
bash start.sh
```

## 同步机制

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
| `TAPTOUCH_EMAIL` | TapTouch 登录邮箱 | 无 |
| `TAPTOUCH_PASSWORD` | TapTouch 登录密码 | 无 |
| `TAPTOUCH_DETAIL_CONCURRENCY` | 详情并发数 | `4` |
| `TAPTOUCH_DETAIL_SAVE_EVERY` | 详情抓取中间保存频率 | `10` |
| `TAPTOUCH_PREFETCH_DETAILS` | 是否在主同步时预抓全部详情 | `false` |

## 摄像头接入

当前页面已经预留摄像头区域。  
如果后续要接入真实监控流，推荐配合 [go2rtc](https://github.com/AlexxIT/go2rtc) 使用。

`go2rtc.yaml` 已经放在项目里作为配置起点，你可以按自己的 RTSP 地址继续补全。

## 技术栈

- Frontend: HTML + Vanilla JavaScript + CSS
- Chart: Chart.js
- Backend: Node.js + Express
- Scraper: Puppeteer
- Data Source: TapTouch Backoffice

## 注意事项

- 这个项目默认是本地自用，不是多租户 SaaS
- `scrape-result.json`、`server.log`、`debug-*` 都不会提交到仓库
- 如果同步失败，先检查 `.env.local`、TapTouch 登录状态和网络
- 如果 3001 端口被占用，可以先运行 `pkill -f 'node server.js'`

## 下一步可继续做

- 把账号配置改成更标准的 `.env` + `dotenv`
- 增加按时间范围的历史报表
- 增加商品维度、来源维度、时段维度的更细分析
- 给订单详情增加“已缓存 / 加载中”状态提示
- 给摄像头页接入真实视频流

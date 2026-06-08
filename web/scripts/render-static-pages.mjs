import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..');
const templatesRoot = path.resolve(webRoot, 'src', 'templates');

function readTemplate(name) {
  return fs.readFileSync(path.resolve(templatesRoot, name), 'utf8').trim();
}

function writePage(name, html) {
  fs.writeFileSync(path.resolve(webRoot, name), `${html}\n`);
}

function renderDesktopPage(body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>餐厅运营中心 | Melbourne Restaurant Dashboard</title>
  <meta name="description" content="墨尔本餐厅实时运营仪表板 — 销售数据、摄像头监控一站式查看" />
  <script src="/view-switch.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <link rel="stylesheet" href="/style.css?v=20260603" />
</head>
<body>
${body}
  <script src="/app.js?v=20260603" defer></script>
</body>
</html>`;
}

function renderMobilePage(body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>PROSPERITY XH Mobile Dashboard</title>
  <meta name="description" content="PROSPERITY XH 移动端运营看板" />
  <script src="/view-switch.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <link rel="stylesheet" href="/mobile.css" />
</head>
<body>
${body}
  <script src="/mobile.js" defer></script>
</body>
</html>`;
}

writePage('index.html', renderDesktopPage(readTemplate('desktop-shell.html')));
writePage('mobile.html', renderMobilePage(readTemplate('mobile-shell.html')));

console.log('[render-static-pages] Generated web/index.html and web/mobile.html');

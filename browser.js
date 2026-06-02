'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

const MACOS_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_CHROME_COMMANDS = [
  'google-chrome-stable',
  'google-chrome',
  'chromium-browser',
  'chromium',
  'microsoft-edge',
];

function commandExists(command) {
  const result = spawnSync('command', ['-v', command], {
    shell: true,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function findBrowserExecutable() {
  if (process.env.TAPTOUCH_BROWSER_EXECUTABLE) {
    return process.env.TAPTOUCH_BROWSER_EXECUTABLE;
  }

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  for (const browserPath of MACOS_CHROME_PATHS) {
    if (fs.existsSync(browserPath)) return browserPath;
  }

  for (const command of LINUX_CHROME_COMMANDS) {
    if (commandExists(command)) return command;
  }

  return null;
}

async function launchBrowser(options = {}) {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error([
      '找不到可用的 Chrome/Chromium。',
      '请安装 Google Chrome，或在 .env.local 中设置 TAPTOUCH_BROWSER_EXECUTABLE=/path/to/chrome。',
      'Linux 服务器可安装 chromium/google-chrome；Mac 通常直接安装 Chrome 即可。',
    ].join(' '));
  }

  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({
    headless: 'new',
    executablePath,
    args: DEFAULT_ARGS,
    ...options,
    args: [...DEFAULT_ARGS, ...(options.args || [])],
  });
}

module.exports = {
  findBrowserExecutable,
  launchBrowser,
};

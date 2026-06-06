'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = __dirname;
const DEPLOY_TARGET = String(
  process.env.DEPLOY_TARGET
  || process.env.RUNTIME_TARGET
  || (process.env.VERCEL ? 'serverless' : 'local')
).trim().toLowerCase();

const isServerless = DEPLOY_TARGET === 'serverless';
const isDocker = DEPLOY_TARGET === 'docker';
const isLocal = !isServerless && !isDocker;

const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(APP_ROOT, 'data')
);
const DEBUG_DIR = path.resolve(
  process.env.DEBUG_DIR || path.join(DATA_DIR, 'debug')
);
const LEGACY_SCRAPE_RESULT_PATH = path.resolve(
  process.env.LEGACY_SCRAPE_RESULT_PATH || path.join(APP_ROOT, 'scrape-result.json')
);
const SCRAPE_RESULT_PATH = path.resolve(
  process.env.SCRAPE_RESULT_PATH || path.join(DATA_DIR, 'scrape-result.json')
);
const SERVER_LOG_PATH = path.resolve(
  process.env.SERVER_LOG_PATH || path.join(DATA_DIR, 'server.log')
);
const REPORTS_DIR = path.resolve(
  process.env.REPORTS_DIR || path.join(APP_ROOT, 'reports')
);

const ENABLE_BACKGROUND_JOBS = /^(1|true|yes)$/i.test(
  process.env.ENABLE_BACKGROUND_JOBS || (isServerless ? 'false' : 'true')
);
const ENABLE_FILE_WATCH = /^(1|true|yes)$/i.test(
  process.env.ENABLE_FILE_WATCH || (isServerless ? 'false' : 'true')
);
const ENABLE_SCRAPER_API = /^(1|true|yes)$/i.test(
  process.env.ENABLE_SCRAPER_API || (isServerless ? 'false' : 'true')
);
const SCRAPER_EXECUTION_MODE = String(
  process.env.TAPTOUCH_SCRAPER_MODE || 'child'
).trim().toLowerCase();

function ensureRuntimeDirectories() {
  for (const dir of [DATA_DIR, DEBUG_DIR, REPORTS_DIR, path.join(REPORTS_DIR, 'daily')]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

module.exports = {
  APP_ROOT,
  DATA_DIR,
  DEBUG_DIR,
  LEGACY_SCRAPE_RESULT_PATH,
  SCRAPE_RESULT_PATH,
  SERVER_LOG_PATH,
  REPORTS_DIR,
  DEPLOY_TARGET,
  SCRAPER_EXECUTION_MODE,
  isServerless,
  isDocker,
  isLocal,
  ENABLE_BACKGROUND_JOBS,
  ENABLE_FILE_WATCH,
  ENABLE_SCRAPER_API,
  ensureRuntimeDirectories,
};

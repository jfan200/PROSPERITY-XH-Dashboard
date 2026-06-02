'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
};

function enhanceResponse(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };

  res.json = function json(payload) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(payload));
  };

  res.send = function send(payload) {
    if (Buffer.isBuffer(payload)) return res.end(payload);
    if (typeof payload === 'object' && payload !== null) return res.json(payload);
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
    res.end(String(payload ?? ''));
  };

  res.sendStatus = function sendStatus(code) {
    res.statusCode = code;
    res.end(http.STATUS_CODES[code] || String(code));
  };

  return res;
}

function compileRoute(routePath) {
  const keys = [];
  const pattern = routePath
    .split('/')
    .map(part => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { keys, regex: new RegExp(`^${pattern}$`) };
}

function createApp() {
  const middlewares = [];
  const routes = [];

  function app(req, res) {
    enhanceResponse(res);
    const parsedUrl = new URL(req.url, 'http://localhost');
    req.path = parsedUrl.pathname;
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    req.params = {};

    const stack = [
      ...middlewares,
      (request, response) => {
        const route = routes.find(candidate => {
          if (candidate.method !== request.method) return false;
          const match = request.path.match(candidate.regex);
          if (!match) return false;
          request.params = Object.fromEntries(candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
          return true;
        });

        if (!route) return response.sendStatus(404);
        return route.handler(request, response);
      },
    ];

    let index = 0;
    const next = error => {
      if (error) {
        res.statusCode = 500;
        return res.end(error.message || 'Internal Server Error');
      }
      const layer = stack[index++];
      if (!layer) return undefined;
      return layer(req, res, next);
    };

    next();
  }

  app.use = middleware => middlewares.push(middleware);
  app.get = (routePath, handler) => {
    routes.push({ method: 'GET', handler, ...compileRoute(routePath) });
  };
  app.post = (routePath, handler) => {
    routes.push({ method: 'POST', handler, ...compileRoute(routePath) });
  };
  app.listen = (port, callback) => http.createServer(app).listen(port, callback);

  return app;
}

createApp.json = function json() {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) {
        req.body = {};
        return next();
      }
      try {
        req.body = JSON.parse(body);
        return next();
      } catch (error) {
        res.status(400).json({ error: 'Invalid JSON body' });
      }
    });
  };
};

createApp.static = function serveStatic(rootDir) {
  const safeRoot = path.resolve(rootDir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const decodedPath = decodeURIComponent(req.path);
    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    const filePath = path.resolve(safeRoot, relativePath);

    if (!filePath.startsWith(safeRoot + path.sep) && filePath !== safeRoot) return res.sendStatus(403);
    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) return next();
      res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath).pipe(res);
    });
  };
};

module.exports = createApp;

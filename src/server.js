'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { seed } = require('./seed');
const budget = require('./budget');
const H = require('./handlers');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const db = openDb();
seed(db);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  // 防目录穿越
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 前端单页：未知非接口路径回退到首页
      if (!p.startsWith('/api/')) return serveStatic({ url: '/index.html' }, res);
      res.writeHead(404); res.end('Not Found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '方法不允许' } });
    return;
  }

  try {
    let body = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) body = await H.readBody(req);

    // R3F4: 预算总览（最新版本 + 作品已用/预占/余额 + 时段及核算结果）
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, budget.summarize(db));
    }

    // 作品
    if (req.method === 'POST' && pathname === '/api/artworks') {
      return sendJson(res, 200, H.createArtwork(db, body));
    }
    const mArt = pathname.match(/^\/api\/artworks\/(\d+)$/);
    if (mArt) {
      const id = H.parseId(mArt[1]);
      if (req.method === 'PUT') return sendJson(res, 200, H.updateArtwork(db, id, body));
      if (req.method === 'DELETE') return sendJson(res, 200, H.deleteArtwork(db, id, body));
    }

    // 排期：整批调整（替换全部未开始时段）
    if (req.method === 'POST' && pathname === '/api/schedule') {
      return sendJson(res, 200, H.replaceSchedule(db, body));
    }

    // 时段生命周期
    const mSlot = pathname.match(/^\/api\/slots\/(\d+)\/(start|finish|settle|correct)$/);
    if (mSlot && req.method === 'POST') {
      const id = H.parseId(mSlot[1]);
      if (mSlot[2] === 'start') return sendJson(res, 200, H.startSlot(db, id));
      if (mSlot[2] === 'finish') return sendJson(res, 200, H.finishSlot(db, id, body || {}));
      if (mSlot[2] === 'settle') return sendJson(res, 200, H.settleSlot(db, id, body || {}));
      return sendJson(res, 200, H.correctSlot(db, id, body || {}));
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  } catch (err) {
    if (err instanceof H.HttpError) {
      const payload = { error: { code: err.code, message: err.message } };
      if (err.state) payload.state = err.state;
      if (err.errors) payload.errors = err.errors;
      if (err.conflicts) payload.conflicts = err.conflicts;
      if (err.budgetExceeded) payload.budgetExceeded = err.budgetExceeded;
      if (err.blockedReason) payload.blockedReason = err.blockedReason;
      return sendJson(res, err.status, payload);
    }
    console.error('[server]', err);
    sendJson(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`光照预算工作台已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${require('./db').DB_PATH}`);
});

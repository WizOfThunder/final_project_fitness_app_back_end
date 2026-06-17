const express = require('express');
const cors = require('cors');
const path = require('path');
const routes = require('./routes');

const app = express();

const idempotencyCache = new Map();
const IDEMPOTENCY_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL) {
      idempotencyCache.delete(key);
    }
  }
}, 60 * 1000);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  const cached = idempotencyCache.get(key);
  if (cached) {
    return res.status(cached.status).json(cached.body);
  }

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      idempotencyCache.set(key, {status: res.statusCode, body, createdAt: Date.now()});
    }
    return originalJson(body);
  };
  next();
});

app.use('/api/v1', routes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

module.exports = app;

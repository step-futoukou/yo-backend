const express = require('express');
const cors = require('cors');

const { router: usersRouter } = require('./routes/users');
const { router: matchingRouter } = require('./routes/matching');
const { router: meetingsRouter } = require('./routes/meetings');
const { router: notificationsRouter } = require('./routes/notifications');
const { router: reviewsRouter } = require('./routes/reviews');

const app = express();

// ミドルウェア
app.use(cors());
app.use(express.json());

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({ name: 'Yo backend', status: 'ok' });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ルーティング
app.use('/api/users', usersRouter);
app.use('/api/matching', matchingRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/reviews', reviewsRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.originalUrl });
});

// エラーハンドラ
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

module.exports = app;

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

const router = express.Router();

// 通知種別
const TYPES = [
  'match_found', 'wish_received', 'proposal_ready',
  'confirmation', 'reminder', 'review_request',
];

// review_request をスケジュールするまでの遅延（既定60分）。
// テスト用に環境変数で短縮できる。
const REVIEW_DELAY_MS = Number(process.env.REVIEW_DELAY_MS) || 60 * 60 * 1000;

function safeParse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return json; }
}

/**
 * 通知をキューに1件追加する（他ルートから呼ばれる共通ヘルパ）。
 * @returns 追加した通知ID（user_id が無ければ null）
 */
function enqueue(userId, type, payload = {}) {
  if (!userId) return null;
  const id = uuidv4();
  db.prepare(
    'INSERT INTO notifications (id, user_id, type, payload) VALUES (?, ?, ?, ?)'
  ).run(id, userId, type, JSON.stringify(payload ?? {}));
  return id;
}

/**
 * 複数ユーザーへ同じ通知を追加するヘルパ。
 */
function enqueueMany(userIds, type, payload = {}) {
  return userIds.filter(Boolean).map((uid) => enqueue(uid, type, payload));
}

/**
 * 指定ユーザー宛ての 'review_request' を REVIEW_DELAY_MS 後にキューへ追加する。
 * setTimeout はプロセスの終了を妨げないよう unref する。
 */
function scheduleReviewRequest(userIds, payload = {}) {
  const targets = userIds.filter(Boolean);
  const timer = setTimeout(() => {
    try {
      for (const uid of targets) enqueue(uid, 'review_request', payload);
      console.log(`[notifications] scheduled review_request enqueued for ${targets.length} user(s)`);
    } catch (err) {
      console.error('[notifications] failed to enqueue scheduled review_request', err);
    }
  }, REVIEW_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * GET /api/notifications/:user_id
 * 未送信通知を返し、返した通知を is_sent = 1 に更新する。
 */
router.get('/:user_id', (req, res) => {
  const userId = req.params.user_id;

  const deliver = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM notifications
        WHERE user_id = ? AND is_sent = 0
        ORDER BY created_at ASC, rowid ASC
    `).all(userId);

    if (rows.length > 0) {
      const mark = db.prepare('UPDATE notifications SET is_sent = 1 WHERE id = ?');
      for (const r of rows) mark.run(r.id);
    }
    return rows;
  });

  const rows = deliver();
  res.json(rows.map((r) => ({ ...r, payload: safeParse(r.payload) })));
});

/**
 * POST /api/notifications/reminder
 * 再通知（リマインダー）をキューに追加する。
 * body: { match_id, user_id }
 */
router.post('/reminder', (req, res) => {
  const { match_id, user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const id = enqueue(user_id, 'reminder', { match_id: match_id ?? null });
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  res.status(201).json({ ...row, payload: safeParse(row.payload) });
});

module.exports = { router, enqueue, enqueueMany, scheduleReviewRequest, TYPES };

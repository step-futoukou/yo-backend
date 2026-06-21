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
 * 指定ユーザー宛ての 'review_request' を即座にDBへ保存する。
 * scheduled_at に「現在時刻 + REVIEW_DELAY_MS」を設定し、配信予定とする。
 * （setTimeout に依存しないためサーバー再起動でも失われない）
 * @returns 追加した通知IDの配列
 */
function enqueueReviewRequest(userIds, payload = {}) {
  const targets = userIds.filter(Boolean);
  const delaySeconds = Math.max(0, Math.round(REVIEW_DELAY_MS / 1000));
  const modifier = `+${delaySeconds} seconds`;
  const stmt = db.prepare(`
    INSERT INTO notifications (id, user_id, type, payload, scheduled_at)
    VALUES (?, ?, 'review_request', ?, datetime('now', ?))
  `);
  const ids = [];
  db.transaction(() => {
    for (const uid of targets) {
      const id = uuidv4();
      stmt.run(id, uid, JSON.stringify(payload ?? {}), modifier);
      ids.push(id);
    }
  })();
  return ids;
}

/**
 * 未送信かつ scheduled_at が過去（配信時刻を過ぎた）review_request を
 * 送信済み（is_sent = 1）にするスイープ処理。
 * @returns 送信済みにした件数
 */
function sweepReviewRequests() {
  const res = db.prepare(`
    UPDATE notifications
      SET is_sent = 1
      WHERE type = 'review_request'
        AND is_sent = 0
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= datetime('now')
  `).run();
  if (res.changes > 0) {
    console.log(`[notifications] swept ${res.changes} due review_request(s)`);
  }
  return res.changes;
}

/**
 * 起動時に1回スイープし、その後 1分ごとに繰り返す。
 * interval はプロセス終了を妨げないよう unref する。
 */
function startSweep() {
  sweepReviewRequests();
  const interval = setInterval(sweepReviewRequests, 60 * 1000);
  if (typeof interval.unref === 'function') interval.unref();
  return interval;
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
          AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
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

module.exports = {
  router,
  enqueue,
  enqueueMany,
  enqueueReviewRequest,
  sweepReviewRequests,
  startSweep,
  TYPES,
};

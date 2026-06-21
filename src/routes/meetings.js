const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

const router = express.Router();

// 通報が一定数を超えたらブラックリスト入りにする閾値
const BLACKLIST_THRESHOLD = 3;

/**
 * POST /api/meetings
 * 待ち合わせを作成。match が accepted であることが前提。
 * body: { match_id, scheduled_time, place }
 */
router.post('/', (req, res) => {
  const { match_id, scheduled_time, place } = req.body || {};
  if (!match_id) return res.status(400).json({ error: 'match_id is required' });

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: 'match not found' });
  if (match.status !== 'accepted') {
    return res.status(400).json({ error: 'match is not accepted yet' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO meetings (id, match_id, scheduled_time, place)
    VALUES (?, ?, ?, ?)
  `).run(id, match_id, scheduled_time ?? null, place ?? null);

  res.status(201).json(db.prepare('SELECT * FROM meetings WHERE id = ?').get(id));
});

/**
 * POST /api/meetings/:id/confirm
 * 待ち合わせを確定（どちらのユーザーが確定したか side で指定）。
 * body: { side: 'a' | 'b' }
 * 両者が確定したら待ち合わせ成立。
 */
router.post('/:id/confirm', (req, res) => {
  const { side } = req.body || {};
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });

  if (side === 'a') {
    db.prepare('UPDATE meetings SET confirmed_a = 1 WHERE id = ?').run(meeting.id);
  } else if (side === 'b') {
    db.prepare('UPDATE meetings SET confirmed_b = 1 WHERE id = ?').run(meeting.id);
  } else {
    return res.status(400).json({ error: "side must be 'a' or 'b'" });
  }

  const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
  res.json({
    ...updated,
    both_confirmed: updated.confirmed_a === 1 && updated.confirmed_b === 1,
  });
});

/**
 * GET /api/meetings/match/:matchId
 * マッチに紐づく待ち合わせ一覧。
 */
router.get('/match/:matchId', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM meetings WHERE match_id = ? ORDER BY created_at DESC'
  ).all(req.params.matchId);
  res.json(rows);
});

/**
 * GET /api/meetings/:id
 * 待ち合わせ1件取得。
 */
router.get('/:id', (req, res) => {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });
  res.json(meeting);
});

// ============================================================
// 通報 / ブラックリスト（待ち合わせのトラブル対応）
// ============================================================

/**
 * POST /api/meetings/report
 * ユーザーを通報する。通報数が閾値を超えたら自動でブラックリスト入り。
 * body: { reporter_id, reported_id, category, note }
 */
router.post('/report', (req, res) => {
  const { reporter_id, reported_id, category, note } = req.body || {};
  if (!reporter_id || !reported_id) {
    return res.status(400).json({ error: 'reporter_id and reported_id are required' });
  }
  const validCategories = ['cancel', 'sexual', 'harassment', 'other'];
  const cat = validCategories.includes(category) ? category : 'other';

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO reports (reporter_id, reported_id, category, note)
      VALUES (?, ?, ?, ?)
    `).run(reporter_id, reported_id, cat, note ?? null);

    const count = db.prepare(
      'SELECT COUNT(*) AS c FROM reports WHERE reported_id = ?'
    ).get(reported_id).c;

    let blacklisted = false;
    if (count >= BLACKLIST_THRESHOLD) {
      db.prepare(`
        INSERT INTO blacklist (user_id, report_count)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET report_count = excluded.report_count
      `).run(reported_id, count);
      blacklisted = true;
    }
    return { count, blacklisted };
  });

  const result = tx();
  res.status(201).json({
    message: 'report submitted',
    report_count: result.count,
    blacklisted: result.blacklisted,
  });
});

/**
 * GET /api/meetings/blacklist/:userId
 * ユーザーがブラックリスト入りしているか確認。
 */
router.get('/blacklist/:userId', (req, res) => {
  const row = db.prepare('SELECT * FROM blacklist WHERE user_id = ?').get(req.params.userId);
  res.json({ blacklisted: !!row, detail: row || null });
});

module.exports = { router };

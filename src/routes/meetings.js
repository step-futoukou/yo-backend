const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { enqueueMany, enqueueReviewRequest } = require('./notifications');

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
  const bothConfirmed = updated.confirmed_a === 1 && updated.confirmed_b === 1;
  // 直前は未成立で、今回の確認で初めて両者成立した場合のみ通知（重複防止）
  const wasBothConfirmed = meeting.confirmed_a === 1 && meeting.confirmed_b === 1;

  if (bothConfirmed && !wasBothConfirmed) {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(updated.match_id);
    if (match) {
      const both = [match.user_a_id, match.user_b_id];
      const payload = { match_id: match.id, meeting_id: updated.id };
      // 両者へ 'confirmation' 通知
      enqueueMany(both, 'confirmation', payload);
      // 60分後に両者へ 'review_request'（即DB保存・scheduled_at付き）
      enqueueReviewRequest(both, payload);
    }
  }

  res.json({
    ...updated,
    both_confirmed: bothConfirmed,
  });
});

/**
 * POST /api/meetings/:id/confirm と同様に、当日の「到着」を記録する。
 * body: { side: 'a' | 'b' }。両者到着で both_arrived。
 */
router.post('/:id/arrive', (req, res) => {
  const { side } = req.body || {};
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });

  if (side === 'a') {
    db.prepare('UPDATE meetings SET arrived_a = 1 WHERE id = ?').run(meeting.id);
  } else if (side === 'b') {
    db.prepare('UPDATE meetings SET arrived_b = 1 WHERE id = ?').run(meeting.id);
  } else {
    return res.status(400).json({ error: "side must be 'a' or 'b'" });
  }

  const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
  res.json({
    ...updated,
    both_arrived: updated.arrived_a === 1 && updated.arrived_b === 1,
  });
});

// ============================================================
// 待ち合わせ希望の重複検出
// ============================================================

// 2つの配列の「最初の重複要素」を返す（A の並び順を優先）。なければ null。
function firstOverlap(arrA, arrB) {
  const setB = new Set((Array.isArray(arrB) ? arrB : []).map((x) => String(x)));
  for (const x of (Array.isArray(arrA) ? arrA : [])) {
    if (setB.has(String(x))) return x;
  }
  return null;
}

// match に紐づく待ち合わせを取得（最新1件）。無ければ新規作成して返す。
function findOrCreateMeeting(matchId) {
  const existing = db.prepare(
    'SELECT * FROM meetings WHERE match_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(matchId);
  if (existing) return existing;

  const id = uuidv4();
  db.prepare('INSERT INTO meetings (id, match_id) VALUES (?, ?)').run(id, matchId);
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

/**
 * POST /api/meetings/wishes
 * ユーザーの希望（時間・場所）を登録する。
 * 両者の希望が揃ったら自動で重複を検出し、proposed_time / proposed_place を設定。
 * 重複が一切なければ status = 'no_match'。
 * body: { match_id, user_id, time_slots: [], places: [] }
 */
router.post('/wishes', (req, res) => {
  const { match_id, user_id, time_slots, places } = req.body || {};
  if (!match_id || !user_id) {
    return res.status(400).json({ error: 'match_id and user_id are required' });
  }

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) return res.status(404).json({ error: 'match not found' });

  // user_id がマッチのどちら側かを判定
  let side;
  if (user_id === match.user_a_id) side = 'a';
  else if (user_id === match.user_b_id) side = 'b';
  else return res.status(400).json({ error: 'user_id is not part of this match' });

  const wish = {
    time_slots: Array.isArray(time_slots) ? time_slots : [],
    places: Array.isArray(places) ? places : [],
  };

  const meeting = findOrCreateMeeting(match_id);

  const result = db.transaction(() => {
    // 自分側の希望を保存
    const col = side === 'a' ? 'wishes_a' : 'wishes_b';
    db.prepare(`UPDATE meetings SET ${col} = ? WHERE id = ?`)
      .run(JSON.stringify(wish), meeting.id);

    const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);

    // 両者が揃っていなければ waiting のまま
    if (!m.wishes_a || !m.wishes_b) {
      return { ...m, both_submitted: false };
    }

    // 重複検出
    const wa = JSON.parse(m.wishes_a);
    const wb = JSON.parse(m.wishes_b);
    const proposedTime = firstOverlap(wa.time_slots, wb.time_slots);
    const proposedPlace = firstOverlap(wa.places, wb.places);

    if (proposedTime === null && proposedPlace === null) {
      db.prepare("UPDATE meetings SET status = 'no_match' WHERE id = ?").run(m.id);
    } else {
      db.prepare(`
        UPDATE meetings
          SET proposed_time = ?, proposed_place = ?, status = 'proposed'
          WHERE id = ?
      `).run(proposedTime, proposedPlace, m.id);
    }

    return {
      ...db.prepare('SELECT * FROM meetings WHERE id = ?').get(m.id),
      both_submitted: true,
    };
  })();

  // 今回の提出で初めて両者が揃った場合のみ、両者へ 'proposal_ready' 通知
  const wasBothSubmitted = !!meeting.wishes_a && !!meeting.wishes_b;
  if (result.both_submitted && !wasBothSubmitted) {
    enqueueMany([match.user_a_id, match.user_b_id], 'proposal_ready', {
      match_id,
      meeting_id: result.id,
      status: result.status,
      proposed_time: result.proposed_time,
      proposed_place: result.proposed_place,
    });
  }

  res.status(201).json(result);
});

/**
 * GET /api/meetings/:match_id/proposal
 * 自動提案された時間・場所を返す。両者未回答なら waiting。
 */
router.get('/:match_id/proposal', (req, res) => {
  const meeting = db.prepare(
    'SELECT * FROM meetings WHERE match_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.match_id);

  // 待ち合わせ未作成、または両者の希望が揃っていない → waiting
  if (!meeting || !meeting.wishes_a || !meeting.wishes_b) {
    return res.json({
      status: 'waiting',
      match_id: req.params.match_id,
      proposed_time: null,
      proposed_place: null,
      waiting_for: meeting
        ? [!meeting.wishes_a ? 'a' : null, !meeting.wishes_b ? 'b' : null].filter(Boolean)
        : ['a', 'b'],
    });
  }

  res.json({
    status: meeting.status, // 'proposed' or 'no_match'
    match_id: req.params.match_id,
    meeting_id: meeting.id,
    proposed_time: meeting.proposed_time,
    proposed_place: meeting.proposed_place,
  });
});

/**
 * GET /api/meetings/:match_id/status
 * 画面復元用に、マッチ＋待ち合わせの進行状態をまとめて返す。
 * フロントの resolver がこの状態から「今いるべき画面」を決める。
 */
router.get('/:match_id/status', (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.match_id);
  if (!match) return res.status(404).json({ error: 'match not found' });

  const meeting = db.prepare(
    'SELECT * FROM meetings WHERE match_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.params.match_id);

  res.json({
    match: {
      id: match.id,
      user_a_id: match.user_a_id,
      user_b_id: match.user_b_id,
      status: match.status,
    },
    meeting: meeting ? {
      id: meeting.id,
      // 希望は内容ではなく「送信済みか」だけ返す
      wishes_a: !!meeting.wishes_a,
      wishes_b: !!meeting.wishes_b,
      status: meeting.status,                 // 'waiting' / 'proposed' / 'no_match'
      proposed_time: meeting.proposed_time,
      proposed_place: meeting.proposed_place,
      confirmed_a: meeting.confirmed_a,
      confirmed_b: meeting.confirmed_b,
      arrived_a: meeting.arrived_a,
      arrived_b: meeting.arrived_b,
    } : null,
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

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { getUserWithTags } = require('./users');
const { enqueue } = require('./notifications');

const router = express.Router();

// --- MBTIの各軸スコア（仕様書のしきい値） ---------------------

// E/I, T/F, J/P 共通の「差が少ないほど高得点」だが配点が異なるため
// しきい値テーブルを軸ごとに渡す。
function bandScore(diff, bands) {
  // bands: [[上限%, 得点], ...] を昇順で。最後はフォールバック。
  for (const [limit, pts] of bands) {
    if (diff <= limit) return pts;
  }
  return bands[bands.length - 1][1];
}

function scoreEI(a, b) {
  const diff = Math.abs((a.mbti_ei ?? 50) - (b.mbti_ei ?? 50));
  return bandScore(diff, [[15, 10], [30, 7], [50, 3], [Infinity, 1]]);
}

function scoreTF(a, b) {
  const diff = Math.abs((a.mbti_tf ?? 50) - (b.mbti_tf ?? 50));
  return bandScore(diff, [[15, 10], [30, 7], [50, 5], [Infinity, 3]]);
}

function scoreJP(a, b) {
  const diff = Math.abs((a.mbti_jp ?? 50) - (b.mbti_jp ?? 50));
  return bandScore(diff, [[15, 10], [30, 7], [50, 3], [Infinity, 1]]);
}

function scoreNS(a, b) {
  const av = a.mbti_ns ?? 50;
  const bv = b.mbti_ns ?? 50;
  // 同じ側 = 両者とも <50（N寄り） または 両者とも >=50（S寄り）
  const sameSide = (av < 50) === (bv < 50);
  if (!sameSide) return 2; // 異なる側（N+S）
  const diff = Math.abs(av - bv);
  return bandScore(diff, [[15, 10], [30, 7], [Infinity, 5]]);
}

// --- 趣味×興味スコア -----------------------------------------

// 共通タグ（名前一致）について type の組み合わせで配点。
//   hobby × hobby       → 10
//   hobby × interest    →  7
//   interest × interest →  5
//   一致0件             →  3（固定）
//   合計は上限40点
function comboPoints(typeA, typeB) {
  if (typeA === 'hobby' && typeB === 'hobby') return 10;
  if (typeA === 'interest' && typeB === 'interest') return 5;
  return 7; // hobby × interest（順不同）
}

function tagScore(a, b) {
  // 名前 -> その人が持つ type の集合
  const mapA = new Map();
  for (const t of a.tags || []) {
    if (!t || !t.name) continue;
    if (!mapA.has(t.name)) mapA.set(t.name, new Set());
    mapA.get(t.name).add(t.type);
  }
  const mapB = new Map();
  for (const t of b.tags || []) {
    if (!t || !t.name) continue;
    if (!mapB.has(t.name)) mapB.set(t.name, new Set());
    mapB.get(t.name).add(t.type);
  }

  let total = 0;
  let matched = 0;
  for (const [name, typesA] of mapA) {
    if (!mapB.has(name)) continue;
    const typesB = mapB.get(name);
    // 同名タグの type 組み合わせのうち最も高い配点を採用
    let best = 0;
    for (const ta of typesA) {
      for (const tb of typesB) {
        best = Math.max(best, comboPoints(ta, tb));
      }
    }
    total += best;
    matched += 1;
  }

  if (matched === 0) return 3; // 一致0件は3点固定
  return Math.min(total, 40);  // 上限40点
}

// --- 求める関係値の近さ --------------------------------------

// 差0→20, 差1→14, 差2→6, 差3以上→null（マッチ対象外）
function relationScore(a, b) {
  const av = a.relation_value ?? 2;
  const bv = b.relation_value ?? 2;
  const diff = Math.abs(av - bv);
  if (diff === 0) return 20;
  if (diff === 1) return 14;
  if (diff === 2) return 6;
  return null; // 差3以上はマッチングしない
}

/**
 * 2ユーザー間の相性スコアを 0〜100 で算出する。
 * 関係値の差が3以上のペアはマッチング対象外として null を返す。
 * 内訳:
 *  - MBTI       : 40点（E/I・N/S・T/F・J/P 各10点）
 *  - 趣味×興味  : 40点（上限）
 *  - 関係値の近さ: 20点
 */
function calcScore(a, b) {
  const rel = relationScore(a, b);
  if (rel === null) return null; // マッチング対象外

  const mbti = scoreEI(a, b) + scoreNS(a, b) + scoreTF(a, b) + scoreJP(a, b);
  const tags = tagScore(a, b);
  return mbti + tags + rel;
}

// gender_pref を尊重した相手候補かどうか（性別情報は未保持のため pref のみ簡易判定）
function isBlacklisted(userId) {
  return !!db.prepare('SELECT 1 FROM blacklist WHERE user_id = ?').get(userId);
}

/**
 * POST /api/matching/find
 * 指定ユーザーに対する候補を探し、最良の相手で pending マッチを作成する。
 * body: { user_id, limit? }
 */
router.post('/find', (req, res) => {
  const { user_id, limit } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const me = getUserWithTags(user_id);
  if (!me) return res.status(404).json({ error: 'user not found' });
  if (isBlacklisted(user_id)) {
    return res.status(403).json({ error: 'user is blacklisted' });
  }

  // 既に pending / accepted な相手は除外
  const tied = db.prepare(`
    SELECT user_b_id AS other FROM matches
      WHERE user_a_id = ? AND status IN ('pending', 'accepted')
    UNION
    SELECT user_a_id AS other FROM matches
      WHERE user_b_id = ? AND status IN ('pending', 'accepted')
  `).all(user_id, user_id).map((r) => r.other);
  const excluded = new Set([user_id, ...tied]);

  const candidates = db.prepare('SELECT id FROM users').all()
    .map((r) => r.id)
    .filter((id) => !excluded.has(id) && !isBlacklisted(id))
    .map((id) => getUserWithTags(id))
    .map((u) => ({ user: u, score: calcScore(me, u) }))
    .filter((c) => c.score !== null) // 関係値の差が3以上は除外
    .sort((x, y) => y.score - x.score);

  const top = candidates.slice(0, Math.max(1, Number(limit) || 5));

  if (top.length === 0) {
    return res.json({ match: null, candidates: [], message: 'no candidates available' });
  }

  // 最良の相手とマッチを作成
  const best = top[0];
  const matchId = uuidv4();
  db.prepare(`
    INSERT INTO matches (id, user_a_id, user_b_id, score, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(matchId, user_id, best.user.id, best.score);

  // マッチ相手へ 'match_found' 通知を追加
  enqueue(best.user.id, 'match_found', {
    match_id: matchId,
    from_user_id: user_id,
    score: best.score,
  });

  res.status(201).json({
    match: db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId),
    candidates: top.map((c) => ({
      user_id: c.user.id,
      faculty: c.user.faculty,
      grade: c.user.grade,
      score: c.score,
    })),
  });
});

/**
 * POST /api/matching/:id/respond
 * マッチへの応答。 body: { action: 'accept' | 'decline' }
 */
router.post('/:id/respond', (req, res) => {
  const { action } = req.body || {};
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!match) return res.status(404).json({ error: 'match not found' });

  if (action === 'accept') {
    db.prepare("UPDATE matches SET status = 'accepted' WHERE id = ?").run(match.id);
  } else if (action === 'decline') {
    db.prepare("UPDATE matches SET status = 'declined' WHERE id = ?").run(match.id);
  } else {
    return res.status(400).json({ error: "action must be 'accept' or 'decline'" });
  }

  res.json(db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id));
});

/**
 * GET /api/matching/user/:userId
 * 指定ユーザーが関わる全マッチを取得。
 */
router.get('/user/:userId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM matches
      WHERE user_a_id = ? OR user_b_id = ?
      ORDER BY created_at DESC
  `).all(req.params.userId, req.params.userId);
  res.json(rows);
});

/**
 * GET /api/matching/:id
 * マッチ1件取得。
 */
router.get('/:id', (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!match) return res.status(404).json({ error: 'match not found' });
  res.json(match);
});

module.exports = { router, calcScore };

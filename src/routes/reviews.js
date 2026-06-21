const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

const router = express.Router();

// user_weights のデフォルト値
const DEFAULT_WEIGHTS = {
  mbti_weight: 40,
  hobby_weight: 40,
  ei_pref: 50,
  hobby_pref: 50,
  review_count: 0,
};

const WEIGHT_MIN = 20;
const WEIGHT_MAX = 60;

function safeParse(json, fallback = null) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return json; }
}

function clamp15(v, fallback = 3) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/**
 * ユーザーの学習済みウェイトを取得する。
 * レコードが無ければデフォルト値を返す（マッチング計算・GETで利用）。
 */
function getWeights(userId) {
  const row = db.prepare('SELECT * FROM user_weights WHERE user_id = ?').get(userId);
  if (row) return row;
  return { user_id: userId, ...DEFAULT_WEIGHTS, updated_at: null };
}

/**
 * POST /api/reviews
 * レビューを保存し、ユーザーのウェイトをフィードバック更新する。
 * body: { user_id, match_id, talk_score, mission_score, ei_adjust, hobby_adjust, atmos_tags }
 */
router.post('/', (req, res) => {
  const {
    user_id, match_id,
    talk_score, mission_score, ei_adjust, hobby_adjust, atmos_tags,
  } = req.body || {};

  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const talk = clamp15(talk_score);
  const mission = clamp15(mission_score);
  const ei = clamp15(ei_adjust);
  const hobby = clamp15(hobby_adjust);
  const reviewId = uuidv4();

  const tx = db.transaction(() => {
    // 1) レビューを保存
    db.prepare(`
      INSERT INTO reviews
        (id, user_id, match_id, talk_score, mission_score, ei_adjust, hobby_adjust, atmos_tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewId, user_id, match_id ?? null,
      talk, mission, ei, hobby,
      JSON.stringify(Array.isArray(atmos_tags) ? atmos_tags : (atmos_tags ?? [])),
    );

    // 2) 現在のウェイト（無ければデフォルト）を基に更新値を算出
    const cur = getWeights(user_id);

    // 嗜好値は指数移動平均で更新（現在値×0.7 + 目標×0.3）
    const eiPref = cur.ei_pref * 0.7 + (ei * 20) * 0.3;
    const hobbyPref = cur.hobby_pref * 0.7 + (hobby * 20) * 0.3;

    // 配点ウェイトは満足度に応じて ±1（20〜60でクランプ）
    let mbtiW = cur.mbti_weight;
    if (talk >= 4) mbtiW = Math.min(WEIGHT_MAX, mbtiW + 1);
    else if (talk <= 2) mbtiW = Math.max(WEIGHT_MIN, mbtiW - 1);

    let hobbyW = cur.hobby_weight;
    if (hobby >= 4) hobbyW = Math.min(WEIGHT_MAX, hobbyW + 1);
    else if (hobby <= 2) hobbyW = Math.max(WEIGHT_MIN, hobbyW - 1);

    const reviewCount = cur.review_count + 1;

    db.prepare(`
      INSERT INTO user_weights
        (user_id, mbti_weight, hobby_weight, ei_pref, hobby_pref, review_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        mbti_weight  = excluded.mbti_weight,
        hobby_weight = excluded.hobby_weight,
        ei_pref      = excluded.ei_pref,
        hobby_pref   = excluded.hobby_pref,
        review_count = excluded.review_count,
        updated_at   = CURRENT_TIMESTAMP
    `).run(user_id, mbtiW, hobbyW, eiPref, hobbyPref, reviewCount);

    return {
      review: db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId),
      weights: getWeights(user_id),
    };
  });

  const { review, weights } = tx();
  res.status(201).json({
    ...review,
    atmos_tags: safeParse(review.atmos_tags, []),
    weights,
  });
});

module.exports = { router, getWeights, DEFAULT_WEIGHTS };

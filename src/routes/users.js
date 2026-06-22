const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { getWeights } = require('./reviews');

const router = express.Router();

// MBTI値を 0〜100 にクランプ
function clampMbti(v, fallback = 50) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * POST /api/users
 * ユーザー登録。device_id が既に存在する場合はそのユーザーを返す（冪等）。
 * body: { device_id, faculty, grade, mbti_ei, mbti_ns, mbti_tf, mbti_jp,
 *         gender_pref, tags: [{ name, type }] }
 */
router.post('/', (req, res) => {
  const {
    device_id, faculty, grade,
    mbti_ei, mbti_ns, mbti_tf, mbti_jp,
    relation_value, gender_pref, tags,
  } = req.body || {};

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  // relation_value を 1〜5 にクランプ
  const clampRelation = (v, fb = 2) => {
    const n = Number(v);
    if (Number.isNaN(n)) return fb;
    return Math.max(1, Math.min(5, Math.round(n)));
  };

  // 既存ユーザーがいれば更新扱いにする
  const existing = db.prepare('SELECT * FROM users WHERE device_id = ?').get(device_id);

  const id = existing ? existing.id : uuidv4();
  const pref = gender_pref === 'same' ? 'same' : 'any';

  const upsert = db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE users SET
          faculty = ?, grade = ?,
          mbti_ei = ?, mbti_ns = ?, mbti_tf = ?, mbti_jp = ?,
          relation_value = ?, gender_pref = ?
        WHERE id = ?
      `).run(
        faculty ?? existing.faculty,
        grade ?? existing.grade,
        clampMbti(mbti_ei, existing.mbti_ei),
        clampMbti(mbti_ns, existing.mbti_ns),
        clampMbti(mbti_tf, existing.mbti_tf),
        clampMbti(mbti_jp, existing.mbti_jp),
        clampRelation(relation_value, existing.relation_value),
        pref,
        id,
      );
    } else {
      db.prepare(`
        INSERT INTO users
          (id, device_id, faculty, grade, mbti_ei, mbti_ns, mbti_tf, mbti_jp, relation_value, gender_pref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, device_id, faculty ?? null, grade ?? null,
        clampMbti(mbti_ei), clampMbti(mbti_ns), clampMbti(mbti_tf), clampMbti(mbti_jp),
        clampRelation(relation_value), pref,
      );
    }

    // タグを入れ替え
    if (Array.isArray(tags)) {
      db.prepare('DELETE FROM user_tags WHERE user_id = ?').run(id);
      const insertTag = db.prepare(
        'INSERT OR IGNORE INTO user_tags (user_id, tag_name, tag_type) VALUES (?, ?, ?)'
      );
      for (const t of tags) {
        if (!t || !t.name) continue;
        const type = t.type === 'interest' ? 'interest' : 'hobby';
        insertTag.run(id, String(t.name), type);
      }
    }
  });

  upsert();

  const user = getUserWithTags(id);
  res.status(existing ? 200 : 201).json(user);
});

/**
 * PUT /api/users/:id
 * プロフィール更新（MBTI4軸・gender_pref・タグの入れ替え）。
 * relation_value はUIから廃止した内部固定値なのでここでは更新しない。
 * body: { faculty, grade, mbti_ei, mbti_ns, mbti_tf, mbti_jp, gender_pref, tags:[{name,type}] }
 */
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'user not found' });

  const { faculty, grade, mbti_ei, mbti_ns, mbti_tf, mbti_jp, gender_pref, tags } = req.body || {};
  const pref = gender_pref === 'same' ? 'same'
    : gender_pref === 'any' ? 'any'
    : existing.gender_pref;

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE users SET
        faculty = ?, grade = ?,
        mbti_ei = ?, mbti_ns = ?, mbti_tf = ?, mbti_jp = ?,
        gender_pref = ?
      WHERE id = ?
    `).run(
      faculty ?? existing.faculty,
      grade ?? existing.grade,
      clampMbti(mbti_ei, existing.mbti_ei),
      clampMbti(mbti_ns, existing.mbti_ns),
      clampMbti(mbti_tf, existing.mbti_tf),
      clampMbti(mbti_jp, existing.mbti_jp),
      pref,
      id,
    );

    // タグを入れ替え（マッチングの共通点・スコアに反映される）
    if (Array.isArray(tags)) {
      db.prepare('DELETE FROM user_tags WHERE user_id = ?').run(id);
      const insertTag = db.prepare(
        'INSERT OR IGNORE INTO user_tags (user_id, tag_name, tag_type) VALUES (?, ?, ?)'
      );
      for (const t of tags) {
        if (!t || !t.name) continue;
        const type = t.type === 'interest' ? 'interest' : 'hobby';
        insertTag.run(id, String(t.name), type);
      }
    }
  });
  update();

  res.json(getUserWithTags(id));
});

/**
 * GET /api/users/:id/weights
 * ユーザーの学習済みウェイトを返す（未作成ならデフォルト値）。
 */
router.get('/:id/weights', (req, res) => {
  res.json(getWeights(req.params.id));
});

/**
 * GET /api/users/:id
 * ユーザー1件取得（タグ付き）。
 */
router.get('/:id', (req, res) => {
  const user = getUserWithTags(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

/**
 * GET /api/users/device/:deviceId
 * 端末IDからユーザーを取得（アプリ起動時の復元用）。
 */
router.get('/device/:deviceId', (req, res) => {
  const row = db.prepare('SELECT id FROM users WHERE device_id = ?').get(req.params.deviceId);
  if (!row) return res.status(404).json({ error: 'user not found' });
  res.json(getUserWithTags(row.id));
});

// ユーザー + タグをまとめて取得するヘルパ
function getUserWithTags(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  const tags = db.prepare(
    'SELECT tag_name AS name, tag_type AS type FROM user_tags WHERE user_id = ?'
  ).all(id);
  return { ...user, tags };
}

module.exports = { router, getUserWithTags };

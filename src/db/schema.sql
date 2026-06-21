-- ============================================================
-- Yo バックエンド スキーマ定義
-- ============================================================

-- ユーザー -----------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- UUID
  device_id   TEXT UNIQUE NOT NULL,      -- 端末固有ID
  faculty     TEXT,                      -- 学部
  grade       INTEGER,                   -- 学年
  mbti_ei     INTEGER DEFAULT 50,        -- 外向(E) - 内向(I)  0〜100
  mbti_ns     INTEGER DEFAULT 50,        -- 直観(N) - 感覚(S)  0〜100
  mbti_tf     INTEGER DEFAULT 50,        -- 思考(T) - 感情(F)  0〜100
  mbti_jp     INTEGER DEFAULT 50,        -- 判断(J) - 知覚(P)  0〜100
  relation_value INTEGER DEFAULT 2,      -- 求める関係値 1〜5
  gender_pref TEXT DEFAULT 'any',        -- 'same' or 'any'
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- タグマスタ ---------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- タグ名
  type TEXT NOT NULL                     -- 'hobby' or 'interest'
);

-- ユーザーが持つタグ -------------------------------------------
CREATE TABLE IF NOT EXISTS user_tags (
  user_id  TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  tag_type TEXT NOT NULL,                -- 'hobby' or 'interest'
  PRIMARY KEY (user_id, tag_name, tag_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- マッチング ---------------------------------------------------
CREATE TABLE IF NOT EXISTS matches (
  id         TEXT PRIMARY KEY,           -- UUID
  user_a_id  TEXT NOT NULL,
  user_b_id  TEXT NOT NULL,
  score      INTEGER,                    -- マッチングスコア
  status     TEXT DEFAULT 'pending',     -- 'pending' / 'accepted' / 'declined' / 'failed'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_a_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (user_b_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 待ち合わせ ---------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id             TEXT PRIMARY KEY,       -- UUID
  match_id       TEXT NOT NULL,
  scheduled_time TEXT,                   -- 日時テキスト
  place          TEXT,                   -- 場所
  confirmed_a    INTEGER DEFAULT 0,      -- 0 or 1
  confirmed_b    INTEGER DEFAULT 0,      -- 0 or 1
  wishes_a       TEXT,                   -- ユーザーAの希望（JSON: {time_slots:[], places:[]}）
  wishes_b       TEXT,                   -- ユーザーBの希望（JSON: {time_slots:[], places:[]}）
  proposed_time  TEXT,                   -- 自動提案された時間
  proposed_place TEXT,                   -- 自動提案された場所
  status         TEXT DEFAULT 'waiting', -- 'waiting' / 'proposed' / 'no_match'
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);

-- 通報 ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  reported_id TEXT NOT NULL,
  category    TEXT NOT NULL,             -- 'cancel' / 'sexual' / 'harassment' / 'other'
  note        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ブラックリスト -----------------------------------------------
CREATE TABLE IF NOT EXISTS blacklist (
  user_id      TEXT PRIMARY KEY,
  report_count INTEGER DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 通知キュー ---------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,          -- UUID
  user_id    TEXT NOT NULL,             -- 送信先ユーザー
  type       TEXT NOT NULL,             -- 'match_found' / 'wish_received' / 'proposal_ready'
                                        -- / 'confirmation' / 'reminder' / 'review_request'
  payload    TEXT,                      -- 通知内容（JSON）
  is_sent    INTEGER DEFAULT 0,         -- 0 = 未送信, 1 = 送信済み
  scheduled_at DATETIME,                -- 配信予定時刻（NULL = 即時配信）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- レビュー -----------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,        -- UUID
  user_id       TEXT NOT NULL,           -- レビューした人
  match_id      TEXT,                    -- 対象マッチ
  talk_score    INTEGER,                 -- 会話の満足度 1〜5
  mission_score INTEGER,                 -- ミッション達成度 1〜5
  ei_adjust     INTEGER,                 -- 静かな人好き(1)↔よく話す人好き(5)
  hobby_adjust  INTEGER,                 -- 趣味違っていい(1)↔共通点大事(5)
  atmos_tags    TEXT,                    -- 雰囲気タグ（JSON）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ユーザーごとの学習済みウェイト -------------------------------
CREATE TABLE IF NOT EXISTS user_weights (
  user_id      TEXT PRIMARY KEY,
  mbti_weight  INTEGER DEFAULT 40,       -- MBTI配点ウェイト 20〜60
  hobby_weight INTEGER DEFAULT 40,       -- 趣味配点ウェイト 20〜60
  ei_pref      REAL DEFAULT 50,          -- E/I 嗜好 0〜100
  hobby_pref   REAL DEFAULT 50,          -- 共通点重視度 0〜100
  review_count INTEGER DEFAULT 0,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- インデックス -------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_tags_user   ON user_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_matches_user_a   ON matches(user_a_id);
CREATE INDEX IF NOT EXISTS idx_matches_user_b   ON matches(user_b_id);
CREATE INDEX IF NOT EXISTS idx_meetings_match   ON meetings(match_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_sent);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);

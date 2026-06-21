const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// .env の DB_PATH を解決（未指定ならプロジェクト直下の yo.db）
const dbPath = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.resolve(process.cwd(), 'yo.db');

const db = new Database(dbPath);

// 外部キー制約とWALモードを有効化
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

/**
 * schema.sql を読み込んでテーブルを作成する（初期化）。
 * IF NOT EXISTS を使っているため何度実行しても安全。
 */
function initDb() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  seedTags();
  console.log(`[db] initialized at ${dbPath}`);
}

/**
 * タグマスタの初期データ投入（空のときだけ）。
 */
function seedTags() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM tags').get().c;
  if (count > 0) return;

  const defaults = [
    // hobby
    ['サッカー', 'hobby'], ['野球', 'hobby'], ['バスケ', 'hobby'],
    ['筋トレ', 'hobby'], ['ゲーム', 'hobby'], ['映画鑑賞', 'hobby'],
    ['music', 'hobby'], ['料理', 'hobby'], ['カフェ巡り', 'hobby'],
    ['旅行', 'hobby'],
    // interest
    ['プログラミング', 'interest'], ['起業', 'interest'], ['投資', 'interest'],
    ['デザイン', 'interest'], ['語学', 'interest'], ['アニメ', 'interest'],
    ['ファッション', 'interest'], ['読書', 'interest'],
  ];

  const insert = db.prepare('INSERT INTO tags (name, type) VALUES (?, ?)');
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(r[0], r[1]);
  });
  insertMany(defaults);
  console.log(`[db] seeded ${defaults.length} tags`);
}

module.exports = { db, initDb };

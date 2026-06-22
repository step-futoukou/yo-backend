// 開発・テスト用: ユーザーデータを全削除してクリーンな状態にする。
// スキーマと seed 済みタグ(tags)は保持する。登録など本番ロジックには手を加えない。
//
// 使い方:  npm run reset-db
// （サーバー稼働中でも実行可能。確実を期すなら停止してから実行）

require('dotenv').config();

// 本番では絶対に実行しない安全ガード
if (process.env.NODE_ENV === 'production') {
  console.error('[reset-db] NODE_ENV=production のため中止しました');
  process.exit(1);
}

const { db, initDb } = require('../src/db/database');

// テーブルが無ければ作成（+ tags seed）。既存DBには影響なし。
initDb();

// 外部キー順を考慮して子テーブルから削除（tags は残す）
const tables = [
  'notifications',
  'rematch_candidates',
  'reviews',
  'meetings',
  'matches',
  'reports',
  'blacklist',
  'user_tags',
  'users',
];

const wipe = db.transaction(() => {
  for (const t of tables) {
    const { changes } = db.prepare(`DELETE FROM ${t}`).run();
    console.log(`  cleared ${t.padEnd(20)} ${changes} rows`);
  }
  // AUTOINCREMENT のカウンタもリセット（存在すれば）
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('reports')").run(); } catch (e) { /* noop */ }
});

wipe();

const remainingUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const remainingTags = db.prepare('SELECT COUNT(*) AS c FROM tags').get().c;
console.log(`[reset-db] 完了: users=${remainingUsers}, tags(seed保持)=${remainingTags}`);
process.exit(0);

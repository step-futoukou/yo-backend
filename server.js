require('dotenv').config();

const app = require('./src/app');
const { initDb } = require('./src/db/database');
const { startSweep } = require('./src/routes/notifications');

const PORT = process.env.PORT || 3000;

// DB初期化（テーブル作成 + タグ初期データ）
initDb();

// 起動時 + 1分ごとに review_request のスイープを実行
// （再起動で消えた配信予定をDBから拾って送信済みにする）
startSweep();

app.listen(PORT, () => {
  console.log(`[server] Yo backend listening on http://localhost:${PORT}`);
});

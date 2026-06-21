require('dotenv').config();

const app = require('./src/app');
const { initDb } = require('./src/db/database');

const PORT = process.env.PORT || 3000;

// DB初期化（テーブル作成 + タグ初期データ）
initDb();

app.listen(PORT, () => {
  console.log(`[server] Yo backend listening on http://localhost:${PORT}`);
});

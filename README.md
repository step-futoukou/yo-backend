# Yo Backend

大学生向け友達マッチングアプリ「Yo」のバックエンドAPI。

## 技術スタック

- Node.js + Express
- SQLite（better-sqlite3）
- UUID によるID管理

## セットアップ

```bash
npm install
node server.js
# → [server] Yo backend listening on http://localhost:3000
```

初回起動時に `yo.db`（SQLite）が自動生成され、テーブル作成とタグの初期データ投入が行われます。

### 環境変数（`.env`）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `3000` | サーバーのポート |
| `DB_PATH` | `./yo.db` | SQLiteファイルのパス |
| `NODE_ENV` | `development` | 実行環境 |

## 共通仕様

- ベースURL: `http://localhost:3000`
- リクエスト/レスポンスはすべて `application/json`
- エラー時は `{ "error": "メッセージ" }` を対応するHTTPステータスで返却

---

## ヘルスチェック

### `GET /`
サービス情報を返す。
```json
{ "name": "Yo backend", "status": "ok" }
```

### `GET /health`
```json
{ "status": "ok", "time": "2026-06-21T13:22:50.253Z" }
```

---

## ユーザー API

### `POST /api/users`
ユーザー登録。`device_id` が既存の場合は更新（冪等）。

**Request Body**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `device_id` | string | ✅ | 端末固有ID |
| `faculty` | string | | 学部 |
| `grade` | integer | | 学年 |
| `mbti_ei` | integer | | E/I 軸 0〜100（既定50） |
| `mbti_ns` | integer | | N/S 軸 0〜100（既定50） |
| `mbti_tf` | integer | | T/F 軸 0〜100（既定50） |
| `mbti_jp` | integer | | J/P 軸 0〜100（既定50） |
| `relation_value` | integer | | 求める関係値 1〜5（既定2） |
| `gender_pref` | string | | `'same'` or `'any'`（既定 `'any'`） |
| `tags` | array | | `[{ "name": "ゲーム", "type": "hobby" }]`。`type` は `'hobby'` or `'interest'` |

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "dev-1",
    "faculty": "工学部",
    "grade": 2,
    "mbti_ei": 70, "mbti_ns": 60, "mbti_tf": 40, "mbti_jp": 55,
    "relation_value": 2,
    "gender_pref": "any",
    "tags": [
      { "name": "ゲーム", "type": "hobby" },
      { "name": "プログラミング", "type": "interest" }
    ]
  }'
```

**Response** `201`（新規）/ `200`（更新）— 登録されたユーザー（`tags` 配列付き）
```json
{
  "id": "3f18567b-8ffb-4b9a-96bc-42d80d7555d8",
  "device_id": "dev-1",
  "faculty": "工学部",
  "grade": 2,
  "mbti_ei": 70, "mbti_ns": 60, "mbti_tf": 40, "mbti_jp": 55,
  "relation_value": 2,
  "gender_pref": "any",
  "created_at": "2026-06-21 13:22:50",
  "tags": [
    { "name": "ゲーム", "type": "hobby" },
    { "name": "プログラミング", "type": "interest" }
  ]
}
```

### `GET /api/users/:id`
ユーザーIDで取得（タグ付き）。`404` if not found.

### `GET /api/users/device/:deviceId`
端末IDでユーザーを取得（アプリ起動時の復元用）。`404` if not found.

---

## マッチング API

### `POST /api/matching/find`
指定ユーザーの候補をスコア順に算出し、**最良の相手と `pending` マッチを作成**する。

**Request Body**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `user_id` | string | ✅ | 検索元ユーザーのID |
| `limit` | integer | | 返す候補数（既定5） |

- 既に `pending` / `accepted` の相手、ブラックリスト入りユーザーは候補から除外
- **求める関係値の差が3以上の相手は対象外**（除外）

**Response** `201`
```json
{
  "match": {
    "id": "…", "user_a_id": "…", "user_b_id": "…",
    "score": 75, "status": "pending", "created_at": "…"
  },
  "candidates": [
    { "user_id": "…", "faculty": "工学部", "grade": 2, "score": 75 }
  ]
}
```
候補が0件の場合は `{ "match": null, "candidates": [], "message": "no candidates available" }`。

### `POST /api/matching/:id/respond`
マッチへの応答。

**Request Body**: `{ "action": "accept" | "decline" }`

**Response**: 更新後のマッチ（`status` が `accepted` / `declined`）。

### `GET /api/matching/user/:userId`
指定ユーザーが関わる全マッチを新しい順で取得。

### `GET /api/matching/:id`
マッチを1件取得。`404` if not found.

---

## 待ち合わせ API

### `POST /api/meetings`
待ち合わせを作成。マッチが `accepted` であることが前提。

**Request Body**: `{ "match_id", "scheduled_time", "place" }`

**Response** `201`: 作成された待ち合わせ。

### `POST /api/meetings/:id/confirm`
待ち合わせを確定する。両者が確定すると成立。

**Request Body**: `{ "side": "a" | "b" }`

**Response**: 更新後の待ち合わせ + `"both_confirmed": true/false`。

### `POST /api/meetings/wishes`
ユーザーの希望（時間・場所）を登録。**両者の希望が揃うと自動で重複を検出**する。

**Request Body**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `match_id` | string | ✅ | 対象マッチID |
| `user_id` | string | ✅ | 提出者のID（A/Bは自動判定） |
| `time_slots` | array | | 希望時間のリスト（例 `["Mon18","Tue19"]`） |
| `places` | array | | 希望場所のリスト（例 `["渋谷","新宿"]`） |

**動作**
- match に紐づく待ち合わせが無ければ自動生成
- 片方のみ提出 → `status: "waiting"`
- 両者揃い：
  - 時間に重複あり → `proposed_time` に**最初の重複**（先に提出した側の並び順を優先）
  - 場所に重複あり → `proposed_place` に最初の重複、`status: "proposed"`
  - 時間・場所とも重複なし → `status: "no_match"`

**Response** `201`
```json
{
  "id": "…", "match_id": "…",
  "wishes_a": "{\"time_slots\":[…],\"places\":[…]}",
  "wishes_b": "{\"time_slots\":[…],\"places\":[…]}",
  "proposed_time": "Tue19",
  "proposed_place": "新宿",
  "status": "proposed",
  "both_submitted": true
}
```

### `GET /api/meetings/:match_id/proposal`
自動提案された時間・場所を返す。

**Response（両者揃い）**
```json
{
  "status": "proposed",
  "match_id": "…",
  "meeting_id": "…",
  "proposed_time": "Tue19",
  "proposed_place": "新宿"
}
```
**Response（未回答あり）**
```json
{
  "status": "waiting",
  "match_id": "…",
  "proposed_time": null,
  "proposed_place": null,
  "waiting_for": ["b"]
}
```

### `GET /api/meetings/match/:matchId`
マッチに紐づく待ち合わせ一覧を新しい順で取得。

### `GET /api/meetings/:id`
待ち合わせを1件取得。`404` if not found.

---

## 通報 / ブラックリスト API

### `POST /api/meetings/report`
ユーザーを通報する。通報数が **3件**に達すると自動でブラックリスト入り。

**Request Body**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `reporter_id` | string | ✅ | 通報者ID |
| `reported_id` | string | ✅ | 被通報者ID |
| `category` | string | | `'cancel'` / `'sexual'` / `'harassment'` / `'other'`（既定 `'other'`） |
| `note` | string | | 補足 |

**Response** `201`
```json
{ "message": "report submitted", "report_count": 1, "blacklisted": false }
```

### `GET /api/meetings/blacklist/:userId`
ユーザーがブラックリスト入りしているか確認。
```json
{ "blacklisted": false, "detail": null }
```

---

## 通知 API

通知はキューに蓄積され、クライアントが `GET` で取得（プル）すると送信済みになる方式。

### 通知の種別（`type`）

| type | 発火タイミング | 宛先 |
|---|---|---|
| `match_found` | `POST /api/matching/find` でマッチ成立 | マッチ相手 |
| `proposal_ready` | `POST /api/meetings/wishes` で両者の希望が揃った | 両者 |
| `confirmation` | `POST /api/meetings/:id/confirm` で両者確認完了 | 両者 |
| `review_request` | 両者確認完了の **60分後**（`scheduled_at` 経過後にスイープで送信） | 両者 |
| `reminder` | `POST /api/notifications/reminder` で手動追加 | 指定ユーザー |
| `wish_received` | （予約。現状は自動発火なし） | — |

### `GET /api/notifications/:user_id`
指定ユーザー宛ての**未送信通知**を返し、返した通知を `is_sent = 1` に更新する。
`scheduled_at` が未来の通知（配信予定の `review_request` など）は対象外。

**Response** `200`
```json
[
  {
    "id": "…",
    "user_id": "…",
    "type": "match_found",
    "payload": { "match_id": "…", "from_user_id": "…", "score": 75 },
    "is_sent": 0,
    "scheduled_at": null,
    "created_at": "2026-06-21 13:22:50"
  }
]
```
未送信が無ければ `[]`。`payload` はパース済みオブジェクトで返却。

### `POST /api/notifications/reminder`
再通知（リマインダー）をキューに追加する。

**Request Body**: `{ "match_id", "user_id" }`（`user_id` 必須）

**Response** `201`: 追加された通知。

---

## マッチングスコア仕様（合計100点）

### MBTIスコア（40点・各軸10点）

| 軸 | 配点ルール |
|---|---|
| **E/I** | 差 0〜15%→10 / 16〜30%→7 / 31〜50%→3 / 51%〜→1 |
| **N/S** | 同じ側※ かつ 差0〜15%→10 / 16〜30%→7 / 31%〜→5 ／ 異なる側→2 |
| **T/F** | 差 0〜15%→10 / 16〜30%→7 / 31〜50%→5 / 51%〜→3 |
| **J/P** | 差 0〜15%→10 / 16〜30%→7 / 31〜50%→3 / 51%〜→1 |

※ N/Sの「同じ側」= 両者とも `mbti_ns < 50`（N寄り）または 両者とも `>= 50`（S寄り）

### 趣味×興味スコア（最大40点）

共通タグ（名前一致）について `tag_type` の組み合わせで加点。

| 組み合わせ | 配点 |
|---|---|
| 趣味 × 趣味 | 1タグ 10点 |
| 趣味 × 興味 | 1タグ 7点 |
| 興味 × 興味 | 1タグ 5点 |
| 一致 0件 | 3点（固定） |

合計の上限は40点。

### 求める関係値の近さ（20点）

`relation_value`（1〜5）の差で加点。

| 差 | 配点 |
|---|---|
| 0 | 20点 |
| 1 | 14点 |
| 2 | 6点 |
| 3以上 | **マッチング対象外（除外）** |

---

## データベース構成

| テーブル | 説明 |
|---|---|
| `users` | ユーザー（MBTI・関係値・学部・学年など） |
| `tags` | タグマスタ（`hobby` / `interest`） |
| `user_tags` | ユーザーが持つタグ |
| `matches` | マッチング結果（`pending`/`accepted`/`declined`/`failed`） |
| `meetings` | 待ち合わせ（希望・自動提案・確定状態） |
| `reports` | 通報 |
| `blacklist` | ブラックリスト |
| `notifications` | 通知キュー（`scheduled_at` で遅延配信に対応） |

スキーマ定義: [`src/db/schema.sql`](src/db/schema.sql)

## ディレクトリ構成

```
yo-backend/
├── src/
│   ├── db/
│   │   ├── database.js      # DB接続・初期化・タグ初期投入
│   │   └── schema.sql       # テーブル定義
│   ├── routes/
│   │   ├── users.js         # ユーザー登録・取得
│   │   ├── matching.js      # マッチング（スコア算出）
│   │   ├── meetings.js      # 待ち合わせ・希望重複検出・通報
│   │   └── notifications.js # 通知キュー・スイープ処理
│   └── app.js               # Expressアプリ本体
├── .env
└── server.js                # エントリーポイント
```

# 実装指示書：家計PWAへのAIエージェント機能追加

作成: 11 エンジニアリング（けんと）
対象リポジトリ: rkomori1004-ship-it/cashflow-beta

## 背景・目的

既存の家計管理PWA（GitHub Pages静的サイト＋Firebase Firestore）に、以下2機能を追加する。

1. 対話AIアドバイザー（Firestoreの収支データを踏まえてチャット相談できる）
2. 月末自動レポート（アプリを開くと前月分のAIレポートが準備されている）

「レシート・明細の自動仕訳」は今回のスコープから除外済み。

コスト方針：Claude APIではなく**Gemini API（無料枠）**を利用する。Firebase Cloud Functionsは
Blazeプランへの切り替えが必要だが、想定利用量では無料枠内に収まる見込み。

## 前提条件（実装着手前にご本人が完了させる作業）

- [ ] Google AI StudioでGemini APIキーを発行
- [ ] Firebase Blazeプランへの切り替え
- [ ] ローカル環境に `firebase-tools` をインストールし `firebase login`
- [ ] 既存のFirestoreセキュリティルール（Firebaseコンソール）の内容を確認・共有
      （本ドキュメント作成時点ではリポジトリ内にルールファイルが見当たらず未確認。
      新設するサブコレクションを「Cloud Functions[Admin SDK]からの書き込みのみ許可、
      クライアントからの直接書き込みは禁止」に設定する必要がある）

## 既存実装の要点（調査済み・変更しない前提）

- 全データは単一Firestoreドキュメント `cf-sync/{syncDocId}` にJSONとしてまとめて保存されている
  （`index.html` の `gatherAllLocalData()` / `applyAllLocalData()` / `pushToCloud()`）。
- 認証はFirebase Authを使わず、「合言葉」のSHA-256ハッシュ値がそのままドキュメントIDになる
  擬似認証方式（`hashPassphrase()`）。**今回新たにFirebase Authは導入しない。**
- 月次サマリーの整形ロジックは `buildAIConsultText()`（index.html内）に既存実装がある。
  Cloud Functions側ではこれをNode.js/TypeScriptに移植して再利用する。
- クライアントの同期は「ローカル全体をsetDocで上書き」する方式のため、チャット履歴や
  レポートは**`cf-sync`本体のフィールドに含めない**（含めると通常の家計データ編集の
  同期時に消えてしまうため）。必ずサブコレクションとして分離する。

## 全体アーキテクチャ

```
[GitHub Pages: index.html]
        │ Firebase Functions SDK (httpsCallable)
        ▼
[Firebase Cloud Functions (Node.js/TypeScript, v2)]
        │
        ├─► Firestore: cf-sync/{syncDocId} 本体（読み取りのみ）
        ├─► Firestore: cf-sync/{syncDocId}/chatThreads/{yyyymm}/messages（読み書き）
        ├─► Firestore: cf-sync/{syncDocId}/reports/{yyyymm}（読み書き）
        └─► Gemini API（@google/generative-ai、GEMINI_API_KEYはSecret Manager経由）
```

## ディレクトリ構成（新規追加分）

```
cashflow-beta/
  functions/
    src/
      index.ts                  # エクスポート集約
      lib/
        firestore.ts            # Admin SDK初期化・共通ヘルパー
        gemini.ts                # Gemini APIクライアントラッパー
        summary.ts               # buildMonthSummary() / buildTrendSummary()
      handlers/
        adviceChat.ts
        resetChatThread.ts
        generateMonthlyReport.ts
    package.json
    tsconfig.json
  index.html                     # 既存ファイルにUI追加（後述）
```

## Firestoreスキーマ

### 既存（変更しない）
`cf-sync/{syncDocId}` — フィールド構成は現状維持。

### 新規

```
cf-sync/{syncDocId}/chatThreads/{yyyymm}/messages/{messageId}
  - role: 'user' | 'model'
  - text: string
  - createdAt: Timestamp (serverTimestamp)

cf-sync/{syncDocId}/reports/{yyyymm}
  - summaryText: string   # Geminiが生成した月次レポート本文
  - stats: { income, expense, net, byCategory }  # 集計元データ（再利用・検証用）
  - generatedAt: Timestamp
```

## Cloud Functions 一覧

### 共通ライブラリ

- `lib/firestore.ts`
  - Admin SDK初期化
  - `getSyncDoc(docId): Promise<SyncData | null>` — 存在しなければnull
- `lib/gemini.ts`
  - `GEMINI_API_KEY = defineSecret("GEMINI_API_KEY")`
  - `askGemini(prompt: string): Promise<string>` の薄いラッパー
- `lib/summary.ts`
  - `buildMonthSummary(state, year, month): string` — 既存`buildAIConsultText()`のNode移植
  - `buildTrendSummary(state, months: number): string` — 直近N ヶ月分の
    「収入・支出・純収支」の数値のみを軽量にまとめたテキスト（カテゴリ内訳は含めない＝
    トークン節約のため）

### 1. `adviceChat`（onCall）

**入力**: `{ syncDocId: string, month: string /* "yyyyMM" */, question: string }`

**処理**:
1. `getSyncDoc(syncDocId)` で存在確認。存在しなければ `unauthenticated` エラーを返す
2. `chatThreads/{month}/messages` を `createdAt` 昇順・直近20件取得
3. `buildTrendSummary(state, 6)` で直近6ヶ月のトレンドを生成
4. `buildMonthSummary(state, year, month)` で当月詳細サマリーを生成
5. プロンプトを構築（システム指示＋トレンド＋当月詳細＋会話履歴＋新しい質問）してGemini呼び出し
6. 成功時のみ、質問・応答の両方を`messages`に`serverTimestamp()`付きで保存
7. `{ answer: string }` を返す

**エラー処理**: Gemini呼び出し失敗時は`internal`エラーを返し、Firestoreへの保存は行わない
（中途半端な履歴を残さないため）。

### 2. `resetChatThread`（onCall）

**入力**: `{ syncDocId: string, month: string }`

**処理**: 対象月の`messages`サブコレクションを全削除（500件超も考慮しバッチ／ページング削除）。
過去の別月スレッドには影響しない。

**出力**: `{ ok: true }`

### 3. `generateMonthlyReport`（onSchedule）

**スケジュール**: 毎月1日 09:10 JST 目安（Cronは `0 10 1 * *`、タイムゾーンをUTC基準で調整）

**処理**:
1. Secret Manager登録済みの固定 `SYNC_DOC_ID` を読む
2. 前月の yyyyMM を計算
3. 既に `reports/{yyyymm}` が存在する場合は**何もせず終了**（冪等性・二重課金防止）
4. `buildMonthSummary()` で前月詳細を生成し、Geminiにレポート文生成を依頼
5. `reports/{yyyymm}` に保存

## クライアント側（index.html）の変更点

1. Firebase Functions SDKを追加import（`getFunctions`, `httpsCallable`）
2. 新規UIタブ「AIアドバイザー」を追加
   - チャット表示エリア：`onSnapshot`で `chatThreads/{今月のyyyyMM}/messages` を購読して表示
   - 入力欄＋送信ボタン：`adviceChat` を呼び出し
   - 「今月の会話をリセット」ボタン：確認ダイアログ→`resetChatThread` を呼び出し
3. 月次レポート表示
   - アプリ起動時に `cf-sync/{syncDocId}/reports/{前月yyyyMM}` を`getDoc`で読み込み表示
   - 存在しない場合は「まだ生成されていません」と表示するのみ（手動生成ボタンは設けない＝
     コスト管理のため生成は自動スケジュールのみに限定する）

## Secret Manager登録項目

- `GEMINI_API_KEY`：Google AI StudioのAPIキー
- `SYNC_DOC_ID`：現在使用中の合言葉のハッシュ値（③月末レポート専用。合言葉を変更した場合は
  この値も更新が必要）

## 未確認・要確認事項（実装着手前に解消する）

- 既存のFirestoreセキュリティルールの内容（本リポジトリには`firestore.rules`が見当たらない
  ため、Firebaseコンソール側の設定を確認する必要がある）
- 新設サブコレクション（`chatThreads`・`reports`）はCloud Functions（Admin SDK）からの
  書き込みのみを許可し、クライアントからの直接書き込みは禁止する方向で問題ないか

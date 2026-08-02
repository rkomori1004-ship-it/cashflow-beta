# デプロイ手順

前提：Gemini APIキー発行・Firebase Blazeプラン切り替え・Firestoreルール更新は完了済み。

## 1. Firebase CLIのセットアップ（初回のみ）

```bash
npm install -g firebase-tools
firebase login
```

リポジトリのルート（`cashflow-beta/`）で実行してください。`.firebaserc` でプロジェクト
`casshflow-4af42` に紐付け済みです。

## 2. Secret Managerへの登録（初回のみ・値を変更した場合も再実行）

```bash
firebase functions:secrets:set GEMINI_API_KEY
```
→ プロンプトでGoogle AI Studioで発行したAPIキーを貼り付け

```bash
firebase functions:secrets:set SYNC_DOC_ID
```
→ プロンプトで、現在使用中の合言葉のハッシュ値を貼り付け。値は、アプリを開いた状態で
ブラウザの開発者ツール→コンソールで以下を実行すると取得できます。

```js
localStorage.getItem('cf-sync-docid')
```

## 3. Firestoreルールのデプロイ

```bash
firebase deploy --only firestore:rules
```

## 4. Cloud Functionsのデプロイ

```bash
firebase deploy --only functions
```

初回デプロイ後、`generateMonthlyReport` は毎月1日09:10(JST)に自動実行されます。
手動で動作確認したい場合は、Firebase Console → Functions → 対象の関数 → 「今すぐ実行」
（またはCloud Schedulerから該当ジョブを手動トリガー）で試せます。

## 5. 動作確認

1. アプリ（index.html）を開き、「セーブ」タブでクラウド同期が設定済みであることを確認
2. サブメニュー「🤖 AIアドバイザー」を開き、質問を送信してみる
3. 応答が返り、リロードしても会話履歴が残っていることを確認
4. 「今月の会話をリセット」ボタンで履歴が消えることを確認
5. 月次レポートは翌月1日にならないと自動生成されないため、初回は手動トリガーで確認する

## トラブルシューティング

- `adviceChat`が`unauthenticated`エラーを返す場合：`syncDocId`が`cf-sync`コレクションに
  存在しない（＝クラウド同期が未設定）ことが原因です。まず「セーブ」タブで同期を設定してください。
- Geminiからの応答が空/失敗する場合：`GEMINI_API_KEY`のSecret設定を確認してください。
  `firebase functions:secrets:access GEMINI_API_KEY` で登録済みの値を確認できます（表示されます、
  取り扱い注意）。
- 月次レポートが生成されない場合：`SYNC_DOC_ID`のSecretが正しいか確認してください。合言葉を
  変更した場合はこの値も更新が必要です。

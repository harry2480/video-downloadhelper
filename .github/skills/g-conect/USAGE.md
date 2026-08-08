# g-conect ラッパー使い方

リポジトリ直下に `bin/g-connect` を追加しました。端末からワンライナーで日本語の意図を渡すと、自動で `.github/skills/g-conect/run_skill.sh` に渡して処理します。

基本例:

```bash
# dry-run（コマンドを表示するだけ）
./bin/g-connect "チームみらい 入会 面談を検索"

# 生のスラッシュ付きでも受け付ける
./bin/g-connect "/g-connect チームみらい メール検索"

# 実行オプションは run_skill.sh 側に渡ります（例: --execute を付けて実行）
./bin/g-connect "チームみらい 添付を一覧表示" -- --execute
```

注意点:
- `bin/g-connect` は最初の引数が `/g-connect` または `g-connect` の場合それを取り除きます。
- 実際の Google API 呼び出しを行うには `gog` CLI と適切な認証設定が必要です。

トラブルシュート:
- `run_skill.sh` が存在しない場合、エラーメッセージを表示します。
- 必要に応じて `chmod +x .github/skills/g-conect/run_skill.sh` を実行してください。

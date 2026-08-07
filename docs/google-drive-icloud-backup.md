# Googleドライブ → iCloud 自動バックアップ セットアップ手順

毎日 **20時15分** に、Googleドライブのファイルを自動で iCloud Drive へ
バックアップする仕組みの設定手順です。

## 大事な前提

iCloud には外部のサービスから直接ファイルを保存する公式な仕組み（API）が
ありません。そのため、この自動バックアップは **先生の Mac 上で動きます**。

```
Googleドライブ（クラウド）
   ↓ 「Google ドライブ（パソコン版）」アプリが Mac に同期
Mac の中の Googleドライブフォルダ
   ↓ 毎日 20:15 に自動コピー（今回作った仕組み）
Mac の中の iCloud Drive フォルダ
   ↓ macOS が自動で iCloud へアップロード
iCloud（クラウド）
```

- **20:15 に Mac の電源が入っている必要があります**（スリープ・電源オフだとその時刻には動きません。次に Mac を起動／スリープ解除したときに、飛ばした分が自動で実行されます）。
- Googleドライブ側でファイルを削除しても、バックアップからは消しません（誤削除対策）。
- Googleドキュメント・スプレッドシート形式のファイルは「リンクファイル（.gdoc / .gsheet）」としてコピーされます。中身ごと残したい大事なものは、Googleドライブ上で PDF や Excel 形式でも保存しておくのがおすすめです。

## 設定手順（所要時間 約15分）

### ステップ1: Google ドライブ（パソコン版）をインストール

すでに Mac に Google ドライブアプリが入っている場合はステップ2へ。

1. https://www.google.com/intl/ja_jp/drive/download/ を開く
2. 「パソコン版ドライブをダウンロード」をクリックしてインストール
3. **kishimoto.karada.condition@gmail.com** でログイン
4. メニューバー（画面右上）のドライブのアイコン → 歯車 → 「設定」→「Google ドライブ」で
   **「ファイルをミラーリングする」** を選ぶのがおすすめ
   （ストリーミングのままでも動きますが、バックアップのたびにダウンロードが走るため遅くなります）

### ステップ2: iCloud Drive がオンになっているか確認

1. Appleメニュー → 「システム設定」→ 一番上の自分の名前 → 「iCloud」
2. 「iCloud Drive」がオンになっていることを確認

### ステップ3: 自動バックアップを登録

1. このリポジトリの `scripts/backup` フォルダを Mac にダウンロードする
   （GitHub のページから「Code」→「Download ZIP」でもOK）
2. 「ターミナル」アプリを開く（Launchpad で「ターミナル」と検索）
3. 次のように入力して Enter（`scripts/backup` フォルダの場所に合わせて読み替え）:

   ```
   cd ダウンロードしたフォルダ/scripts/backup
   bash install.sh
   ```

4. 「✅ セットアップ完了！」と表示されたら終わりです。
   その場で1回目のバックアップも実行されます。

### ステップ4: 確認

1. Finder のサイドバーから「iCloud Drive」を開く
2. 「**GoogleDriveバックアップ**」というフォルダができていて、
   中に Googleドライブのファイルが入っていればOK

## よくある質問

**Q. ちゃんと毎日動いているか確認したい**
Finder で「移動」→「フォルダへ移動」→ `~/Library/Logs/gdrive-icloud-backup.log` を開くと、
実行日時と結果が記録されています。

**Q. 失敗したらどうなる？**
Mac の画面右上に「Googleドライブ バックアップ失敗」という通知が出ます。
通知が出なければ正常に動いています。

**Q. 自動バックアップをやめたい**
ターミナルで次を実行してください:

```
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.kishimoto.gdrive-icloud-backup.plist
rm ~/Library/LaunchAgents/com.kishimoto.gdrive-icloud-backup.plist
```

**Q. 時刻を変えたい**
`install.sh` の中の `<integer>20</integer>`（時）と `<integer>15</integer>`（分）を
好きな時刻に書き換えて、もう一度 `bash install.sh` を実行してください。

**Q. iCloud の容量は足りる？**
バックアップは iCloud の容量を使います。Googleドライブの使用量（drive.google.com の
左下に表示）が iCloud の空き容量より大きい場合は、iCloud のプラン変更が必要です。

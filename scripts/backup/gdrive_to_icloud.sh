#!/bin/bash
# Googleドライブ → iCloud Drive 自動バックアップスクリプト
#
# 前提: Mac に「Google ドライブ（パソコン版）」がインストールされ、
#       マイドライブがミラーリング（またはストリーミング）されていること。
#
# 実行すると、Googleドライブの中身を iCloud Drive 内の
# 「GoogleDriveバックアップ」フォルダへコピー（同期）します。
# 誤削除からファイルを守るため、Googleドライブ側で消したファイルは
# バックアップからは削除しません（残り続けます）。

set -u

LOG_FILE="$HOME/Library/Logs/gdrive-icloud-backup.log"
DEST="$HOME/Library/Mobile Documents/com~apple~CloudDocs/GoogleDriveバックアップ"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

notify_error() {
  # 失敗したときは Mac の画面に通知を出す
  osascript -e "display notification \"$1\" with title \"Googleドライブ バックアップ失敗\"" 2>/dev/null
  log "エラー: $1"
  exit 1
}

mkdir -p "$(dirname "$LOG_FILE")"

# ログが大きくなりすぎたら古い分を削る（約5000行を超えたら半分にする）
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 5000 ]; then
  tail -n 2500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

log "===== バックアップ開始 ====="

# Google ドライブ（パソコン版）のマイドライブの場所を自動で探す
SRC=""
for dir in "$HOME/Library/CloudStorage"/GoogleDrive-*; do
  if [ -d "$dir/マイドライブ" ]; then
    SRC="$dir/マイドライブ"
    break
  elif [ -d "$dir/My Drive" ]; then
    SRC="$dir/My Drive"
    break
  fi
done

if [ -z "$SRC" ]; then
  notify_error "Google ドライブ（パソコン版）が見つかりません。アプリが起動しているか確認してください。"
fi

# iCloud Drive が使えるか確認
if [ ! -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
  notify_error "iCloud Drive が見つかりません。システム設定で iCloud Drive をオンにしてください。"
fi

mkdir -p "$DEST"

log "コピー元: $SRC"
log "コピー先: $DEST"

# rsync でコピー。
#   -a          : フォルダ構成・更新日時ごとそのままコピー
#   --update    : すでに同じ（か新しい）ファイルはスキップ＝差分だけコピーで速い
#   --exclude   : Macの管理ファイルや一時ファイルは除外
# --delete は付けない = Googleドライブで消してもバックアップには残る（誤削除対策）
rsync -a --update \
  --exclude '.DS_Store' \
  --exclude 'Icon?' \
  --exclude '.tmp.drivedownload*' \
  --exclude '.Trash*' \
  "$SRC/" "$DEST/" >> "$LOG_FILE" 2>&1

RESULT=$?
# rsync の 23/24 は「一部のファイルが使用中などでコピーできなかった」程度なので成功扱い
if [ $RESULT -ne 0 ] && [ $RESULT -ne 23 ] && [ $RESULT -ne 24 ]; then
  notify_error "コピー中にエラーが発生しました（コード: ${RESULT}）。詳細はログを確認してください。"
fi

COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
log "バックアップ完了（バックアップ内のファイル数: ${COUNT}）"
log "===== 終了 ====="
exit 0

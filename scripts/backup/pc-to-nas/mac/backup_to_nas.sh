#!/bin/bash
# Mac → NAS 自動バックアップスクリプト
#
# 毎日、下の「バックアップ対象フォルダ」を NAS の共有フォルダへコピーします。
# - 差分コピー（前回から変わったファイルだけ）なので2回目以降は速いです
# - 誤削除対策のため、Mac側で消したファイルも NAS からは削除しません
# - 失敗したときは Mac の画面右上に通知が出ます
#
# ※ 設定（NASの場所など）は install.sh 実行時に自動で書き換わります。

set -u

# ===================== 設定 =====================
# NAS のバックアップ用共有フォルダ（smb:// で始まるアドレス）
NAS_URL="smb://NAS/backup"

# バックアップするフォルダの一覧（必要に応じて追加・削除OK）
TARGETS=(
  "$HOME/Documents"
  "$HOME/Desktop"
  "$HOME/Pictures"
)
# ================================================

LOG_FILE="$HOME/Library/Logs/kishimoto-nas-backup.log"
SHARE_NAME="${NAS_URL##*/}"                 # smb://NAS/backup → backup
MOUNT_POINT="/Volumes/$SHARE_NAME"
PC_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

notify_error() {
  osascript -e "display notification \"$1\" with title \"NASバックアップ失敗\"" 2>/dev/null
  log "エラー: $1"
  exit 1
}

mkdir -p "$(dirname "$LOG_FILE")"

# ログが大きくなりすぎたら古い分を削る
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 5000 ]; then
  tail -n 2500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

log "===== バックアップ開始 ====="

# NAS がマウントされていなければ自動でマウントする
# （初回に Finder で接続して「パスワードをキーチェーンに保存」してあれば、パスワード入力なしで繋がります）
if [ ! -d "$MOUNT_POINT" ]; then
  log "NAS をマウントしています: $NAS_URL"
  osascript -e "mount volume \"$NAS_URL\"" >> "$LOG_FILE" 2>&1
  sleep 3
fi

if [ ! -d "$MOUNT_POINT" ]; then
  notify_error "NAS（$NAS_URL）に接続できません。NASの電源とネットワークを確認してください。"
fi

DEST="$MOUNT_POINT/$PC_NAME"
mkdir -p "$DEST" || notify_error "NAS上にフォルダを作成できません。共有フォルダの書き込み権限を確認してください。"

HAD_ERROR=0

for SRC in "${TARGETS[@]}"; do
  if [ ! -d "$SRC" ]; then
    log "スキップ: $SRC（フォルダがありません）"
    continue
  fi
  NAME="$(basename "$SRC")"
  log "コピー中: $SRC → $DEST/$NAME"

  # rsync:
  #   -a       : フォルダ構成・更新日時ごとコピー
  #   --update : NAS側が同じか新しいファイルはスキップ（差分コピー）
  #   --delete は付けない = Macで消してもNASには残る（誤削除対策）
  rsync -a --update \
    --exclude '.DS_Store' \
    --exclude 'Icon?' \
    --exclude '.Trash*' \
    --exclude '.localized' \
    --exclude 'node_modules' \
    "$SRC/" "$DEST/$NAME/" >> "$LOG_FILE" 2>&1

  RESULT=$?
  # rsync の 23/24 は「一部のファイルが使用中などでコピーできなかった」程度なので成功扱い
  if [ $RESULT -ne 0 ] && [ $RESULT -ne 23 ] && [ $RESULT -ne 24 ]; then
    HAD_ERROR=1
    log "エラー: $NAME のコピーに失敗（rsync コード: $RESULT）"
  else
    log "完了: $NAME"
  fi
done

if [ $HAD_ERROR -ne 0 ]; then
  notify_error "一部のフォルダのコピーに失敗しました。詳細はログを確認してください。"
fi

# NAS 側に「いつ成功したか」を残す
echo "最終バックアップ成功: $(date '+%Y-%m-%d %H:%M:%S')（$PC_NAME）" > "$DEST/_最終バックアップ日時.txt"

log "===== バックアップ完了 ====="
exit 0

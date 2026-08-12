#!/bin/sh
# NAS → クラウド 自動バックアップスクリプト（rclone 使用）
#
# Synology の Hyper Backup や QNAP の HBS 3 が使えない場合の汎用版です。
# NAS のタスクスケジューラ（cron）から毎晩実行してください。
# ※ 事前に NAS 上で rclone のインストールと「rclone config」での
#    クラウド接続設定（リモート名: cloud）が必要です。詳しくは
#    docs/backup-321-system.md の「方法C」を参照。
#
# 動きかた:
# - NAS のバックアップフォルダをクラウドへ同期（ミラー）します
# - クラウド側で消える・上書きされるファイルは、削除せずに
#   「アーカイブ/日付」フォルダへ退避します（誤削除・ランサムウェア対策）
# - アーカイブは90日たったら自動で削除します

set -u

# ===================== 設定 =====================
# NAS 上のバックアップフォルダ（各PCのデータが集まる場所）
SRC="/volume1/backup"

# rclone のリモート名とクラウド側のフォルダ
REMOTE="cloud:kishimoto-nas-backup"        # 本体（NASのミラー）
ARCHIVE_BASE="cloud:kishimoto-nas-archive" # 退避先（日付ごと）

# アーカイブを残す日数
KEEP_DAYS=90
# ================================================

TODAY="$(date +%Y-%m-%d)"
LOG_DIR="$SRC/.logs"
LOG_FILE="$LOG_DIR/rclone-$(date +%Y-%m).log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "===== クラウドへのバックアップ開始 ====="

# 同期（消えた・変わったファイルは ARCHIVE_BASE/日付 へ退避してから反映）
rclone sync "$SRC" "$REMOTE" \
  --backup-dir "$ARCHIVE_BASE/$TODAY" \
  --exclude "/.logs/**" \
  --exclude ".DS_Store" \
  --exclude "Thumbs.db" \
  --transfers 4 \
  --log-file "$LOG_FILE" \
  --log-level INFO

RESULT=$?
if [ $RESULT -ne 0 ]; then
  log "エラー: rclone sync が失敗しました（コード: ${RESULT}）"
  # NAS 上に失敗マーカーを残す（PCから見える場所なので気づける）
  echo "クラウドへのバックアップが失敗しています。日時: $(date '+%Y-%m-%d %H:%M')  詳細: $LOG_FILE" \
    > "$SRC/【要確認】クラウドバックアップ失敗.txt"
  exit 1
fi

# 成功したら失敗マーカーを片付ける
rm -f "$SRC/【要確認】クラウドバックアップ失敗.txt"

# 古いアーカイブ（KEEP_DAYS日より前の日付フォルダ）を削除
CUTOFF="$(date -d "-${KEEP_DAYS} days" +%Y-%m-%d 2>/dev/null || date -v-${KEEP_DAYS}d +%Y-%m-%d)"
rclone lsf "$ARCHIVE_BASE" --dirs-only 2>/dev/null | while read -r dir; do
  day="${dir%/}"
  # YYYY-MM-DD 形式のフォルダだけを対象にする
  case "$day" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      if [ "$day" \< "$CUTOFF" ]; then
        log "古いアーカイブを削除: $day"
        rclone purge "$ARCHIVE_BASE/$day" --log-file "$LOG_FILE" --log-level ERROR
      fi
      ;;
  esac
done

log "===== クラウドへのバックアップ完了 ====="
exit 0

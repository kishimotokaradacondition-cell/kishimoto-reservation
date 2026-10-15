#!/bin/bash
# 保存フォルダに取り込まれてしまった「取引書類ではないファイル」を片付けるスクリプト
#
# 初回の取り込みは「取りこぼすより多めに拾う」設定だったため、
# 給与明細・助成金の申請様式・会計マニュアルなど、電帳法の保存対象では
# ないファイルも混ざっています。これを保存フォルダから取り除きます。
#
# 安全のために:
#   - 削除ではなく「_対象外」フォルダへ移動します（あとから戻せます）
#   - 請求書・領収書とはっきり分かる名前のファイルは絶対に動かしません
#   - iCloud にある元のファイルには一切触れません
#
# 使い方:
#   bash cleanup_noise.sh              まず何が移動されるか一覧を見る（既定）
#   bash cleanup_noise.sh --apply      実際に移動する
#   bash cleanup_noise.sh --undo       移動したものを元の場所へ戻す
#
# 詳しい手順: リポジトリの docs/dencho-icloud-invoice.md を参照

set -u

APPLY=0
UNDO=0

ARCHIVE_NAME="電子帳簿保存（電子取引データ）"
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
STATE_DIR="$HOME/Library/Application Support/kishimoto-dencho"
MOVED_LOG="$STATE_DIR/moved_to_taishougai.tsv"
LOG_FILE="$HOME/Library/Logs/dencho-icloud-collect.log"

# 取引書類ではないもの。icloud_invoice_collect.sh と同じ基準にそろえています
EXCLUDE_KEYWORDS="給与明細 賞与明細 助成金 支給申請 支給要件 申立書 実績報告 事業実績 様式 要領 リスキリング 決算 申告書 残高一覧 推移補助 試算表 法人税 マニュアル 説明書 手引 契約書 規則 規程 協定 日計レポート 統計ナビ メール分析 問題集 協会情報"

# これらを含むファイルは、上に当てはまっても動かさない（保存漏れを防ぐ）
KEEP_KEYWORDS="請求書 御請求 領収 レシート 支払明細 利用明細 納品書 見積書"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --undo)  UNDO=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "不明なオプション: $1"; exit 1 ;;
  esac
done

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# ── 保存フォルダの場所を探す（取り込みスクリプトと同じ判定）
DEST_ROOT=""
for dir in "$HOME/Library/CloudStorage"/GoogleDrive-*; do
  if [ -d "$dir/マイドライブ/$ARCHIVE_NAME" ]; then DEST_ROOT="$dir/マイドライブ/$ARCHIVE_NAME"; break; fi
  if [ -d "$dir/My Drive/$ARCHIVE_NAME" ];     then DEST_ROOT="$dir/My Drive/$ARCHIVE_NAME";     break; fi
done
[ -z "$DEST_ROOT" ] && [ -d "$ICLOUD/$ARCHIVE_NAME" ] && DEST_ROOT="$ICLOUD/$ARCHIVE_NAME"

if [ -z "$DEST_ROOT" ]; then
  echo "保存フォルダ「$ARCHIVE_NAME」が見つかりません。先に取り込みを実行してください。"
  exit 1
fi

QUARANTINE="$DEST_ROOT/_対象外"

# ───────────────────────────────────────────────
# 元に戻す
# ───────────────────────────────────────────────
if [ $UNDO -eq 1 ]; then
  if [ ! -s "$MOVED_LOG" ]; then
    echo "戻せる記録がありません（$MOVED_LOG）"
    exit 0
  fi
  restored=0
  while IFS="	" read -r from to; do
    [ -n "${from:-}" ] && [ -n "${to:-}" ] || continue
    if [ -f "$to" ]; then
      mkdir -p "$(dirname "$from")"
      mv "$to" "$from" && restored=$((restored + 1))
    fi
  done < "$MOVED_LOG"
  : > "$MOVED_LOG"
  log "元に戻しました: ${restored}件"
  exit 0
fi

# ───────────────────────────────────────────────
# 仕分け
# ───────────────────────────────────────────────
[ $APPLY -eq 1 ] && log "===== 対象外ファイルの片付け開始 =====" \
                 || echo "【お試し表示】実際には移動しません。移動するには --apply を付けてください。"
echo ""

MOVED=0
KEPT=0
SCANNED=0

for side in 受領 発行; do
  [ -d "$DEST_ROOT/$side" ] || continue

  # 年フォルダの中のファイルだけを見る（_対象外 フォルダは対象にしない）
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    SCANNED=$((SCANNED + 1))
    name="$(basename "$file")"

    keep=0
    for kw in $KEEP_KEYWORDS; do
      case "$name" in *"$kw"*) keep=1; break ;; esac
    done
    if [ $keep -eq 1 ]; then
      KEPT=$((KEPT + 1))
      continue
    fi

    hit=""
    for kw in $EXCLUDE_KEYWORDS; do
      case "$name" in *"$kw"*) hit="$kw"; break ;; esac
    done
    [ -n "$hit" ] || continue

    if [ $APPLY -eq 0 ]; then
      echo "  [移動対象/$hit] $side/$(basename "$(dirname "$file")")/$name"
      MOVED=$((MOVED + 1))
      continue
    fi

    year="$(basename "$(dirname "$file")")"
    target_dir="$QUARANTINE/$side/$year"
    mkdir -p "$target_dir"

    target="$target_dir/$name"
    # 同名があれば連番を付けて退避する（上書きしない）
    n=2
    while [ -e "$target" ]; do
      target="$target_dir/${name%.*}_$n.${name##*.}"
      n=$((n + 1))
    done

    if mv "$file" "$target"; then
      printf '%s\t%s\n' "$file" "$target" >> "$MOVED_LOG"
      MOVED=$((MOVED + 1))
    else
      log "移動に失敗しました: $file"
    fi
  done <<EOF
$(find "$DEST_ROOT/$side" -type f -not -path "$QUARANTINE/*" -not -name '.*' 2>/dev/null)
EOF
done

echo ""
if [ $APPLY -eq 0 ]; then
  echo "確認した件数: ${SCANNED}件 / 移動対象: ${MOVED}件 / 請求書・領収書として保護: ${KEPT}件"
  echo ""
  echo "この内容でよければ、次を実行してください:"
  echo "  bash cleanup_noise.sh --apply"
else
  log "片付け完了: ${MOVED}件を「_対象外」へ移動（保護して残した分: ${KEPT}件 / 確認: ${SCANNED}件）"
  log "移動先: $QUARANTINE"
  echo ""
  echo "中身を確認して問題なければ、Finder で「_対象外」フォルダごとゴミ箱に入れてください。"
  echo "戻したい場合は: bash cleanup_noise.sh --undo"
  osascript -e "display notification \"${MOVED}件を「_対象外」へ移動しました\" with title \"保存フォルダを整理しました\"" 2>/dev/null
fi
exit 0

#!/bin/bash
# iCloud Drive の中から請求書・領収書を拾い出して、電帳法の保存フォルダへ集めるスクリプト
#
# 前提: 先生の Mac 上で実行します（iCloud には外部から直接アクセスする方法がないため）。
#
# やること
#   1. iCloud Drive の中を Spotlight とファイル名で検索し、請求書・領収書らしいファイルを探す
#   2. 2024年1月1日以降のもの（電帳法の義務化以降）だけに絞る
#   3. PDFの中身から「取引年月日・取引先・金額」を下読みする
#   4. 「日付_取引先_金額」の形にファイル名をそろえて保存フォルダへコピーする
#   5. 一覧をCSVに書き出す（索引簿に貼り付けて使う）
#
# 元のファイルは移動も削除もしません。コピーするだけです。
#
# 使い方:
#   bash icloud_invoice_collect.sh                    実際にコピーする
#   bash icloud_invoice_collect.sh --dry-run          何が対象になるか一覧を見るだけ
#   bash icloud_invoice_collect.sh --since 2023-01-01 さかのぼる開始日を変える
#
# 詳しい手順: リポジトリの docs/dencho-icloud-invoice.md を参照

set -u

# ───────────────────────────────────────────────
# 設定
# ───────────────────────────────────────────────
SINCE="2024-01-01"                       # ここより古いものは対象外
DRY_RUN=0

ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
ARCHIVE_NAME="電子帳簿保存（電子取引データ）"
STATE_DIR="$HOME/Library/Application Support/kishimoto-dencho"
STATE_FILE="$STATE_DIR/collected.tsv"
LOG_FILE="$HOME/Library/Logs/dencho-icloud-collect.log"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PDF_META="$SCRIPT_DIR/pdf_meta.py"

# 探すファイルの拡張子（大文字小文字は区別しません）
EXTENSIONS="pdf jpg jpeg png heic"

# 請求書・領収書らしさを示す言葉（ファイル名・フォルダ名・PDFの中身）
KEYWORDS="請求書 請求 御請求 領収書 領収 レシート 明細書 利用明細 invoice receipt"

# 検索から除外するフォルダ名（この仕組み自身が作ったコピーを拾い直さないため）
EXCLUDE_DIRS="$ARCHIVE_NAME GoogleDriveバックアップ .Trash"

# ───────────────────────────────────────────────
# 引数
# ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --since)   SINCE="${2:-$SINCE}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "不明なオプション: $1"; exit 1 ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")" "$STATE_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

notify_error() {
  osascript -e "display notification \"$1\" with title \"請求書の取り込み失敗\"" 2>/dev/null
  log "エラー: $1"
  exit 1
}

# ログが大きくなりすぎたら古い分を削る
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 5000 ]; then
  tail -n 2500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

MODE_LABEL=""
[ $DRY_RUN -eq 1 ] && MODE_LABEL="（お試し実行・コピーしません）"
log "===== iCloud請求書の取り込み開始 ${SINCE}以降 ${MODE_LABEL} ====="

[ -d "$ICLOUD" ] || notify_error "iCloud Drive が見つかりません。システム設定で iCloud Drive をオンにしてください。"

SINCE_EPOCH=$(date -j -f "%Y-%m-%d" "$SINCE" "+%s" 2>/dev/null) \
  || notify_error "--since の日付が正しくありません（例: 2024-01-01）"

# ───────────────────────────────────────────────
# 保存先を決める
# Googleドライブ（パソコン版）があればそこへ置く。そうすれば Google ドライブへ
# 自動同期され、GAS側の索引簿にもそのまま取り込めます。
# ───────────────────────────────────────────────
DEST_ROOT=""
for dir in "$HOME/Library/CloudStorage"/GoogleDrive-*; do
  if [ -d "$dir/マイドライブ" ]; then DEST_ROOT="$dir/マイドライブ/$ARCHIVE_NAME"; break; fi
  if [ -d "$dir/My Drive" ];     then DEST_ROOT="$dir/My Drive/$ARCHIVE_NAME";     break; fi
done
if [ -z "$DEST_ROOT" ]; then
  DEST_ROOT="$ICLOUD/$ARCHIVE_NAME"
  log "Googleドライブ（パソコン版）が見つからないため、iCloud内に保存します: $DEST_ROOT"
else
  log "保存先: $DEST_ROOT（Googleドライブへ自動同期されます）"
fi

REPORT="$DEST_ROOT/iCloud取り込み一覧.csv"

# ───────────────────────────────────────────────
# 小道具
#   日本語のファイル名を壊さないよう、文字の置き換えはシェルの機能で行い、
#   tr や sed に多バイト文字を渡さないようにしています。
# ───────────────────────────────────────────────

# iCloudにまだ実体が無いファイルを取り寄せる
ensure_downloaded() {
  local path="$1" dir base placeholder waited=0
  [ -s "$path" ] && return 0

  dir="$(dirname "$path")"
  base="$(basename "$path")"
  placeholder="$dir/.$base.icloud"
  [ -e "$placeholder" ] || [ -e "$path" ] || return 1

  brctl download "$path" >/dev/null 2>&1
  while [ ! -s "$path" ] && [ $waited -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  [ -s "$path" ]
}

# 「.請求書.pdf.icloud」という置き換えファイル名を、本来の「請求書.pdf」に戻す
resolve_placeholder() {
  local path="$1" dir base
  base="$(basename "$path")"
  case "$base" in
    .*.icloud)
      dir="$(dirname "$path")"
      base="${base#.}"
      base="${base%.icloud}"
      printf '%s' "$dir/$base"
      ;;
    *) printf '%s' "$path" ;;
  esac
}

# 年月日の漢字を区切り記号に置き換えて、ASCIIだけで日付を探せるようにする
normalize_digits() {
  local s="$1"
  s="${s//年/-}"; s="${s//月/-}"; s="${s//日/-}"
  printf '%s' "$s"
}

# ファイル名から取引年月日（YYYY-MM-DD）を取り出す
date_from_name() {
  local flat hit
  flat="$(normalize_digits "$1")"

  hit=$(printf '%s' "$flat" | grep -oE '20[0-9]{2}[-_/.]?[0-1][0-9][-_/.]?[0-3][0-9]' | head -1)
  hit="$(printf '%s' "$hit" | tr -cd '0-9')"
  if [ ${#hit} -eq 8 ]; then
    printf '%s-%s-%s' "${hit:0:4}" "${hit:4:2}" "${hit:6:2}"
    return 0
  fi

  # 「202607」「2026-7」のように月までしか無い場合は、その月の1日とみなす
  hit=$(printf '%s' "$flat" | grep -oE '20[0-9]{2}[-_/.]?[0-1]?[0-9]([^0-9]|$)' | head -1)
  hit="$(printf '%s' "$hit" | tr -cd '0-9')"
  if [ ${#hit} -eq 6 ]; then
    printf '%s-%s-01' "${hit:0:4}" "${hit:4:2}"
    return 0
  elif [ ${#hit} -eq 5 ]; then
    printf '%s-0%s-01' "${hit:0:4}" "${hit:4:1}"
    return 0
  fi
  printf ''
}

# ファイル名から金額を取り出す（「11,000円」など）
amount_from_name() {
  local s="$1"
  s="${s//円/JPY}"
  printf '%s' "$s" | grep -oE '[0-9][0-9,]*JPY' | head -1 | tr -cd '0-9'
}

# ファイル名から取引先を取り出す（「やわらぎ様　請求書.pdf」→「やわらぎ」）
vendor_from_name() {
  local s="$1" head=""
  case "$s" in
    *御中*) head="${s%%御中*}" ;;
    *様*)   head="${s%%様*}" ;;
    *)      printf ''; return 0 ;;
  esac
  # 区切り記号や空白で終わっている場合は落とす
  head="${head%%_*}"
  head="${head// /}"
  head="${head//　/}"
  printf '%s' "$head"
}

# ファイル名に使えない文字と空白を整理する
sanitize() {
  local s="$1"
  s="${s//　/_}"
  s="${s// /_}"
  s="$(printf '%s' "$s" | tr -d '/\\:*?"<>|')"
  while :; do
    case "$s" in *__*) s="${s//__/_}" ;; *) break ;; esac
  done
  s="${s#_}"; s="${s%_}"
  printf '%s' "$s"
}

csv_escape() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

# ───────────────────────────────────────────────
# 候補ファイルを集める
# ───────────────────────────────────────────────
TMP_DIR="$(mktemp -d -t dencho)"
trap 'rm -rf "$TMP_DIR"' EXIT
SPOTLIGHT_HITS="$TMP_DIR/spotlight.txt"
CANDIDATES="$TMP_DIR/candidates.txt"

# ① Spotlight でファイル名と PDF の中身を検索する（中身まで見るので取りこぼしが少ない）
MDQUERY=""
for kw in $KEYWORDS; do
  [ -n "$MDQUERY" ] && MDQUERY="$MDQUERY || "
  MDQUERY="$MDQUERY(kMDItemDisplayName == '*${kw}*'cd) || (kMDItemTextContent == '*${kw}*'cd)"
done
mdfind -onlyin "$ICLOUD" "$MDQUERY" 2>/dev/null | sort -u > "$SPOTLIGHT_HITS"
log "Spotlight検索: $(wc -l < "$SPOTLIGHT_HITS" | tr -d ' ')件ヒット"

# ② Spotlightの索引が効いていない場合に備えて、ファイル名でも直接探す
FIND_EXPR=()
for ext in $EXTENSIONS; do
  if [ ${#FIND_EXPR[@]} -eq 0 ]; then
    FIND_EXPR=(-iname "*.$ext")
  else
    FIND_EXPR+=(-o -iname "*.$ext")
  fi
done

{
  cat "$SPOTLIGHT_HITS"
  find "$ICLOUD" -type f \( "${FIND_EXPR[@]}" \) -print 2>/dev/null
  find "$ICLOUD" -type f -name '.*.icloud' -print 2>/dev/null
} | sort -u > "$CANDIDATES"
log "候補ファイル: $(wc -l < "$CANDIDATES" | tr -d ' ')件（重複除去後）"

# ───────────────────────────────────────────────
# CSVと記録ファイルの準備
# ───────────────────────────────────────────────
if [ $DRY_RUN -eq 0 ]; then
  mkdir -p "$DEST_ROOT"
  if [ ! -f "$REPORT" ]; then
    # 先頭のBOMは Excel / Numbers で文字化けしないようにするため
    printf '\xEF\xBB\xBF' > "$REPORT"
    echo "取り込み日時,取引年月日,取引先,金額,通貨,区分,書類種別,保存ファイル名,保存先,元のファイルの場所,要確認,備考" >> "$REPORT"
  fi
  [ -f "$STATE_FILE" ] || : > "$STATE_FILE"
fi

COPIED=0
SKIPPED=0
REVIEW=0

# ───────────────────────────────────────────────
# 1件ずつ処理
# ───────────────────────────────────────────────
while IFS= read -r raw; do
  [ -n "$raw" ] || continue

  path="$(resolve_placeholder "$raw")"
  name="$(basename "$path")"
  parent="$(dirname "$path")"

  # 除外フォルダの中は見ない
  skip=0
  for ex in $EXCLUDE_DIRS; do
    case "$path" in *"/$ex/"*) skip=1; break ;; esac
  done
  [ $skip -eq 1 ] && continue

  # 対象の拡張子か
  ext="$(printf '%s' "${name##*.}" | tr 'A-Z' 'a-z')"
  case " $EXTENSIONS " in *" $ext "*) ;; *) continue ;; esac

  # 請求書らしさ: ファイル名かフォルダ名にキーワードがあるか、Spotlightが中身で拾ったもの
  looks_like=0
  for kw in $KEYWORDS; do
    case "$name$parent" in *"$kw"*) looks_like=1; break ;; esac
  done
  if [ $looks_like -eq 0 ] && ! grep -qxF "$raw" "$SPOTLIGHT_HITS"; then
    continue
  fi

  # 取り込み済みなら飛ばす
  if [ $DRY_RUN -eq 0 ] && grep -qF "	$path" "$STATE_FILE" 2>/dev/null; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if ! ensure_downloaded "$path"; then
    log "スキップ（iCloudからダウンロードできませんでした）: $path"
    continue
  fi
  [ -f "$path" ] || continue

  file_birth=$(stat -f '%B' "$path" 2>/dev/null || echo 0)
  file_mtime=$(stat -f '%m' "$path" 2>/dev/null || echo 0)

  # ── PDFの中身を下読みする
  meta_date=""; meta_vendor=""; meta_amount=""; meta_currency=""; meta_type=""
  if [ "$ext" = "pdf" ] && [ -f "$PDF_META" ]; then
    if meta="$(/usr/bin/python3 "$PDF_META" "$path" 2>/dev/null)" && [ -n "$meta" ]; then
      meta_date="$(printf '%s' "$meta" | cut -f1)"
      meta_vendor="$(printf '%s' "$meta" | cut -f2)"
      meta_amount="$(printf '%s' "$meta" | cut -f3)"
      meta_currency="$(printf '%s' "$meta" | cut -f4)"
      meta_type="$(printf '%s' "$meta" | cut -f5)"
    fi
  fi

  # ── 取引年月日: ファイル名 → PDF本文 → ファイルの作成日 の順で採用する
  name_date="$(date_from_name "$name")"
  txn_date="$name_date"
  [ -z "$txn_date" ] && txn_date="$meta_date"
  [ -z "$txn_date" ] && txn_date="$(date -r "$file_birth" '+%Y-%m-%d' 2>/dev/null)"
  [ -z "$txn_date" ] && txn_date="$(date -r "$file_mtime" '+%Y-%m-%d' 2>/dev/null)"
  [ -z "$txn_date" ] && txn_date="$(date '+%Y-%m-%d')"

  # ── 期間の絞り込み。取りこぼしを避けるため、どれか1つでも期間内なら対象にする
  txn_epoch=$(date -j -f '%Y-%m-%d' "$txn_date" '+%s' 2>/dev/null || echo 0)
  in_range=0
  for candidate_epoch in "$txn_epoch" "$file_birth" "$file_mtime"; do
    case "$candidate_epoch" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$candidate_epoch" -ge "$SINCE_EPOCH" ]; then in_range=1; break; fi
  done
  [ $in_range -eq 0 ] && continue

  # ── 取引先
  vendor="$(vendor_from_name "$name")"
  [ -z "$vendor" ] && vendor="$meta_vendor"
  [ -z "$vendor" ] && vendor="未設定"

  # ── 金額
  amount="$(amount_from_name "$name")"
  currency="JPY"
  if [ -z "$amount" ]; then
    amount="$meta_amount"
    [ -n "$meta_currency" ] && currency="$meta_currency"
  fi
  [ -z "$amount" ] && currency=""

  # ── 書類種別
  doc_type="$meta_type"
  if [ -z "$doc_type" ]; then
    case "$name$parent" in
      *領収*|*レシート*|*eceipt*) doc_type="領収書" ;;
      *明細*|*tatement*)          doc_type="明細書" ;;
      *)                          doc_type="請求書" ;;
    esac
  fi

  # ── 受領か発行か。「〇〇様」「〇〇御中」宛のファイルは自分が出した分とみなす
  case "$name" in
    *様*|*御中*) side="発行" ;;
    *)           side="受領" ;;
  esac

  # ── 要確認の判定（自動で読めなかったものは必ず人の目で確認する）
  review=""
  notes=""
  if [ -z "$amount" ]; then
    review="要確認"; notes="金額を自動で読み取れませんでした"
  fi
  if [ "$vendor" = "未設定" ]; then
    review="要確認"; notes="${notes:+$notes / }取引先を自動で読み取れませんでした"
  fi
  if [ -z "$name_date" ] && [ -z "$meta_date" ]; then
    review="要確認"; notes="${notes:+$notes / }取引年月日はファイルの作成日で代用しています"
  fi
  if [ "$side" = "発行" ]; then
    notes="${notes:+$notes / }宛名があるため発行分と判定しました"
  fi

  # ── 保存先とファイル名
  year="${txn_date%%-*}"
  dest_dir="$DEST_ROOT/$side/$year"
  if [ -n "$amount" ] && [ "$currency" = "USD" ]; then
    amount_label="${amount}USD"
  elif [ -n "$amount" ]; then
    amount_label="${amount}円"
  else
    amount_label="金額未確認"
  fi
  base_no_ext="${name%.*}"
  new_name="${txn_date//-/}_$(sanitize "$vendor")_${amount_label}_$(sanitize "$base_no_ext").$ext"
  # ファイル名が長くなりすぎたら元の名前の部分を削る
  if [ ${#new_name} -gt 180 ]; then
    new_name="${txn_date//-/}_$(sanitize "$vendor")_${amount_label}.$ext"
  fi

  if [ $DRY_RUN -eq 1 ]; then
    echo "  [対象] $txn_date  $vendor  ${amount:-金額未確認}  [$side/$doc_type]  ← $path"
    COPIED=$((COPIED + 1))
    [ -n "$review" ] && REVIEW=$((REVIEW + 1))
    continue
  fi

  mkdir -p "$dest_dir"
  if [ -e "$dest_dir/$new_name" ]; then
    log "スキップ（保存先に同名のファイルがあります）: $new_name"
    printf '%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$path" >> "$STATE_FILE"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if ! cp -p "$path" "$dest_dir/$new_name" 2>>"$LOG_FILE"; then
    log "コピーに失敗しました: $path"
    continue
  fi

  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$(csv_escape "$(date '+%Y-%m-%d %H:%M')")" \
    "$(csv_escape "$txn_date")" \
    "$(csv_escape "$vendor")" \
    "$(csv_escape "$amount")" \
    "$(csv_escape "$currency")" \
    "$(csv_escape "$side")" \
    "$(csv_escape "$doc_type")" \
    "$(csv_escape "$new_name")" \
    "$(csv_escape "$dest_dir")" \
    "$(csv_escape "$path")" \
    "$(csv_escape "$review")" \
    "$(csv_escape "$notes")" >> "$REPORT"

  printf '%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$path" >> "$STATE_FILE"

  COPIED=$((COPIED + 1))
  [ -n "$review" ] && REVIEW=$((REVIEW + 1))
  log "保存: $side/$year/$new_name"
done < "$CANDIDATES"

# ───────────────────────────────────────────────
# 結果
# ───────────────────────────────────────────────
log "-----"
if [ $DRY_RUN -eq 1 ]; then
  log "お試し実行のためコピーしていません。対象: ${COPIED}件（うち要確認 ${REVIEW}件）"
else
  log "取り込み完了: ${COPIED}件（うち要確認 ${REVIEW}件） / 取り込み済みのため飛ばした分: ${SKIPPED}件"
  log "一覧: $REPORT"
  if [ $COPIED -gt 0 ]; then
    osascript -e "display notification \"${COPIED}件を保存しました（要確認 ${REVIEW}件）\" with title \"iCloudの請求書を取り込みました\"" 2>/dev/null
  fi
fi
log "===== 終了 ====="
exit 0

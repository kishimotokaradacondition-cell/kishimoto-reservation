#!/bin/bash
# Mac → NAS 自動バックアップのセットアップスクリプト
#
# 使い方: 先に Finder で NAS に接続しておき、ターミナルで
#   bash install.sh
# を実行するだけです。接続中の NAS フォルダを自動で見つけるので、
# 番号を選ぶだけでセットアップできます。
#
# これで毎日 20:00 に自動バックアップが動きます。

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/kishimoto-backup"
PLIST_LABEL="com.kishimoto.nas-backup"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
RUN_HOUR=20
RUN_MINUTE=0

echo ""
echo "=== Mac → NAS 自動バックアップ セットアップ ==="
echo ""

# --- 1. 接続中の NAS（SMB共有）を自動で探す ---
NAS_URL=""
MOUNT_POINT=""
N=0

while IFS= read -r line; do
  [ -z "$line" ] && continue
  dev="${line%% on *}"                # //user@192.168.x.x/share
  rest="${line#* on }"
  mp="${rest%% (*}"                   # /Volumes/共有フォルダ名
  hostshare="${dev#//}"
  hostshare="${hostshare#*@}"         # user@ を取り除く
  URLS[$N]="smb://$hostshare"
  POINTS[$N]="$mp"
  N=$((N + 1))
done <<MOUNTS
$(mount | grep ' (smbfs' || true)
MOUNTS

if [ "$N" -gt 0 ]; then
  echo "接続中の NAS フォルダが見つかりました:"
  i=0
  while [ "$i" -lt "$N" ]; do
    echo "  $((i + 1))) ${POINTS[$i]#/Volumes/}"
    i=$((i + 1))
  done
  echo ""
  printf "バックアップの保存先にするフォルダの番号を入力して Enter（半角数字）: "
  read -r CHOICE
  case "$CHOICE" in
    *[!0-9]*|"")
      echo "半角数字で番号を入力してください。もう一度 bash install.sh からやり直してください。"
      exit 1 ;;
  esac
  if [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt "$N" ]; then
    echo "1〜$N の番号を入力してください。もう一度 bash install.sh からやり直してください。"
    exit 1
  fi
  NAS_URL="${URLS[$((CHOICE - 1))]}"
  MOUNT_POINT="${POINTS[$((CHOICE - 1))]}"
  echo "選択: ${MOUNT_POINT#/Volumes/}"
else
  # --- 見つからなければ手入力（全角文字は自動で直す） ---
  echo "接続中の NAS が見つかりませんでした。"
  echo "（Finder の「移動」→「サーバへ接続」で NAS に接続してから実行すると、この入力は不要になります）"
  echo ""
  printf "NAS のアドレスを入力してください（例: smb://192.168.1.10/backup）: "
  read -r NAS_URL
  # 日本語入力で全角になりがちな文字を半角に直し、前後の空白を取り除く
  NAS_URL="$(printf '%s' "$NAS_URL" \
    | sed -e 's|／|/|g' -e 's|：|:|g' -e 's|ｓｍｂ|smb|g' \
          -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  NAS_URL="${NAS_URL%/}"
  case "$NAS_URL" in
    smb://*/*) ;;
    smb://*)
      echo ""
      echo "⚠ 共有フォルダ名まで含めて入力してください。"
      echo "  「smb://NASのアドレス/共有フォルダ名」の形です（例: smb://192.168.1.10/backup）"
      exit 1 ;;
    *)
      echo "アドレスは smb:// で始めてください（例: smb://192.168.1.10/backup）"
      exit 1 ;;
  esac
fi

# --- 2. スクリプトを配置（NASの情報を書き込んでからコピー） ---
echo ""
echo "1/3 バックアップスクリプトを配置しています..."
mkdir -p "$INSTALL_DIR"
sed -e "s|^NAS_URL=.*|NAS_URL=\"$NAS_URL\"|" \
    -e "s|^MOUNT_POINT=.*|MOUNT_POINT=\"$MOUNT_POINT\"|" \
    "$SCRIPT_DIR/backup_to_nas.sh" > "$INSTALL_DIR/backup_to_nas.sh"
chmod +x "$INSTALL_DIR/backup_to_nas.sh"

# --- 3. 毎日の自動実行を登録 ---
echo "2/3 毎日 ${RUN_HOUR}:$(printf '%02d' $RUN_MINUTE) の自動実行を登録しています..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$INSTALL_DIR/backup_to_nas.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>$RUN_HOUR</integer>
        <key>Minute</key>
        <integer>$RUN_MINUTE</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/$PLIST_LABEL.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/$PLIST_LABEL.err</string>
</dict>
</plist>
PLIST

# すでに登録済みなら一度解除してから登録し直す
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

# --- 4. 1回目を今すぐ実行 ---
echo "3/3 動作確認のため、1回目のバックアップを今すぐ実行します..."
echo "    （ファイルが多い場合、初回は時間がかかります。そのままお待ちください）"
if bash "$INSTALL_DIR/backup_to_nas.sh"; then
  echo ""
  echo "✅ セットアップ完了！"
  echo "   今後は毎日 ${RUN_HOUR}:$(printf '%02d' $RUN_MINUTE) に自動でバックアップされます。"
  echo "   保存先: NAS の「PCバックアップ」フォルダ > このMacの名前のフォルダ"
  echo "   ログ:   ~/Library/Logs/kishimoto-nas-backup.log"
  echo ""
  echo "【重要・1回だけ】自動実行が書類などを読めるように、次の設定をしてください:"
  echo "   システム設定 → プライバシーとセキュリティ → フルディスクアクセス → 「＋」"
  echo "   → Command+Shift+G を押して /bin/bash と入力 → 「bash」を追加してオンにする"
else
  echo ""
  echo "⚠ 1回目のバックアップでエラーが出ました（毎日の自動実行の登録は済んでいます）。"
  echo "  次のコマンドでログの最後の部分を確認できます:"
  echo "    tail -20 ~/Library/Logs/kishimoto-nas-backup.log"
  exit 1
fi

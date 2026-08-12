#!/bin/bash
# Mac → NAS 自動バックアップのセットアップスクリプト
#
# 使い方: ターミナルでこのファイルのあるフォルダに移動して
#   bash install.sh
# を実行するだけです。NAS のアドレスを聞かれるので入力してください。
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
printf "NAS のバックアップ用共有フォルダのアドレスを入力してください（例: smb://NAS/backup）: "
read -r NAS_URL

if [ -z "$NAS_URL" ]; then
  echo "アドレスが入力されませんでした。もう一度やり直してください。"
  exit 1
fi

case "$NAS_URL" in
  smb://*/*) ;;
  smb://*)
    echo ""
    echo "⚠ 共有フォルダ名まで含めて入力してください。"
    echo "  「smb://NASのアドレス/共有フォルダ名」の形です（例: smb://192.168.42.100/backup）"
    echo "  共有フォルダ名は、Finder のサイドバーで NAS を選ぶと表示されるフォルダの名前です。"
    exit 1 ;;
  *) echo "アドレスは smb:// で始めてください（例: smb://NAS/backup）"; exit 1 ;;
esac
# 末尾の / は取り除く
NAS_URL="${NAS_URL%/}"

echo "1/3 バックアップスクリプトを配置しています..."
mkdir -p "$INSTALL_DIR"
sed "s|^NAS_URL=.*|NAS_URL=\"$NAS_URL\"|" "$SCRIPT_DIR/backup_to_nas.sh" > "$INSTALL_DIR/backup_to_nas.sh"
chmod +x "$INSTALL_DIR/backup_to_nas.sh"

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

echo "3/3 動作確認のため、1回目のバックアップを今すぐ実行します..."
echo "    （NASのパスワードを聞かれたら入力し、「このパスワードをキーチェーンに保存」にチェックを入れてください）"
bash "$INSTALL_DIR/backup_to_nas.sh"

echo ""
echo "✅ セットアップ完了！"
echo "   今後は毎日 ${RUN_HOUR}:$(printf '%02d' $RUN_MINUTE) に自動でバックアップされます。"
echo "   保存先: NAS の共有フォルダ > このMacの名前のフォルダ"
echo "   ログ:   ~/Library/Logs/kishimoto-nas-backup.log"

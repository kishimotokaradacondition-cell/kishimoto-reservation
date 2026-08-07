#!/bin/bash
# バックアップの自動実行（毎日20:15）をセットアップするスクリプト
#
# 使い方: ターミナルでこのファイルのあるフォルダに移動して
#   bash install.sh
# を実行するだけです。

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/kishimoto-backup"
PLIST_LABEL="com.kishimoto.gdrive-icloud-backup"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

echo "1/3 バックアップスクリプトを配置しています..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/gdrive_to_icloud.sh" "$INSTALL_DIR/gdrive_to_icloud.sh"
chmod +x "$INSTALL_DIR/gdrive_to_icloud.sh"

echo "2/3 毎日20:15の自動実行を登録しています..."
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
        <string>$INSTALL_DIR/gdrive_to_icloud.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>20</integer>
        <key>Minute</key>
        <integer>15</integer>
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
bash "$INSTALL_DIR/gdrive_to_icloud.sh"

echo ""
echo "✅ セットアップ完了！"
echo "   今後は毎日 20:15 に自動でバックアップされます。"
echo "   保存先: iCloud Drive > GoogleDriveバックアップ"
echo "   ログ:   ~/Library/Logs/gdrive-icloud-backup.log"

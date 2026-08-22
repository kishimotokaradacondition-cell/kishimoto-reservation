#!/bin/bash
# iCloudの請求書取り込みを自動実行（毎日20:45）するようセットアップするスクリプト
#
# 使い方: ターミナルでこのファイルのあるフォルダに移動して
#   bash install.sh
# を実行するだけです。
#
# 20:45 にしているのは、Googleドライブ→iCloudのバックアップ（20:15）が
# 終わったあとに動かすためです。

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/kishimoto-dencho"
PLIST_LABEL="com.kishimoto.dencho-icloud-collect"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

echo "1/4 スクリプトを配置しています..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/icloud_invoice_collect.sh" "$INSTALL_DIR/icloud_invoice_collect.sh"
cp "$SCRIPT_DIR/pdf_meta.js" "$INSTALL_DIR/pdf_meta.js"
rm -f "$INSTALL_DIR/pdf_meta.py"   # 旧版の残りがあれば片付ける
chmod +x "$INSTALL_DIR/icloud_invoice_collect.sh"

echo "2/4 PDFの読み取り機能が使えるか確認しています..."
if osascript -l JavaScript -e "ObjC.import('Quartz'); ''" >/dev/null 2>&1; then
  echo "    → 使えます（PDFの中身から日付・金額・取引先を読み取ります）"
else
  echo "    → 使えません。ファイル名からの読み取りのみになります。"
fi

echo "3/4 毎日20:45の自動実行を登録しています..."
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
        <string>$INSTALL_DIR/icloud_invoice_collect.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>20</integer>
        <key>Minute</key>
        <integer>45</integer>
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

echo "4/4 まず「お試し実行」で、何が取り込まれるか確認します..."
echo ""
bash "$INSTALL_DIR/icloud_invoice_collect.sh" --dry-run

echo ""
echo "✅ セットアップ完了！"
echo ""
echo "   上の一覧が正しそうなら、次を実行して実際に取り込んでください:"
echo "     bash \"$INSTALL_DIR/icloud_invoice_collect.sh\""
echo ""
echo "   今後は毎日 20:45 に、新しく増えた請求書だけを自動で取り込みます。"
echo "   ログ: ~/Library/Logs/dencho-icloud-collect.log"

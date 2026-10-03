#!/bin/bash
# サルコペニア簡易評価アプリ Mac 用セットアップ（ダブルクリックで実行）
#
# やること:
#   1. Python の実行環境（.venv）を sarcopenia フォルダ内に作り、必要な部品を入れる
#   2. Mac にログインしたら自動でアプリが起動するように登録する（LaunchAgent）
#   3. 今すぐ起動してブラウザで開く
#
# データの保存先: ~/Documents/サルコペニア評価/sarcopenia.db
#   （Mac→NAS 自動バックアップが「書類」フォルダをコピーするので、そのまま二重化される）

set -eu

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$APP_DIR/.venv"
PLIST_LABEL="com.kishimoto.sarcopenia"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
PORT=5070
DATA_DIR="$HOME/Documents/サルコペニア評価"

echo ""
echo "=== サルコペニア簡易評価アプリ セットアップ ==="
echo "アプリの場所: $APP_DIR"
echo ""

# --- 0. Python の確認 ---
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "⚠ Python 3.9 以上が見つかりません。"
  echo "  ターミナルで  xcode-select --install  を実行するか、"
  echo "  https://www.python.org/downloads/macos/ からインストールしてから、もう一度実行してください。"
  exit 1
fi
echo "Python: $(python3 --version)"

# --- 1. 実行環境 ---
echo "1/3 実行環境を準備しています（初回は1〜2分かかります）..."
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
mkdir -p "$DATA_DIR"

# --- 2. ログイン時の自動起動を登録 ---
echo "2/3 ログイン時の自動起動を登録しています..."
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
        <string>$VENV/bin/python</string>
        <string>$APP_DIR/app.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$PORT</string>
        <key>SARCOPENIA_DB_PATH</key>
        <string>$DATA_DIR/sarcopenia.db</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/kishimoto-sarcopenia.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/kishimoto-sarcopenia.log</string>
</dict>
</plist>
PLIST

# すでに登録済みなら一度解除してから登録し直す（アプリ更新後もこれで反映される）
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

# --- 3. 起動確認 ---
echo "3/3 起動を確認しています..."
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then
    echo ""
    echo "✅ セットアップ完了！"
    echo "   アプリ:     http://localhost:$PORT  （ブラウザのブックマークに登録しておくと便利です）"
    echo "   データ:     $DATA_DIR/sarcopenia.db"
    echo "   日次複製:   $DATA_DIR/backups/"
    echo "   ログ:       ~/Library/Logs/kishimoto-sarcopenia.log"
    echo "   今後は Mac にログインすると自動で起動します。"
    open "http://localhost:$PORT/"
    exit 0
  fi
  sleep 1
done

echo ""
echo "⚠ 起動を確認できませんでした。次のコマンドでログを確認してください:"
echo "    tail -30 ~/Library/Logs/kishimoto-sarcopenia.log"
exit 1

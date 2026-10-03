#!/bin/bash
# サルコペニア簡易評価アプリ Mac 用セットアップ
#
# 実行方法（ターミナルで）:  bash setup.command
#   ※ ダブルクリックは macOS の安全機能で止められることがあります
#
# やること:
#   1. アプリ本体を Mac の専用領域（~/Library/Application Support/kishimoto-sarcopenia）へコピー
#      （「書類」「デスクトップ」「ダウンロード」内に置いたままだと、ログイン時の
#        自動起動プログラムからは読めない macOS の制限があるため）
#   2. Python の実行環境（.venv）を作り、必要な部品を入れる
#   3. Mac にログインしたら自動でアプリが起動するように登録する（LaunchAgent）
#   4. 今すぐ起動してブラウザで開く
#
# データの保存先: ~/サルコペニア評価/sarcopenia.db（ホーム直下。NAS バックアップ対象）

set -eu

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/kishimoto-sarcopenia"
VENV="$APP_DIR/.venv"
PLIST_LABEL="com.kishimoto.sarcopenia"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
PORT=5070
DATA_DIR="$HOME/サルコペニア評価"
LOG="$HOME/Library/Logs/kishimoto-sarcopenia.log"

echo ""
echo "=== サルコペニア簡易評価アプリ セットアップ ==="
echo ""

# --- 0. Python の確認 ---
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "⚠ Python 3.9 以上が見つかりません。"
  echo "  ターミナルで  xcode-select --install  を実行するか、"
  echo "  https://www.python.org/downloads/macos/ からインストールしてから、もう一度実行してください。"
  exit 1
fi
echo "Python: $(python3 --version)"

# --- 1. 本体をコピー（.venv と DB は除く） ---
echo "1/4 アプリ本体を配置しています..."
echo "    $SRC_DIR  →  $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete \
  --exclude ".venv" --exclude "*.db" --exclude "backups" --exclude "__pycache__" --exclude ".pytest_cache" \
  "$SRC_DIR/" "$APP_DIR/"

# --- 2. 実行環境 ---
echo "2/4 実行環境を準備しています（初回は1〜2分かかります）..."
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# --- 3. ログイン時の自動起動を登録 ---
echo "3/4 ログイン時の自動起動を登録しています..."
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
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
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLIST

# すでに登録済みなら一度解除してから登録し直す（アプリ更新後もこれで反映される）
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
: > "$LOG"
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

# --- 4. 起動確認 ---
echo "4/4 起動を確認しています..."
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then
    echo ""
    echo "✅ セットアップ完了！"
    echo "   アプリ:     http://localhost:$PORT  （ブラウザのブックマークに登録しておくと便利です）"
    echo "   データ:     $DATA_DIR/sarcopenia.db"
    echo "   日次複製:   $DATA_DIR/backups/"
    echo "   本体:       $APP_DIR"
    echo "   ログ:       $LOG"
    echo "   今後は Mac にログインすると自動で起動します。"
    open "http://localhost:$PORT/"
    exit 0
  fi
  sleep 1
done

echo ""
echo "⚠ 起動を確認できませんでした。ログの最後の部分を表示します:"
echo "----------------------------------------"
tail -30 "$LOG" 2>/dev/null || true
echo "----------------------------------------"
echo "上の内容をコピーして相談してください。"
exit 1

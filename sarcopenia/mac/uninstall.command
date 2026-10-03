#!/bin/bash
# 自動起動の解除（ダブルクリックで実行）。データ（~/Documents/サルコペニア評価）は消しません。
set -u
PLIST_PATH="$HOME/Library/LaunchAgents/com.kishimoto.sarcopenia.plist"
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "自動起動を解除しました。データは ~/Documents/サルコペニア評価 に残っています。"

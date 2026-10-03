#!/bin/bash
# サルコペニア簡易評価アプリを開く（ダブルクリックで実行）
# 自動起動が止まっていた場合は起動し直してから開きます。
set -u
PORT=5070
PLIST_PATH="$HOME/Library/LaunchAgents/com.kishimoto.sarcopenia.plist"

if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
  if [ -f "$PLIST_PATH" ]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/com.kishimoto.sarcopenia" 2>/dev/null || true
    for _ in $(seq 1 15); do
      curl -s -o /dev/null "http://localhost:$PORT/" && break
      sleep 1
    done
  else
    echo "セットアップがまだです。先に setup.command をダブルクリックしてください。"
    exit 1
  fi
fi
open "http://localhost:$PORT/"

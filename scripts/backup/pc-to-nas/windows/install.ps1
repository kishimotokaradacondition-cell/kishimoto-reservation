# Windows PC → NAS 自動バックアップのセットアップスクリプト
#
# 使い方:
#   1. このフォルダ（scripts\backup\pc-to-nas\windows）を PC にダウンロード
#   2. スタートメニューで「PowerShell」を検索して開く
#   3. 次のように入力して Enter（フォルダの場所は読み替え）:
#        cd ダウンロードした場所\scripts\backup\pc-to-nas\windows
#        powershell -ExecutionPolicy Bypass -File install.ps1
#   4. NAS のパスを聞かれるので入力（例: \\NAS\backup）
#
# これで毎日 20:00 に自動バックアップが動きます。

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir     = Join-Path $env:LOCALAPPDATA "kishimoto-backup"
$TaskName   = "kishimoto-backup-to-nas"
$RunHour    = 20   # 実行時刻（時）
$RunMinute  = 0    # 実行時刻（分）

Write-Host ""
Write-Host "=== PC → NAS 自動バックアップ セットアップ ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. NAS のパスを聞く ---
$NasRoot = Read-Host "NAS のバックアップ用共有フォルダを入力してください（例: \\NAS\backup）"
if ([string]::IsNullOrWhiteSpace($NasRoot)) {
    Write-Host "パスが入力されませんでした。もう一度やり直してください。" -ForegroundColor Red
    exit 1
}
$NasRoot = $NasRoot.Trim()

Write-Host "NAS に接続できるか確認しています..."
if (-not (Test-Path $NasRoot)) {
    Write-Host ""
    Write-Host "⚠ $NasRoot に接続できません。" -ForegroundColor Yellow
    Write-Host "  エクスプローラーで一度 $NasRoot を開き、ユーザー名とパスワードを入れて"
    Write-Host "  「資格情報を記憶する」にチェックを入れてから、もう一度実行してください。"
    exit 1
}
Write-Host "OK: NAS に接続できました。" -ForegroundColor Green

# --- 2. スクリプトを配置（NASのパスを書き込んでからコピー） ---
Write-Host "1/3 バックアップスクリプトを配置しています..."
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$content = Get-Content (Join-Path $ScriptDir "backup_to_nas.ps1") -Raw -Encoding utf8
$content = $content.Replace('$NasRoot = "\\NAS\backup"', '$NasRoot = "' + $NasRoot + '"')
Set-Content -Path (Join-Path $AppDir "backup_to_nas.ps1") -Value $content -Encoding utf8

# --- 3. タスクスケジューラに登録 ---
Write-Host "2/3 毎日 $RunHour時$($RunMinute.ToString('00'))分 の自動実行を登録しています..."
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\backup_to_nas.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($RunHour).AddMinutes($RunMinute))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null

# --- 4. 1回目を今すぐ実行 ---
Write-Host "3/3 動作確認のため、1回目のバックアップを今すぐ実行します..."
Write-Host "    （ファイルが多い場合、初回は時間がかかります）"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir "backup_to_nas.ps1")

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ セットアップ完了！" -ForegroundColor Green
    Write-Host "   今後は毎日 $RunHour時$($RunMinute.ToString('00'))分 に自動でバックアップされます。"
    Write-Host "   （その時刻に電源が入っていなかった場合は、次の起動時に自動実行されます）"
    Write-Host "   保存先: $NasRoot\PCバックアップ\$env:COMPUTERNAME"
    Write-Host "   ログ:   $AppDir\logs"
} else {
    Write-Host ""
    Write-Host "⚠ 1回目のバックアップでエラーが出ました。" -ForegroundColor Yellow
    Write-Host "  デスクトップの「【要確認】バックアップ失敗.txt」を確認してください。"
}

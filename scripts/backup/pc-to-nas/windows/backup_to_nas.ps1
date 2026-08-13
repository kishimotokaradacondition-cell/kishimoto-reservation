# Windows PC → NAS 自動バックアップスクリプト
#
# 毎日、下の「バックアップ対象フォルダ」を NAS の共有フォルダへコピーします。
# - 差分コピー（前回から変わったファイルだけ）なので2回目以降は速いです
# - 誤削除対策のため、PC側で消したファイルも NAS からは削除しません
# - 失敗したときはデスクトップに「【要確認】バックアップ失敗.txt」を作って知らせます
#
# ※ 設定（NASの場所など）は install.ps1 実行時に自動で書き換わります。
#    手で直したいときは下の「設定」ブロックだけ変更してください。

# ===================== 設定 =====================
# NAS のバックアップ用共有フォルダ（例: \\NAS\backup）
$NasRoot = "\\NAS\backup"

# バックアップするフォルダの一覧（必要に応じて追加・削除OK）
$Targets = @(
    "$env:USERPROFILE\Documents",
    "$env:USERPROFILE\Desktop",
    "$env:USERPROFILE\Pictures"
)
# ================================================

$ErrorActionPreference = "Continue"

$AppDir   = Join-Path $env:LOCALAPPDATA "kishimoto-backup"
$LogDir   = Join-Path $AppDir "logs"
$LogFile  = Join-Path $LogDir ("backup-{0}.log" -f (Get-Date -Format "yyyy-MM"))
$AlertFile = Join-Path ([Environment]::GetFolderPath("Desktop")) "【要確認】バックアップ失敗.txt"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log([string]$msg) {
    "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg |
        Out-File -Append -Encoding utf8 $LogFile
}

function Fail([string]$reason) {
    Log "エラー: $reason"
    @"
バックアップに失敗しました。

日時: $(Get-Date -Format "yyyy-MM-dd HH:mm")
理由: $reason

【確認すること】
1. NAS の電源が入っているか
2. この PC が院内の Wi-Fi / LAN につながっているか
3. エクスプローラーのアドレス欄に $NasRoot と入力して開けるか

詳しいログ: $LogFile

問題が直ったら、次の日の自動実行を待つか、
スタートメニューで「タスク スケジューラ」を開き
「kishimoto-backup-to-nas」を右クリック →「実行」で手動実行できます。
"@ | Out-File -Encoding utf8 $AlertFile
    exit 1
}

Log "===== バックアップ開始 ====="

# 古い月のログを削除（直近6か月だけ残す）
Get-ChildItem $LogDir -Filter "backup-*.log" |
    Sort-Object Name -Descending |
    Select-Object -Skip 6 |
    Remove-Item -ErrorAction SilentlyContinue

# NAS に接続できるか確認
if (-not (Test-Path $NasRoot)) {
    Fail "NAS（$NasRoot）に接続できません。"
}

# 共有フォルダ内の「PCバックアップ」フォルダの中の、このPC専用のフォルダ（PC名）に保存する
$Dest = Join-Path $NasRoot "PCバックアップ\$env:COMPUTERNAME"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$hadError = $false

foreach ($src in $Targets) {
    if (-not (Test-Path $src)) {
        Log "スキップ: $src（フォルダがありません）"
        continue
    }
    $name = Split-Path $src -Leaf
    $dst  = Join-Path $Dest $name
    Log "コピー中: $src → $dst"

    # robocopy:
    #   /E   サブフォルダごとコピー
    #   /XO  NAS側が同じか新しいファイルはスキップ（差分コピー）
    #   /FFT NASとのわずかな時刻ズレを誤検知しない
    #   /XJ  ジャンクション（無限ループの原因）を除外
    #   ※ /MIR や /PURGE は使わない = PCで消してもNASには残る（誤削除対策）
    robocopy $src $dst /E /XO /FFT /XJ /R:2 /W:5 /NP /NDL `
        /XD '$RECYCLE.BIN' 'System Volume Information' 'node_modules' `
        /XF 'Thumbs.db' 'desktop.ini' '~$*' `
        "/LOG+:$LogFile" | Out-Null

    # robocopy の終了コード 0〜7 は正常（8以上がエラー）
    if ($LASTEXITCODE -ge 8) {
        $hadError = $true
        Log "エラー: $name のコピーに失敗（robocopy コード: $LASTEXITCODE）"
    } else {
        Log "完了: $name（robocopy コード: $LASTEXITCODE）"
    }
}

if ($hadError) {
    Fail "一部のフォルダのコピーに失敗しました。"
}

# 成功したら、前回の失敗通知ファイルを片付ける
Remove-Item $AlertFile -ErrorAction SilentlyContinue

# NAS 側に「いつ・どのPCが成功したか」を残す（NAS→クラウド側の確認にも使える）
"最終バックアップ成功: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')（$env:COMPUTERNAME）" |
    Out-File -Encoding utf8 (Join-Path $Dest "_最終バックアップ日時.txt")

Log "===== バックアップ完了 ====="
exit 0

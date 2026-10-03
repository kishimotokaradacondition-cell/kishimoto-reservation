"""
サルコペニア簡易評価アプリ（院内用）

予約システム（../app.py）とは完全に独立した小さな Flask アプリです。
データベースも別ファイル（sarcopenia.db）なので、予約データには影響しません。

  起動（ローカル）: cd sarcopenia && python app.py  → http://localhost:5070
  ファイル構成:
    criteria.py           判定ロジック（AWGS 2019 の基準値と計算）
    templates/index.html  入力画面・結果表示
    static/js/sarcopenia.js  画面の動き（自動計算・送信・履歴表示）
    static/css/sarcopenia.css 見た目

環境変数（すべて任意）:
    SARCOPENIA_PASSWORD   設定するとログイン画面が付く（公開サーバーに置くときは必須）
    SECRET_KEY            ログイン状態を保持する鍵（本番ではランダムな文字列に）
    SARCOPENIA_DB_PATH    SQLite の保存先
                          既定: Mac では ~/サルコペニア評価/sarcopenia.db
                               （Mac→NAS 自動バックアップの対象フォルダ）
                               それ以外はこのフォルダの sarcopenia.db
    PORT                  待ち受けポート（既定: 5070）
"""
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta
from functools import wraps

from flask import (Flask, Response, abort, jsonify, redirect, render_template,
                   request, session, url_for)

from criteria import CUTOFFS, LEVELS, SARCF_CHOICES, SARCF_ITEMS, evaluate

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "sarcopenia-dev-key-change-me")
# 画像アップロードの上限（これを超えると 413 エラー）
MAX_IMAGE_MB = 10
app.config["MAX_CONTENT_LENGTH"] = (MAX_IMAGE_MB + 2) * 1024 * 1024


def default_db_path(platform=None, home=None):
    """
    データベースの既定の保存先。
    Mac ではホーム直下の「サルコペニア評価」フォルダに置く。
    「書類」「デスクトップ」「ダウンロード」は macOS の保護対象で、ログイン時に
    裏で自動起動するプログラム（LaunchAgent）からは読み書きできないため、
    保護対象外のホーム直下を使う。院の Mac→NAS 自動バックアップ
    （scripts/backup/pc-to-nas/mac）はこのフォルダも対象に含めてある。
    """
    platform = platform or sys.platform
    home = home or os.path.expanduser("~")
    if platform == "darwin":
        return os.path.join(home, "サルコペニア評価", "sarcopenia.db")
    return os.path.join(BASE_DIR, "sarcopenia.db")


DB_PATH = os.environ.get("SARCOPENIA_DB_PATH") or default_db_path()
DATA_DIR = os.path.dirname(os.path.abspath(DB_PATH))
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
BACKUP_KEEP_DAYS = 30
APP_PASSWORD = os.environ.get("SARCOPENIA_PASSWORD", "")

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"}


# ── データベース ─────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS assessments (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at      TEXT NOT NULL,
                patient_name    TEXT NOT NULL,
                sex             TEXT NOT NULL,
                age             INTEGER,
                height_cm       REAL,
                weight_kg       REAL,
                calf_cm         REAL,
                sarcf_json      TEXT,
                sarcf_score     INTEGER,
                grip_kg         REAL,
                gait_speed_ms   REAL,
                chair_stand_sec REAL,
                arm_r_kg        REAL,
                arm_l_kg        REAL,
                leg_r_kg        REAL,
                leg_l_kg        REAL,
                asm_kg          REAL,
                smi             REAL,
                note            TEXT,
                result_level    TEXT,
                result_json     TEXT,
                image_mime      TEXT,
                image_blob      BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_assessments_name ON assessments(patient_name, id);
        """)


init_db()


def jst_now():
    """日本時間の文字列（サーバーが海外にあっても日本の日付で記録する）"""
    return (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")


def backup_db(today=None, keep_days=BACKUP_KEEP_DAYS):
    """
    1日1回、DB の複製を backups/sarcopenia-YYYY-MM-DD.db に作る（誤操作・破損対策）。
    すでに今日の分があれば何もしない。古い複製は keep_days 日分だけ残す。
    画像も DB の中にあるので、このファイル1つで丸ごと戻せる。
    """
    today = today or jst_now()[:10]
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dest = os.path.join(BACKUP_DIR, f"sarcopenia-{today}.db")
    if os.path.exists(dest):
        return None
    src = sqlite3.connect(DB_PATH)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)  # 書き込み中でも安全に複製できる SQLite 標準の方法
        finally:
            dst.close()
    finally:
        src.close()
    # 古い複製を削除
    names = sorted(n for n in os.listdir(BACKUP_DIR) if n.startswith("sarcopenia-") and n.endswith(".db"))
    for n in names[:-keep_days] if len(names) > keep_days else []:
        try:
            os.remove(os.path.join(BACKUP_DIR, n))
        except OSError:
            pass
    return dest


_last_backup_day = None


@app.before_request
def _daily_backup():
    """その日最初のアクセス時に1回だけ複製を作る（起動しっぱなしでも毎日残る）"""
    global _last_backup_day
    today = jst_now()[:10]
    if _last_backup_day == today:
        return
    _last_backup_day = today
    try:
        backup_db(today)
    except Exception as e:  # 複製に失敗しても本体の動作は止めない
        print(f"[backup] 複製に失敗: {e}")


# ── 認証（SARCOPENIA_PASSWORD を設定したときだけ有効）────────────
def _logged_in():
    return (not APP_PASSWORD) or session.get("sarcopenia_auth") is True


def page_login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _logged_in():
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return wrapper


def api_login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _logged_in():
            return jsonify({"error": "ログインが必要です"}), 401
        return f(*args, **kwargs)
    return wrapper


@app.route("/login")
def login_page():
    if _logged_in():
        return redirect(url_for("index"))
    return render_template("login.html")


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    if APP_PASSWORD and data.get("password") == APP_PASSWORD:
        session["sarcopenia_auth"] = True
        return jsonify({"ok": True})
    return jsonify({"error": "パスワードが違います"}), 401


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.pop("sarcopenia_auth", None)
    return jsonify({"ok": True})


# ── 画面 ────────────────────────────────────────────────────
@app.route("/")
@page_login_required
def index():
    return render_template(
        "index.html",
        sarcf_items=SARCF_ITEMS,
        sarcf_choices=SARCF_CHOICES,
        cutoffs=CUTOFFS,
        levels=LEVELS,
        max_image_mb=MAX_IMAGE_MB,
        auth_enabled=bool(APP_PASSWORD),
        data_dir=DATA_DIR,
    )


# ── 入力の整形 ───────────────────────────────────────────────
NUMERIC_FIELDS = (
    "age", "height_cm", "weight_kg", "calf_cm", "grip_kg", "gait_speed_ms",
    "chair_stand_sec", "arm_r_kg", "arm_l_kg", "leg_r_kg", "leg_l_kg", "asm_kg", "smi",
)


def _to_float(v):
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def collect_input(src):
    """
    フォーム（multipart）でも JSON でも同じ形の dict にそろえる。
    SARC-F は sarcf_strength などの個別キー、または sarcf={...} のどちらでも受け付ける。
    """
    data = {
        "patient_name": (src.get("patient_name") or "").strip()[:50],
        "sex": (src.get("sex") or "").strip(),
        "note": (src.get("note") or "").strip()[:1000],
    }
    for k in NUMERIC_FIELDS:
        data[k] = _to_float(src.get(k))

    sarcf = {}
    nested = src.get("sarcf")
    if isinstance(nested, dict):
        sarcf.update(nested)
    for key, _, _ in SARCF_ITEMS:
        v = src.get(f"sarcf_{key}")
        if v not in (None, ""):
            sarcf[key] = v
    data["sarcf"] = sarcf
    return data


def validate_basic(data):
    if not data["patient_name"]:
        return "お名前を入力してください"
    if data["sex"] not in ("male", "female"):
        return "性別を選択してください"
    if data["age"] is not None and not (0 <= data["age"] <= 120):
        return "年齢の値を確認してください"
    if data["height_cm"] is not None and not (50 <= data["height_cm"] <= 250):
        return "身長の値（cm）を確認してください"
    return None


def read_image(file_storage):
    """アップロード画像を (mime, bytes) で返す。無ければ (None, None)。"""
    if not file_storage or not file_storage.filename:
        return None, None
    mime = (file_storage.mimetype or "").lower()
    if mime not in ALLOWED_IMAGE_TYPES:
        raise ValueError("画像ファイル（JPEG / PNG / WebP / HEIC）を選んでください")
    blob = file_storage.read()
    if len(blob) > MAX_IMAGE_MB * 1024 * 1024:
        raise ValueError(f"画像は {MAX_IMAGE_MB}MB 以下にしてください")
    return mime, blob


def row_to_dict(row, with_result=True):
    d = {k: row[k] for k in row.keys() if k not in ("image_blob",)}
    d["has_image"] = row["image_blob"] is not None if "image_blob" in row.keys() else False
    d["image_url"] = url_for("assessment_image", res_id=row["id"]) if d["has_image"] else None
    d["sarcf"] = json.loads(row["sarcf_json"]) if row["sarcf_json"] else {}
    d.pop("sarcf_json", None)
    if with_result:
        d["result"] = json.loads(row["result_json"]) if row["result_json"] else None
    d.pop("result_json", None)
    return d


def fetch_previous(conn, name, before_id):
    """同じ名前で、この記録より前の最新1件（前回比の計算用）"""
    row = conn.execute(
        """SELECT id, created_at, weight_kg, calf_cm, sarcf_score, grip_kg, gait_speed_ms,
                  chair_stand_sec, asm_kg, smi, result_level
             FROM assessments WHERE patient_name=? AND id<? ORDER BY id DESC LIMIT 1""",
        (name, before_id),
    ).fetchone()
    return dict(row) if row else None


# ── API ─────────────────────────────────────────────────────
@app.route("/api/evaluate", methods=["POST"])
@api_login_required
def api_evaluate():
    """保存せずに判定だけ返す（入力途中の確認用）"""
    src = request.get_json(silent=True) or request.form
    data = collect_input(src)
    if data["sex"] not in ("male", "female"):
        return jsonify({"error": "性別を選択してください"}), 400
    try:
        return jsonify({"ok": True, "result": evaluate(data)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/assessments", methods=["POST"])
@api_login_required
def create_assessment():
    """判定して保存する（画像付き multipart/form-data）"""
    src = request.form if request.form else (request.get_json(silent=True) or {})
    data = collect_input(src)
    err = validate_basic(data)
    if err:
        return jsonify({"error": err}), 400

    try:
        mime, blob = read_image(request.files.get("inbody_image"))
        result = evaluate(data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO assessments (
                   created_at, patient_name, sex, age, height_cm, weight_kg, calf_cm,
                   sarcf_json, sarcf_score, grip_kg, gait_speed_ms, chair_stand_sec,
                   arm_r_kg, arm_l_kg, leg_r_kg, leg_l_kg, asm_kg, smi,
                   note, result_level, result_json, image_mime, image_blob
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                jst_now(), data["patient_name"], data["sex"], data["age"],
                data["height_cm"], data["weight_kg"], data["calf_cm"],
                json.dumps(data["sarcf"], ensure_ascii=False), result["values"]["sarcf_score"],
                data["grip_kg"], data["gait_speed_ms"], data["chair_stand_sec"],
                data["arm_r_kg"], data["arm_l_kg"], data["leg_r_kg"], data["leg_l_kg"],
                result["values"]["asm_kg"], result["values"]["smi"],
                data["note"], result["level"], json.dumps(result, ensure_ascii=False),
                mime, blob,
            ),
        )
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM assessments WHERE id=?", (new_id,)).fetchone()
        previous = fetch_previous(conn, data["patient_name"], new_id)

    out = row_to_dict(row)
    out["previous"] = previous
    return jsonify({"ok": True, "assessment": out})


@app.route("/api/assessments")
@api_login_required
def list_assessments():
    name = (request.args.get("name") or "").strip()
    limit = min(int(request.args.get("limit") or 50), 200)
    sql = """SELECT id, created_at, patient_name, sex, age, weight_kg, calf_cm, sarcf_score,
                    grip_kg, gait_speed_ms, chair_stand_sec, asm_kg, smi, result_level,
                    (image_blob IS NOT NULL) AS has_image
               FROM assessments"""
    params = []
    if name:
        sql += " WHERE patient_name LIKE ?"
        params.append(f"%{name}%")
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    with get_db() as conn:
        rows = conn.execute(sql, params).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["has_image"] = bool(d["has_image"])
        d["result_label"] = LEVELS.get(d["result_level"], ("", "", ""))[0]
        d["result_css"] = LEVELS.get(d["result_level"], ("", "", ""))[1]
        items.append(d)
    return jsonify({"items": items})


@app.route("/api/names")
@api_login_required
def list_names():
    """入力補助（名前の候補）用"""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT patient_name, MAX(id) AS mid FROM assessments GROUP BY patient_name ORDER BY mid DESC LIMIT 200"
        ).fetchall()
    return jsonify({"names": [r["patient_name"] for r in rows]})


@app.route("/api/assessments/<int:res_id>")
@api_login_required
def get_assessment(res_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM assessments WHERE id=?", (res_id,)).fetchone()
        if not row:
            return jsonify({"error": "記録が見つかりません"}), 404
        out = row_to_dict(row)
        out["previous"] = fetch_previous(conn, row["patient_name"], res_id)
    return jsonify({"ok": True, "assessment": out})


@app.route("/api/assessments/<int:res_id>", methods=["DELETE"])
@api_login_required
def delete_assessment(res_id):
    with get_db() as conn:
        cur = conn.execute("DELETE FROM assessments WHERE id=?", (res_id,))
        if cur.rowcount == 0:
            return jsonify({"error": "記録が見つかりません"}), 404
    return jsonify({"ok": True})


@app.route("/api/assessments/<int:res_id>/image")
@api_login_required
def assessment_image(res_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT image_mime, image_blob FROM assessments WHERE id=?", (res_id,)
        ).fetchone()
    if not row or row["image_blob"] is None:
        abort(404)
    return Response(row["image_blob"], mimetype=row["image_mime"] or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600"})


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": f"ファイルが大きすぎます（{MAX_IMAGE_MB}MB 以下）"}), 413


# ── 起動 ────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5070))
    print(f"サルコペニア評価アプリ起動: http://localhost:{port}")
    print(f"データの保存先: {DB_PATH}")
    if not APP_PASSWORD:
        print("※ SARCOPENIA_PASSWORD 未設定のためログインなしで動作します（ローカル利用向け）")
    app.run(host="0.0.0.0", port=port, debug=False)

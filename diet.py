"""
ダイエット・食事管理モジュール（InBodyデータ連動）

InBody検査表の体成分データ（除脂肪量・体脂肪量・基礎代謝量など）をもとに
1日の目標カロリーとPFCバランスを自動計算し、食事・運動・体重の記録を
管理する。予約システム本体（app.py）にBlueprintとして組み込む。

- 管理者（app.pyの管理ログイン）は全プロフィールを操作できる
- 各プロフィールの共有トークン（/diet?token=xxxx）を渡せば、
  本人だけが自分の記録をつけられる
"""

from flask import Blueprint, request, jsonify, session, render_template
import sqlite3
import os
import secrets
from datetime import datetime, timedelta

diet_bp = Blueprint("diet", __name__)

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "reservation.db"))


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def jst_today():
    return (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d")


def jst_now():
    return (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")


# ── 定数・基準値 ──────────────────────────────────────────

# 身体活動レベル（厚生労働省「日本人の食事摂取基準」のPALに準拠）
ACTIVITY_LEVELS = {
    "low":    {"factor": 1.40, "label": "低い（ほぼ座位・移動少なめ）"},
    "mid":    {"factor": 1.60, "label": "ふつう（立ち仕事・軽い運動あり）"},
    "active": {"factor": 1.75, "label": "やや高い（ほぼ毎日運動）"},
    "very":   {"factor": 2.00, "label": "高い（力仕事＋高強度の運動）"},
}

MEAL_TYPES = {
    "breakfast": "朝食",
    "lunch":     "昼食",
    "dinner":    "夕食",
    "snack":     "間食・飲み物",
}

# 体脂肪1kg = 約7,200kcal
KCAL_PER_FAT_KG = 7200

# InBody検査表の標準範囲（成人男性/女性）
STANDARD_RANGES = {
    "male":   {"bmi": (18.5, 25.0), "fat_pct": (10.0, 20.0), "waist": 85.0},
    "female": {"bmi": (18.5, 25.0), "fat_pct": (18.0, 28.0), "waist": 90.0},
}
VISCERAL_FAT_LIMIT = 10          # 内臓脂肪レベルの標準上限
SALT_LIMIT = {"male": 7.5, "female": 6.5}   # 1日の食塩相当量（g未満）

# 運動のMETs（国立健康・栄養研究所「改訂版 身体活動のメッツ表」より代表値）
METS_PRESETS = [
    {"kind": "ウォーキング（普通 4.0km/h）", "mets": 3.0},
    {"kind": "ウォーキング（速歩 6.0km/h）", "mets": 4.3},
    {"kind": "ジョギング（ゆっくり）",       "mets": 6.0},
    {"kind": "ランニング（8km/h）",          "mets": 8.3},
    {"kind": "自転車（通勤・平地）",         "mets": 4.0},
    {"kind": "自転車（速め）",               "mets": 6.8},
    {"kind": "水泳（クロール ゆっくり）",     "mets": 5.8},
    {"kind": "筋トレ（自重・中強度）",        "mets": 3.5},
    {"kind": "筋トレ（バーベル等・高強度）",  "mets": 6.0},
    {"kind": "スクワット・体幹トレ",          "mets": 5.0},
    {"kind": "ストレッチ・ヨガ",             "mets": 2.5},
    {"kind": "ラジオ体操",                   "mets": 4.0},
    {"kind": "階段のぼり",                   "mets": 8.8},
    {"kind": "立ち仕事・施術",               "mets": 3.0},
    {"kind": "掃除・家事",                   "mets": 3.3},
    {"kind": "ゴルフ（カート不使用）",        "mets": 4.8},
    {"kind": "テニス",                       "mets": 7.3},
    {"kind": "卓球",                         "mets": 4.0},
    {"kind": "登山・ハイキング",             "mets": 6.5},
]

# よく食べる食品の目安値（日本食品標準成分表をもとにした概算）
FOOD_PRESETS = [
    # name, category, unit_label, kcal, P, F, C, 食塩
    ("ごはん（茶碗1杯 150g）",     "主食", "1杯", 234, 3.8, 0.5, 53.4, 0.0),
    ("ごはん（丼 250g）",          "主食", "1杯", 390, 6.3, 0.8, 89.0, 0.0),
    ("玄米ごはん（150g）",         "主食", "1杯", 228, 4.2, 1.5, 51.3, 0.0),
    ("食パン6枚切り（1枚）",       "主食", "1枚", 158, 5.6, 2.6, 28.0, 0.7),
    ("うどん（1玉 230g）",         "主食", "1玉", 242, 6.0, 0.9, 49.9, 0.7),
    ("そば（1玉 180g）",           "主食", "1玉", 237, 8.6, 1.8, 47.3, 0.0),
    ("パスタ（乾麺80g・茹で）",    "主食", "1食", 278, 9.8, 1.4, 55.6, 0.0),
    ("おにぎり（鮭・1個）",        "主食", "1個", 180, 4.5, 1.5, 36.0, 1.0),
    ("鶏むね肉 皮なし（100g）",    "主菜", "100g", 105, 23.3, 1.9, 0.1, 0.1),
    ("鶏もも肉 皮なし（100g）",    "主菜", "100g", 113, 19.0, 5.0, 0.0, 0.2),
    ("サラダチキン（1個 110g）",   "主菜", "1個", 114, 24.2, 1.5, 0.3, 1.1),
    ("豚ロース（100g）",           "主菜", "100g", 248, 19.3, 19.2, 0.2, 0.1),
    ("豚こま切れ（100g）",         "主菜", "100g", 221, 18.5, 16.5, 0.1, 0.1),
    ("牛赤身肉（100g）",           "主菜", "100g", 182, 21.2, 9.6, 0.5, 0.1),
    ("鮭の切り身（1切れ 80g）",    "主菜", "1切れ", 106, 17.8, 3.3, 0.1, 0.2),
    ("さば（1切れ 80g）",          "主菜", "1切れ", 169, 16.5, 13.4, 0.2, 0.2),
    ("さば水煮缶（1缶 190g）",     "主菜", "1缶", 322, 39.7, 20.5, 0.4, 1.7),
    ("まぐろ赤身 刺身（80g）",     "主菜", "80g", 100, 20.6, 1.1, 0.1, 0.1),
    ("卵（1個 50g）",              "主菜", "1個", 71, 6.1, 5.1, 0.2, 0.2),
    ("納豆（1パック 45g）",        "主菜", "1P", 84, 7.4, 4.5, 5.4, 0.0),
    ("豆腐 木綿（1/2丁 150g）",    "主菜", "1/2丁", 110, 10.5, 7.4, 2.2, 0.0),
    ("プロテイン（1杯 30g）",      "その他", "1杯", 117, 24.0, 1.5, 2.5, 0.2),
    ("牛乳（200ml）",              "その他", "200ml", 122, 6.6, 7.6, 9.6, 0.2),
    ("無糖ヨーグルト（100g）",     "その他", "100g", 56, 3.6, 3.0, 4.9, 0.1),
    ("チーズ（1個 18g）",          "その他", "1個", 62, 4.1, 4.7, 0.2, 0.5),
    ("野菜サラダ（ドレなし）",     "副菜", "1皿", 25, 1.2, 0.2, 5.0, 0.0),
    ("味噌汁（1杯）",              "副菜", "1杯", 40, 2.5, 1.2, 4.5, 1.5),
    ("ひじき煮（小鉢）",           "副菜", "1皿", 60, 2.0, 3.0, 6.5, 1.0),
    ("きのこソテー（1皿）",        "副菜", "1皿", 45, 2.5, 3.0, 3.5, 0.6),
    ("ブロッコリー（80g）",        "副菜", "80g", 30, 3.5, 0.4, 4.1, 0.0),
    ("バナナ（1本）",              "果物", "1本", 93, 1.1, 0.2, 22.5, 0.0),
    ("りんご（1/2個）",            "果物", "1/2個", 76, 0.2, 0.2, 20.5, 0.0),
    ("カレーライス（外食）",       "外食", "1食", 780, 20.0, 25.0, 115.0, 3.5),
    ("ラーメン（醤油・外食）",     "外食", "1杯", 490, 20.0, 12.0, 72.0, 6.0),
    ("牛丼（並盛）",               "外食", "1杯", 635, 20.0, 20.0, 92.0, 2.7),
    ("定食（焼き魚・ごはん付）",   "外食", "1食", 650, 32.0, 18.0, 88.0, 4.0),
    ("唐揚げ（3個）",              "外食", "3個", 290, 18.0, 18.0, 12.0, 1.3),
    ("ビール（350ml）",            "お酒", "1缶", 140, 1.1, 0.0, 10.9, 0.0),
    ("ハイボール（350ml）",        "お酒", "1杯", 175, 0.0, 0.0, 0.0, 0.0),
    ("日本酒（1合 180ml）",        "お酒", "1合", 185, 0.7, 0.0, 8.8, 0.0),
    ("焼酎（100ml）",              "お酒", "100ml", 146, 0.0, 0.0, 0.0, 0.0),
    ("ポテトチップス（60g）",      "間食", "1袋", 330, 3.0, 21.0, 32.0, 0.6),
    ("菓子パン（1個）",            "間食", "1個", 350, 6.0, 12.0, 54.0, 0.6),
    ("アイスクリーム（1個）",      "間食", "1個", 205, 3.5, 10.5, 23.0, 0.2),
    ("缶コーヒー 微糖（185ml）",   "間食", "1本", 40, 1.0, 0.5, 8.0, 0.1),
]


# ── DB初期化 ─────────────────────────────────────────────

def init_diet_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS diet_profiles (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                sex             TEXT DEFAULT 'male',
                age             INTEGER,
                height_cm       REAL,
                activity_level  TEXT DEFAULT 'mid',
                goal_weight_kg  REAL,
                goal_fat_pct    REAL,
                goal_pace_kg    REAL DEFAULT 1.5,
                add_exercise    INTEGER DEFAULT 1,
                token           TEXT UNIQUE,
                note            TEXT,
                created_at      TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS inbody_records (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id          INTEGER NOT NULL,
                measured_on         TEXT NOT NULL,
                weight_kg           REAL,
                body_fat_pct        REAL,
                fat_mass_kg         REAL,
                muscle_kg           REAL,
                fat_free_mass_kg    REAL,
                body_water_kg       REAL,
                protein_kg          REAL,
                mineral_kg          REAL,
                bmi                 REAL,
                visceral_fat_level  REAL,
                waist_cm            REAL,
                bmr_kcal            REAL,
                score               REAL,
                note                TEXT,
                created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (profile_id) REFERENCES diet_profiles(id)
            );
            CREATE TABLE IF NOT EXISTS body_logs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id    INTEGER NOT NULL,
                date          TEXT NOT NULL,
                weight_kg     REAL,
                body_fat_pct  REAL,
                note          TEXT,
                created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(profile_id, date),
                FOREIGN KEY (profile_id) REFERENCES diet_profiles(id)
            );
            CREATE TABLE IF NOT EXISTS meal_logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  INTEGER NOT NULL,
                date        TEXT NOT NULL,
                meal_type   TEXT NOT NULL,
                name        TEXT NOT NULL,
                amount      REAL DEFAULT 1,
                kcal        REAL DEFAULT 0,
                protein_g   REAL DEFAULT 0,
                fat_g       REAL DEFAULT 0,
                carb_g      REAL DEFAULT 0,
                salt_g      REAL DEFAULT 0,
                note        TEXT,
                created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (profile_id) REFERENCES diet_profiles(id)
            );
            CREATE TABLE IF NOT EXISTS exercise_logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  INTEGER NOT NULL,
                date        TEXT NOT NULL,
                kind        TEXT NOT NULL,
                minutes     REAL DEFAULT 0,
                mets        REAL DEFAULT 0,
                kcal        REAL DEFAULT 0,
                note        TEXT,
                created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (profile_id) REFERENCES diet_profiles(id)
            );
            CREATE TABLE IF NOT EXISTS foods (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                category    TEXT DEFAULT 'その他',
                unit_label  TEXT DEFAULT '1食',
                kcal        REAL DEFAULT 0,
                protein_g   REAL DEFAULT 0,
                fat_g       REAL DEFAULT 0,
                carb_g      REAL DEFAULT 0,
                salt_g      REAL DEFAULT 0,
                is_preset   INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name)
            );
            CREATE INDEX IF NOT EXISTS idx_meal_logs_pd     ON meal_logs(profile_id, date);
            CREATE INDEX IF NOT EXISTS idx_exercise_logs_pd ON exercise_logs(profile_id, date);
            CREATE INDEX IF NOT EXISTS idx_body_logs_pd     ON body_logs(profile_id, date);
            CREATE INDEX IF NOT EXISTS idx_inbody_pd        ON inbody_records(profile_id, measured_on);
        """)

        # 食品マスタの初期投入（既にあるものはスキップ）
        for f in FOOD_PRESETS:
            conn.execute(
                "INSERT OR IGNORE INTO foods "
                "(name, category, unit_label, kcal, protein_g, fat_g, carb_g, salt_g, is_preset) "
                "VALUES (?,?,?,?,?,?,?,?,1)", f)

        # プロフィールが1件もない場合のみ、InBody検査表のデータで初期プロフィールを作成
        row = conn.execute("SELECT COUNT(*) c FROM diet_profiles").fetchone()
        if row["c"] == 0:
            cur = conn.execute(
                "INSERT INTO diet_profiles "
                "(name, sex, age, height_cm, activity_level, goal_weight_kg, goal_fat_pct, "
                " goal_pace_kg, add_exercise, token, note) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("ご本人", "male", 51, 173.5, "mid", 66.7, 20.0, 1.5, 1,
                 secrets.token_urlsafe(12),
                 "InBody検査表（ID.1）をもとに作成。目標体重はInBodyの「調節すべき体重 -11.0kg」から算出。"))
            pid = cur.lastrowid
            conn.execute(
                "INSERT INTO inbody_records "
                "(profile_id, measured_on, weight_kg, body_fat_pct, fat_mass_kg, muscle_kg, "
                " fat_free_mass_kg, body_water_kg, protein_kg, mineral_kg, bmi, "
                " visceral_fat_level, waist_cm, bmr_kcal, score, note) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (pid, "2008-01-01", 77.7, 27.0, 21.0, 31.8, 56.7, 41.7, 11.2, 3.78,
                 25.8, 11, 87.0, 1595, 89,
                 "InBody検査表より登録（測定日時は機器の表示のまま。実際の測定日に修正してください）"))

        # 既存DBへの列追加（マイグレーション）
        for ddl in (
            "ALTER TABLE diet_profiles ADD COLUMN add_exercise INTEGER DEFAULT 1",
            "ALTER TABLE diet_profiles ADD COLUMN goal_fat_pct REAL",
        ):
            try:
                conn.execute(ddl)
            except Exception:
                pass


# ── 認証 ─────────────────────────────────────────────────

def _payload():
    return request.get_json(silent=True) or {}


def _req_token():
    return (request.args.get("token") or _payload().get("token") or "").strip()


def _is_admin():
    return bool(session.get("admin"))


def _profile_or_403(profile_id):
    """プロフィールを取得。管理ログインか、共有トークン一致なら許可。"""
    with get_db() as conn:
        p = conn.execute("SELECT * FROM diet_profiles WHERE id = ?", (profile_id,)).fetchone()
    if not p:
        return None, (jsonify({"error": "プロフィールが見つかりません"}), 404)
    if _is_admin():
        return p, None
    token = _req_token()
    if token and p["token"] and secrets.compare_digest(token, p["token"]):
        return p, None
    return None, (jsonify({"error": "Unauthorized"}), 401)


def _owned_row_or_403(table, row_id):
    """明細行（食事・運動など）の所有プロフィールを確認する。"""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM %s WHERE id = ?" % table, (row_id,)).fetchone()
    if not row:
        return None, (jsonify({"error": "対象が見つかりません"}), 404)
    _, err = _profile_or_403(row["profile_id"])
    if err:
        return None, err
    return row, None


# ── 計算エンジン ──────────────────────────────────────────

def _f(value, default=None):
    """数値に変換できなければdefaultを返す。"""
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def estimate_bmr(fat_free_mass_kg=None, weight_kg=None, sex="male", age=None):
    """基礎代謝量(kcal)。除脂肪量が分かればKatch-McArdle式（InBodyと同じ考え方）。"""
    if fat_free_mass_kg:
        return round(370 + 21.6 * fat_free_mass_kg)
    if weight_kg:
        # 日本人の基礎代謝基準値（kcal/kg体重/日）による概算
        a = age or 40
        if sex == "female":
            base = 22.1 if a < 30 else (21.7 if a < 50 else 20.7)
        else:
            base = 24.0 if a < 30 else (22.3 if a < 50 else 21.5)
        return round(base * weight_kg)
    return None


def latest_body(profile_id):
    """最新のInBody記録と、最新の体重記録を統合した現在の身体データ。"""
    with get_db() as conn:
        ib = conn.execute(
            "SELECT * FROM inbody_records WHERE profile_id = ? "
            "ORDER BY measured_on DESC, id DESC LIMIT 1", (profile_id,)).fetchone()
        bl = conn.execute(
            "SELECT * FROM body_logs WHERE profile_id = ? AND weight_kg IS NOT NULL "
            "ORDER BY date DESC LIMIT 1", (profile_id,)).fetchone()

    data = {
        "inbody": dict(ib) if ib else None,
        "last_weight_log": dict(bl) if bl else None,
        "weight_kg": None, "body_fat_pct": None, "fat_mass_kg": None,
        "fat_free_mass_kg": None, "muscle_kg": None, "bmr_kcal": None,
        "measured_on": None, "source": None,
    }
    if ib:
        data.update({
            "weight_kg": ib["weight_kg"],
            "body_fat_pct": ib["body_fat_pct"],
            "fat_mass_kg": ib["fat_mass_kg"],
            "fat_free_mass_kg": ib["fat_free_mass_kg"],
            "muscle_kg": ib["muscle_kg"],
            "bmr_kcal": ib["bmr_kcal"],
            "measured_on": ib["measured_on"],
            "source": "inbody",
        })
    # 体重の実測が新しければそちらを優先（除脂肪量はInBody時点から変わらないと仮定）
    if bl and (not ib or bl["date"] >= ib["measured_on"]):
        data["weight_kg"] = bl["weight_kg"]
        data["measured_on"] = bl["date"]
        data["source"] = "scale"
        if bl["body_fat_pct"]:
            data["body_fat_pct"] = bl["body_fat_pct"]
        if data["weight_kg"] and data["body_fat_pct"]:
            data["fat_mass_kg"] = round(data["weight_kg"] * data["body_fat_pct"] / 100, 1)
            data["fat_free_mass_kg"] = round(data["weight_kg"] - data["fat_mass_kg"], 1)
    return data


def calc_targets(profile, body):
    """1日の目標カロリー・PFC・水分などを計算する。"""
    sex = profile["sex"] or "male"
    weight = body.get("weight_kg")
    ffm = body.get("fat_free_mass_kg")
    height = profile["height_cm"]

    bmr = body.get("bmr_kcal") or estimate_bmr(ffm, weight, sex, profile["age"])
    level = ACTIVITY_LEVELS.get(profile["activity_level"] or "mid", ACTIVITY_LEVELS["mid"])
    tdee = round(bmr * level["factor"]) if bmr else None

    pace = _f(profile["goal_pace_kg"], 1.5) or 0.0
    deficit = round(pace * KCAL_PER_FAT_KG / 30.4) if pace > 0 else 0

    target_kcal = None
    floor_kcal = None
    limited = False
    if tdee:
        # 下限：基礎代謝量を下回らない（かつ最低1,200kcal）
        floor_kcal = max(int(bmr), 1200)
        raw = tdee - deficit
        target_kcal = max(raw, floor_kcal)
        limited = raw < floor_kcal

    # たんぱく質：除脂肪量1kgあたり2.0g（分からなければ目標体重×1.6g）
    goal_w = _f(profile["goal_weight_kg"]) or weight
    if ffm:
        protein_g = round(ffm * 2.0)
    elif goal_w:
        protein_g = round(goal_w * 1.6)
    else:
        protein_g = None
    # たんぱく質が総カロリーの35%を超えないよう調整
    if protein_g and target_kcal and protein_g * 4 > target_kcal * 0.35:
        protein_g = int(target_kcal * 0.35 / 4)

    fat_g = carb_g = None
    if target_kcal:
        fat_g = round(target_kcal * 0.25 / 9)          # 脂質は総カロリーの25%
        rest = target_kcal - (protein_g or 0) * 4 - fat_g * 9
        carb_g = max(int(rest / 4), 0)

    # 目標達成までの見込み
    eta_days = eta_date = None
    to_lose = None
    if weight and goal_w and weight > goal_w and pace > 0:
        to_lose = round(weight - goal_w, 1)
        eta_days = int(to_lose / pace * 30.4)
        eta_date = (datetime.utcnow() + timedelta(hours=9) + timedelta(days=eta_days)).strftime("%Y-%m-%d")

    bmi = None
    if weight and height:
        bmi = round(weight / ((height / 100) ** 2), 1)

    return {
        "bmr_kcal": bmr,
        "activity_factor": level["factor"],
        "activity_label": level["label"],
        "tdee_kcal": tdee,
        "deficit_kcal": deficit,
        "target_kcal": target_kcal,
        "floor_kcal": floor_kcal,
        "target_limited": limited,      # 減量ペースが速すぎて下限に張り付いた
        "protein_g": protein_g,
        "fat_g": fat_g,
        "carb_g": carb_g,
        "salt_limit_g": SALT_LIMIT.get(sex, 7.5),
        "water_ml": round(weight * 35) if weight else None,
        "bmi": bmi,
        "goal_weight_kg": goal_w,
        "to_lose_kg": to_lose,
        "eta_days": eta_days,
        "eta_date": eta_date,
        "pace_kg_per_month": pace,
    }


def daily_totals(profile_id, date_str):
    """指定日の食事合計と運動消費量。"""
    with get_db() as conn:
        m = conn.execute(
            "SELECT COALESCE(SUM(kcal),0) kcal, COALESCE(SUM(protein_g),0) p, "
            "COALESCE(SUM(fat_g),0) f, COALESCE(SUM(carb_g),0) c, COALESCE(SUM(salt_g),0) s, "
            "COUNT(*) n FROM meal_logs WHERE profile_id = ? AND date = ?",
            (profile_id, date_str)).fetchone()
        e = conn.execute(
            "SELECT COALESCE(SUM(kcal),0) kcal, COALESCE(SUM(minutes),0) min, COUNT(*) n "
            "FROM exercise_logs WHERE profile_id = ? AND date = ?",
            (profile_id, date_str)).fetchone()
    return {
        "kcal": round(m["kcal"]), "protein_g": round(m["p"], 1), "fat_g": round(m["f"], 1),
        "carb_g": round(m["c"], 1), "salt_g": round(m["s"], 1), "meal_count": m["n"],
        "exercise_kcal": round(e["kcal"]), "exercise_min": round(e["min"]),
        "exercise_count": e["n"],
    }


def build_advice(profile, body, targets, totals, recent, date_str=None):
    """InBodyの数値と直近の記録から、その日のアドバイスを組み立てる。"""
    tips = []
    # 1日の途中で「食べなさすぎ」と出さないよう、過去日か夜の時間帯だけ判定する
    now_jst = datetime.utcnow() + timedelta(hours=9)
    day_finished = (date_str or jst_today()) < now_jst.strftime("%Y-%m-%d") or now_jst.hour >= 20
    sex = profile["sex"] or "male"
    std = STANDARD_RANGES.get(sex, STANDARD_RANGES["male"])
    ib = body.get("inbody")

    if ib:
        if ib["visceral_fat_level"] and ib["visceral_fat_level"] >= VISCERAL_FAT_LIMIT:
            tips.append({"level": "warn", "text":
                f"内臓脂肪レベル {ib['visceral_fat_level']:.0f}（標準は{VISCERAL_FAT_LIMIT}未満）。"
                "内臓脂肪は食事改善と有酸素運動で最も落ちやすい脂肪です。まずは間食・飲酒・夜遅い食事の見直しから。"})
        if ib["waist_cm"] and ib["waist_cm"] >= std["waist"]:
            tips.append({"level": "warn", "text":
                f"腹囲 {ib['waist_cm']:.0f}cm（基準は{std['waist']:.0f}cm未満）。"
                "体重より腹囲の変化のほうが早く出ます。月1回同じ条件で測りましょう。"})
        if ib["body_fat_pct"] and ib["body_fat_pct"] > std["fat_pct"][1]:
            tips.append({"level": "info", "text":
                f"体脂肪率 {ib['body_fat_pct']:.1f}%（標準 {std['fat_pct'][0]:.0f}〜{std['fat_pct'][1]:.0f}%）。"
                "筋肉量は保ったまま脂肪だけを減らすため、たんぱく質と筋トレは必ずセットで。"})
        if ib["muscle_kg"] and ib["fat_free_mass_kg"]:
            tips.append({"level": "ok", "text":
                f"骨格筋量 {ib['muscle_kg']:.1f}kg・除脂肪量 {ib['fat_free_mass_kg']:.1f}kg。"
                "この除脂肪量から基礎代謝を計算しています。ここを落とさないことが最重要です。"})

    if targets["target_limited"]:
        tips.append({"level": "warn", "text":
            "設定した減量ペースだと摂取カロリーが基礎代謝を下回るため、下限で止めています。"
            "ペースを落とすか、運動量を増やしてください。"})
    if targets["pace_kg_per_month"] and body.get("weight_kg"):
        pct = targets["pace_kg_per_month"] / body["weight_kg"] * 100
        if pct > 4:
            tips.append({"level": "warn", "text":
                f"減量ペースが体重の月{pct:.1f}%と速すぎます。筋肉が落ちやすいので月2〜4%（"
                f"約{body['weight_kg']*0.02:.1f}〜{body['weight_kg']*0.04:.1f}kg）に抑えましょう。"})

    if totals["meal_count"] == 0:
        tips.append({"level": "info", "text": "今日はまだ食事の記録がありません。食べたらすぐ記録するのが続けるコツです。"})
    else:
        t = targets["target_kcal"]
        if t:
            diff = totals["kcal"] - t
            if diff > 300:
                w = body.get("weight_kg") or 70
                walk = int(4.3 * w * 0.5 * 1.05)   # 速歩30分の消費量
                tips.append({"level": "warn", "text":
                    f"目標より {diff:.0f}kcal 超えています。夕食の主食を半分にする、"
                    f"または速歩30分（約{walk}kcal）で調整しましょう。"})
            elif diff < -600 and day_finished:
                tips.append({"level": "warn", "text":
                    f"目標より {abs(diff):.0f}kcal 少なめです。極端な不足は筋肉の減少と停滞の原因になります。たんぱく質を中心に足しましょう。"})
        if (day_finished or totals["meal_count"] >= 2) \
                and targets["protein_g"] and totals["protein_g"] < targets["protein_g"] * 0.8:
            short = targets["protein_g"] - totals["protein_g"]
            tips.append({"level": "info", "text":
                f"たんぱく質があと約{short:.0f}g不足。卵1個=6g、納豆1P=7g、サラダチキン1個=24g、プロテイン1杯=24g が目安です。"})
        if totals["salt_g"] > targets["salt_limit_g"]:
            tips.append({"level": "info", "text":
                f"食塩相当量が {totals['salt_g']:.1f}g（目標 {targets['salt_limit_g']}g未満）。むくみで体重が増えて見える原因になります。"})

    # 直近7日の体重トレンド
    weights = [r for r in recent if r.get("weight_kg")]
    if len(weights) >= 4:
        first, last = weights[0]["weight_kg"], weights[-1]["weight_kg"]
        delta = last - first
        if delta <= -0.2:
            tips.append({"level": "ok", "text": f"直近の記録で体重が {abs(delta):.1f}kg 減っています。今のペースを維持しましょう。"})
        elif delta >= 0.5:
            tips.append({"level": "warn", "text":
                f"直近で体重が {delta:.1f}kg 増えています。飲酒・塩分・週末の外食を振り返ってみましょう。"})

    if not any(t["level"] == "ok" for t in tips):
        tips.append({"level": "ok", "text": "毎日同じ条件（起床後・トイレ後・裸に近い状態）で体重を測ると、変化が正しく見えます。"})
    return tips


# ── 画面ルート ────────────────────────────────────────────

@diet_bp.route("/diet")
def diet_page():
    return render_template("diet.html")


# ── API: プロフィール ─────────────────────────────────────

@diet_bp.route("/api/diet/profiles")
def list_profiles():
    """管理ログイン時は全件。トークン指定時はその1件のみ。"""
    token = _req_token()
    with get_db() as conn:
        if _is_admin():
            rows = conn.execute("SELECT * FROM diet_profiles ORDER BY id").fetchall()
        elif token:
            rows = conn.execute("SELECT * FROM diet_profiles WHERE token = ?", (token,)).fetchall()
        else:
            return jsonify({"error": "Unauthorized"}), 401
    if not rows:
        return jsonify({"error": "Unauthorized"}), 401
    # jsonifyは辞書のキーを名前順に並べ替えるため、表示順を保ちたいものは配列で返す
    return jsonify({
        "is_admin": _is_admin(),
        "profiles": [dict(r) for r in rows],
        "activity_levels": [dict(key=k, **v) for k, v in ACTIVITY_LEVELS.items()],
        "meal_types": [{"key": k, "label": v} for k, v in MEAL_TYPES.items()],
    })


@diet_bp.route("/api/diet/profiles", methods=["POST"])
def create_profile():
    if not _is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    d = _payload()
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "お名前を入力してください"}), 400
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO diet_profiles "
            "(name, sex, age, height_cm, activity_level, goal_weight_kg, goal_fat_pct, "
            " goal_pace_kg, add_exercise, token, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (name, d.get("sex") or "male", _f(d.get("age")), _f(d.get("height_cm")),
             d.get("activity_level") or "mid", _f(d.get("goal_weight_kg")),
             _f(d.get("goal_fat_pct")), _f(d.get("goal_pace_kg"), 1.5),
             1 if d.get("add_exercise", True) else 0,
             secrets.token_urlsafe(12), (d.get("note") or "").strip()))
        pid = cur.lastrowid
    return jsonify({"ok": True, "id": pid})


@diet_bp.route("/api/diet/profiles/<int:pid>", methods=["PATCH"])
def update_profile(pid):
    profile, err = _profile_or_403(pid)
    if err:
        return err
    d = _payload()
    fields, values = [], []
    for key, conv in (("name", str), ("sex", str), ("age", _f), ("height_cm", _f),
                      ("activity_level", str), ("goal_weight_kg", _f), ("goal_fat_pct", _f),
                      ("goal_pace_kg", _f), ("note", str)):
        if key in d:
            fields.append(f"{key} = ?")
            values.append(conv(d[key]) if conv is not str else (d[key] or "").strip())
    if "add_exercise" in d:
        fields.append("add_exercise = ?")
        values.append(1 if d["add_exercise"] else 0)
    if not fields:
        return jsonify({"ok": True})
    values.append(pid)
    with get_db() as conn:
        conn.execute(f"UPDATE diet_profiles SET {', '.join(fields)} WHERE id = ?", values)
    return jsonify({"ok": True})


@diet_bp.route("/api/diet/profiles/<int:pid>", methods=["DELETE"])
def delete_profile(pid):
    if not _is_admin():
        return jsonify({"error": "Unauthorized"}), 401
    with get_db() as conn:
        for t in ("meal_logs", "exercise_logs", "body_logs", "inbody_records"):
            conn.execute(f"DELETE FROM {t} WHERE profile_id = ?", (pid,))
        conn.execute("DELETE FROM diet_profiles WHERE id = ?", (pid,))
    return jsonify({"ok": True})


# ── API: ダッシュボード ───────────────────────────────────

@diet_bp.route("/api/diet/profiles/<int:pid>/summary")
def profile_summary(pid):
    profile, err = _profile_or_403(pid)
    if err:
        return err
    date_str = request.args.get("date") or jst_today()
    body = latest_body(pid)
    targets = calc_targets(profile, body)
    totals = daily_totals(pid, date_str)

    with get_db() as conn:
        meals = conn.execute(
            "SELECT * FROM meal_logs WHERE profile_id = ? AND date = ? ORDER BY id",
            (pid, date_str)).fetchall()
        exercises = conn.execute(
            "SELECT * FROM exercise_logs WHERE profile_id = ? AND date = ? ORDER BY id",
            (pid, date_str)).fetchall()
        since = (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=59)).strftime("%Y-%m-%d")
        trend = conn.execute(
            "SELECT date, weight_kg, body_fat_pct FROM body_logs "
            "WHERE profile_id = ? AND date BETWEEN ? AND ? ORDER BY date",
            (pid, since, date_str)).fetchall()

    trend = [dict(r) for r in trend]
    std = STANDARD_RANGES.get(profile["sex"] or "male", STANDARD_RANGES["male"])
    # 運動分を目標に上乗せする設定なら、その日の実質目標を増やす
    effective_target = targets["target_kcal"]
    if effective_target and profile["add_exercise"]:
        effective_target += totals["exercise_kcal"]

    return jsonify({
        "date": date_str,
        "profile": dict(profile),
        "body": body,
        "targets": targets,
        "effective_target_kcal": effective_target,
        "totals": totals,
        "remaining_kcal": (effective_target - totals["kcal"]) if effective_target else None,
        "meals": [dict(r) for r in meals],
        "exercises": [dict(r) for r in exercises],
        "trend": trend,
        # 画面で「標準の範囲か」を色分けするための基準値
        "standards": {
            "bmi_max": std["bmi"][1],
            "fat_pct_min": std["fat_pct"][0],
            "fat_pct_max": std["fat_pct"][1],
            "waist_max": std["waist"],
            "visceral_max": VISCERAL_FAT_LIMIT,
        },
        "advice": build_advice(profile, body, targets, totals, trend[-14:], date_str),
    })


@diet_bp.route("/api/diet/profiles/<int:pid>/report")
def profile_report(pid):
    """週ごとの平均摂取カロリー・PFC・運動・体重をまとめる。"""
    profile, err = _profile_or_403(pid)
    if err:
        return err
    weeks = min(max(int(request.args.get("weeks", 8)), 1), 26)
    end = datetime.strptime(request.args.get("date") or jst_today(), "%Y-%m-%d")
    # 週は月曜はじまり
    end_week_start = end - timedelta(days=end.weekday())
    out = []
    with get_db() as conn:
        for i in range(weeks - 1, -1, -1):
            ws = end_week_start - timedelta(weeks=i)
            we = ws + timedelta(days=6)
            ws_s, we_s = ws.strftime("%Y-%m-%d"), we.strftime("%Y-%m-%d")
            m = conn.execute(
                "SELECT COUNT(DISTINCT date) days, COALESCE(SUM(kcal),0) kcal, "
                "COALESCE(SUM(protein_g),0) p, COALESCE(SUM(fat_g),0) f, COALESCE(SUM(carb_g),0) c "
                "FROM meal_logs WHERE profile_id = ? AND date BETWEEN ? AND ?",
                (pid, ws_s, we_s)).fetchone()
            e = conn.execute(
                "SELECT COALESCE(SUM(kcal),0) kcal, COALESCE(SUM(minutes),0) min, "
                "COUNT(DISTINCT date) days FROM exercise_logs "
                "WHERE profile_id = ? AND date BETWEEN ? AND ?",
                (pid, ws_s, we_s)).fetchone()
            w = conn.execute(
                "SELECT AVG(weight_kg) avg_w, MIN(weight_kg) min_w, MAX(weight_kg) max_w, COUNT(*) n "
                "FROM body_logs WHERE profile_id = ? AND date BETWEEN ? AND ? AND weight_kg IS NOT NULL",
                (pid, ws_s, we_s)).fetchone()
            days = m["days"] or 0
            out.append({
                "week_start": ws_s, "week_end": we_s,
                "logged_days": days,
                "avg_kcal": round(m["kcal"] / days) if days else None,
                "avg_protein_g": round(m["p"] / days, 1) if days else None,
                "avg_fat_g": round(m["f"] / days, 1) if days else None,
                "avg_carb_g": round(m["c"] / days, 1) if days else None,
                "exercise_kcal": round(e["kcal"]), "exercise_min": round(e["min"]),
                "exercise_days": e["days"] or 0,
                "avg_weight_kg": round(w["avg_w"], 1) if w["avg_w"] else None,
                "weight_days": w["n"] or 0,
            })
    # 前週との体重差
    prev = None
    for row in out:
        if row["avg_weight_kg"] is not None and prev is not None:
            row["weight_diff_kg"] = round(row["avg_weight_kg"] - prev, 1)
        else:
            row["weight_diff_kg"] = None
        if row["avg_weight_kg"] is not None:
            prev = row["avg_weight_kg"]
    return jsonify({"weeks": out})


# ── API: 食事記録 ─────────────────────────────────────────

@diet_bp.route("/api/diet/profiles/<int:pid>/meals", methods=["GET", "POST"])
def meals(pid):
    profile, err = _profile_or_403(pid)
    if err:
        return err

    if request.method == "GET":
        date_str = request.args.get("date") or jst_today()
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM meal_logs WHERE profile_id = ? AND date = ? ORDER BY id",
                (pid, date_str)).fetchall()
        return jsonify({"meals": [dict(r) for r in rows]})

    d = _payload()
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "メニュー名を入力してください"}), 400
    amount = _f(d.get("amount"), 1) or 1
    food = None
    if d.get("food_id"):
        with get_db() as conn:
            food = conn.execute("SELECT * FROM foods WHERE id = ?", (d["food_id"],)).fetchone()

    def val(key):
        """食品マスタが指定されていれば単位量×個数、なければ入力値をそのまま使う。"""
        if food is not None:
            return round(food[key] * amount, 1)
        return round(_f(d.get(key), 0) or 0, 1)

    with get_db() as conn:
        conn.execute(
            "INSERT INTO meal_logs "
            "(profile_id, date, meal_type, name, amount, kcal, protein_g, fat_g, carb_g, salt_g, note) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (pid, d.get("date") or jst_today(), d.get("meal_type") or "lunch", name, amount,
             val("kcal"), val("protein_g"), val("fat_g"), val("carb_g"), val("salt_g"),
             (d.get("note") or "").strip()))
    return jsonify({"ok": True})


@diet_bp.route("/api/diet/meals/<int:mid>", methods=["DELETE"])
def delete_meal(mid):
    _, err = _owned_row_or_403("meal_logs", mid)
    if err:
        return err
    with get_db() as conn:
        conn.execute("DELETE FROM meal_logs WHERE id = ?", (mid,))
    return jsonify({"ok": True})


# ── API: 運動記録 ─────────────────────────────────────────

@diet_bp.route("/api/diet/profiles/<int:pid>/exercises", methods=["GET", "POST"])
def exercises(pid):
    profile, err = _profile_or_403(pid)
    if err:
        return err

    if request.method == "GET":
        date_str = request.args.get("date") or jst_today()
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM exercise_logs WHERE profile_id = ? AND date = ? ORDER BY id",
                (pid, date_str)).fetchall()
        return jsonify({"exercises": [dict(r) for r in rows]})

    d = _payload()
    kind = (d.get("kind") or "").strip()
    if not kind:
        return jsonify({"error": "運動の種類を入力してください"}), 400
    minutes = _f(d.get("minutes"), 0) or 0
    mets = _f(d.get("mets"), 0) or 0
    kcal = _f(d.get("kcal"))
    if kcal is None:
        # 消費カロリー = METs × 体重kg × 時間 × 1.05
        weight = latest_body(pid).get("weight_kg") or 70
        kcal = round(mets * weight * (minutes / 60) * 1.05)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO exercise_logs (profile_id, date, kind, minutes, mets, kcal, note) "
            "VALUES (?,?,?,?,?,?,?)",
            (pid, d.get("date") or jst_today(), kind, minutes, mets, round(kcal),
             (d.get("note") or "").strip()))
    return jsonify({"ok": True})


@diet_bp.route("/api/diet/exercises/<int:eid>", methods=["DELETE"])
def delete_exercise(eid):
    _, err = _owned_row_or_403("exercise_logs", eid)
    if err:
        return err
    with get_db() as conn:
        conn.execute("DELETE FROM exercise_logs WHERE id = ?", (eid,))
    return jsonify({"ok": True})


@diet_bp.route("/api/diet/mets")
def mets_presets():
    return jsonify({"presets": METS_PRESETS})


# ── API: 体重記録・InBody ─────────────────────────────────

@diet_bp.route("/api/diet/profiles/<int:pid>/body-logs", methods=["GET", "POST"])
def body_logs(pid):
    profile, err = _profile_or_403(pid)
    if err:
        return err

    if request.method == "GET":
        days = min(max(int(request.args.get("days", 60)), 1), 365)
        since = (datetime.utcnow() + timedelta(hours=9) - timedelta(days=days)).strftime("%Y-%m-%d")
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM body_logs WHERE profile_id = ? AND date >= ? ORDER BY date",
                (pid, since)).fetchall()
        return jsonify({"logs": [dict(r) for r in rows]})

    d = _payload()
    weight = _f(d.get("weight_kg"))
    if weight is None:
        return jsonify({"error": "体重を入力してください"}), 400
    with get_db() as conn:
        # 同じ日付の記録は上書き
        conn.execute(
            "INSERT INTO body_logs (profile_id, date, weight_kg, body_fat_pct, note) "
            "VALUES (?,?,?,?,?) "
            "ON CONFLICT(profile_id, date) DO UPDATE SET "
            "weight_kg = excluded.weight_kg, body_fat_pct = excluded.body_fat_pct, note = excluded.note",
            (pid, d.get("date") or jst_today(), weight, _f(d.get("body_fat_pct")),
             (d.get("note") or "").strip()))
    return jsonify({"ok": True})


@diet_bp.route("/api/diet/body-logs/<int:bid>", methods=["DELETE"])
def delete_body_log(bid):
    _, err = _owned_row_or_403("body_logs", bid)
    if err:
        return err
    with get_db() as conn:
        conn.execute("DELETE FROM body_logs WHERE id = ?", (bid,))
    return jsonify({"ok": True})


INBODY_FIELDS = ("weight_kg", "body_fat_pct", "fat_mass_kg", "muscle_kg", "fat_free_mass_kg",
                 "body_water_kg", "protein_kg", "mineral_kg", "bmi", "visceral_fat_level",
                 "waist_cm", "bmr_kcal", "score")


@diet_bp.route("/api/diet/profiles/<int:pid>/inbody", methods=["GET", "POST"])
def inbody(pid):
    profile, err = _profile_or_403(pid)
    if err:
        return err

    if request.method == "GET":
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM inbody_records WHERE profile_id = ? ORDER BY measured_on DESC, id DESC",
                (pid,)).fetchall()
        return jsonify({"records": [dict(r) for r in rows]})

    d = _payload()
    vals = {k: _f(d.get(k)) for k in INBODY_FIELDS}
    if vals["weight_kg"] is None:
        return jsonify({"error": "体重を入力してください"}), 400
    # 未入力の項目は他の値から補完する
    if vals["body_fat_pct"] is not None and vals["fat_mass_kg"] is None:
        vals["fat_mass_kg"] = round(vals["weight_kg"] * vals["body_fat_pct"] / 100, 1)
    if vals["fat_mass_kg"] is not None and vals["body_fat_pct"] is None:
        vals["body_fat_pct"] = round(vals["fat_mass_kg"] / vals["weight_kg"] * 100, 1)
    if vals["fat_free_mass_kg"] is None and vals["fat_mass_kg"] is not None:
        vals["fat_free_mass_kg"] = round(vals["weight_kg"] - vals["fat_mass_kg"], 1)
    if vals["bmi"] is None and profile["height_cm"]:
        vals["bmi"] = round(vals["weight_kg"] / ((profile["height_cm"] / 100) ** 2), 1)
    if vals["bmr_kcal"] is None:
        vals["bmr_kcal"] = estimate_bmr(vals["fat_free_mass_kg"], vals["weight_kg"],
                                        profile["sex"], profile["age"])

    measured_on = d.get("measured_on") or jst_today()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO inbody_records (profile_id, measured_on, %s, note) "
            "VALUES (?,?,%s,?)" % (", ".join(INBODY_FIELDS), ",".join(["?"] * len(INBODY_FIELDS))),
            [pid, measured_on] + [vals[k] for k in INBODY_FIELDS] + [(d.get("note") or "").strip()])
        # InBody測定日の体重を体重グラフにも反映
        conn.execute(
            "INSERT INTO body_logs (profile_id, date, weight_kg, body_fat_pct, note) "
            "VALUES (?,?,?,?,'InBody測定') "
            "ON CONFLICT(profile_id, date) DO UPDATE SET "
            "weight_kg = excluded.weight_kg, body_fat_pct = excluded.body_fat_pct",
            (pid, measured_on, vals["weight_kg"], vals["body_fat_pct"]))
    return jsonify({"ok": True})


@diet_bp.route("/api/diet/inbody/<int:rid>", methods=["DELETE"])
def delete_inbody(rid):
    _, err = _owned_row_or_403("inbody_records", rid)
    if err:
        return err
    with get_db() as conn:
        conn.execute("DELETE FROM inbody_records WHERE id = ?", (rid,))
    return jsonify({"ok": True})


# ── API: 食品マスタ ───────────────────────────────────────

@diet_bp.route("/api/diet/foods")
def list_foods():
    q = (request.args.get("q") or "").strip()
    with get_db() as conn:
        if q:
            rows = conn.execute(
                "SELECT * FROM foods WHERE name LIKE ? ORDER BY is_preset DESC, id LIMIT 60",
                (f"%{q}%",)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM foods ORDER BY is_preset DESC, id").fetchall()
    return jsonify({"foods": [dict(r) for r in rows]})


@diet_bp.route("/api/diet/foods", methods=["POST"])
def create_food():
    d = _payload()
    name = (d.get("name") or "").strip()
    if not name:
        return jsonify({"error": "食品名を入力してください"}), 400
    # トークンだけの利用者も自分用の食品を登録できる（食品マスタは共有）
    if not _is_admin() and not _req_token():
        return jsonify({"error": "Unauthorized"}), 401
    with get_db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO foods (name, category, unit_label, kcal, protein_g, fat_g, carb_g, salt_g) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (name, d.get("category") or "その他", d.get("unit_label") or "1食",
                 _f(d.get("kcal"), 0), _f(d.get("protein_g"), 0), _f(d.get("fat_g"), 0),
                 _f(d.get("carb_g"), 0), _f(d.get("salt_g"), 0)))
            return jsonify({"ok": True, "id": cur.lastrowid})
        except sqlite3.IntegrityError:
            return jsonify({"error": "同じ名前の食品が既に登録されています"}), 400

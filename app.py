from flask import Flask, request, jsonify, session, redirect, render_template, url_for
from flask_cors import CORS
import sqlite3
import os
import smtplib
import threading
import json
import urllib.request
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, date, timedelta
from functools import wraps

try:
    import config as _cfg
    GMAIL_ADDRESS      = _cfg.GMAIL_ADDRESS
    GMAIL_APP_PASSWORD = _cfg.GMAIL_APP_PASSWORD
    NOTIFY_EMAIL       = _cfg.NOTIFY_EMAIL
    ALERT_EMAILS        = getattr(_cfg, "ALERT_EMAILS",        [])
    GCHAT_WEBHOOK_URL   = getattr(_cfg, "GCHAT_WEBHOOK_URL",   "")
    TWILIO_ACCOUNT_SID  = getattr(_cfg, "TWILIO_ACCOUNT_SID",  "")
    TWILIO_AUTH_TOKEN   = getattr(_cfg, "TWILIO_AUTH_TOKEN",   "")
    TWILIO_FROM_NUMBER  = getattr(_cfg, "TWILIO_FROM_NUMBER",  "")
    SMS_RECIPIENTS      = getattr(_cfg, "SMS_RECIPIENTS",      [])
except Exception:
    GMAIL_ADDRESS      = os.environ.get("GMAIL_ADDRESS", "")
    GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
    NOTIFY_EMAIL       = os.environ.get("NOTIFY_EMAIL", "")
    ALERT_EMAILS       = [e.strip() for e in os.environ.get("ALERT_EMAILS", "").split(",") if e.strip()]
    GCHAT_WEBHOOK_URL  = os.environ.get("GCHAT_WEBHOOK_URL", "")
    TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
    TWILIO_AUTH_TOKEN  = os.environ.get("TWILIO_AUTH_TOKEN", "")
    TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER", "")
    SMS_RECIPIENTS     = [n.strip() for n in os.environ.get("SMS_RECIPIENTS", "").split(",") if n.strip()]
try:
    import jpholiday
    def is_jp_holiday(date_str: str) -> bool:
        return bool(jpholiday.is_holiday(date.fromisoformat(date_str)))
    def jp_holiday_name(date_str: str) -> str:
        return jpholiday.is_holiday_name(date.fromisoformat(date_str)) or ""
except ImportError:
    def is_jp_holiday(date_str: str) -> bool:
        return False
    def jp_holiday_name(date_str: str) -> str:
        return ""

# 祝日は18:00以降のスロットを除外
HOLIDAY_CUTOFF = "18:00:00"

DOW_JA = ["月","火","水","木","金","土","日"]

def _make_body(res_id, customer_name, customer_phone, customer_note,
               date_str, time_str, slot_duration):
    """メール本文を生成"""
    return f"""きしもとカラダ整体 予約確認
{"="*40}

予約番号   : No.{res_id}
日時       : {date_str}  {time_str}〜（{slot_duration}分）
お名前     : {customer_name} 様
電話番号   : {customer_phone}
ご要望     : {customer_note or "（なし）"}
受付日時   : {datetime.now().strftime("%Y-%m-%d %H:%M")}

{"="*40}
きしもとカラダcondiTion
神戸市垂水区舞子
"""


def _send_one(to_addr, subject, body):
    """1通送信（SMTP接続込み）"""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = GMAIL_ADDRESS
    msg["To"]      = to_addr
    msg.attach(MIMEText(body, "plain", "utf-8"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as srv:
        srv.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        srv.send_message(msg)


def _send_email(res_id, customer_name, customer_phone, customer_email,
                customer_note, slot_date, slot_time, slot_duration):
    """予約確定メールを2通送信（別スレッド実行・失敗してもサーバーは止めない）"""
    if not GMAIL_APP_PASSWORD:
        return

    try:
        d = date.fromisoformat(slot_date)
        dow = DOW_JA[d.weekday()]
        date_str = f"{d.year}年{d.month}月{d.day}日（{dow}）"
        time_str = slot_time[:5]
        body = _make_body(res_id, customer_name, customer_phone,
                          customer_note, date_str, time_str, slot_duration)

        # ── Email 1: お客様へ予約確認 ──────────────────────
        if customer_email:
            try:
                _send_one(
                    customer_email,
                    f"【ご予約確定】きしもとカラダ整体 {date_str} {time_str}〜",
                    f"{customer_name} 様\n\nご予約が確定しました。\n\n" + body
                )
                print(f"[mail] お客様へ送信完了 → {customer_email}  No.{res_id}")
            except Exception as e:
                print(f"[mail] お客様メール失敗: {e}")

        # ── Email 2: オーナーへ新規予約通知 ────────────────
        try:
            _send_one(
                NOTIFY_EMAIL,
                f"【新規予約】{customer_name}様 {date_str} {time_str}〜",
                f"新しい予約が入りました。\n\n" + body
            )
            print(f"[mail] オーナーへ送信完了 → {NOTIFY_EMAIL}  No.{res_id}")
        except Exception as e:
            print(f"[mail] オーナーメール失敗: {e}")

    except Exception as e:
        print(f"[mail] メール処理エラー: {e}")


def _send_sms_all():
    """予約確定SMSを全受信者に送信（別スレッド実行・失敗してもサーバーは止めない）"""
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER):
        return   # Twilio未設定時はスキップ
    try:
        from twilio.rest import Client
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        msg = "kishimoto.karada.condition@gmail.comに予約メールが届きました"
        for to in SMS_RECIPIENTS:
            try:
                client.messages.create(body=msg, from_=TWILIO_FROM_NUMBER, to=to)
                print(f"[sms] 送信完了 → {to}")
            except Exception as e:
                print(f"[sms] 失敗 → {to}: {e}")
    except ImportError:
        print("[sms] twilioライブラリ未インストール: pip install twilio を実行してください")
    except Exception as e:
        print(f"[sms] SMS処理エラー: {e}")


def _send_gchat():
    """Google Chat Webhookに予約通知を送信（別スレッド実行・失敗してもサーバーは止めない）"""
    if not GCHAT_WEBHOOK_URL:
        return   # Webhook URL未設定時はスキップ
    try:
        payload = json.dumps({"text": "kishimoto.karada.condition@gmail.comに予約メールが届きました"}).encode("utf-8")
        req = urllib.request.Request(
            GCHAT_WEBHOOK_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
        print("[gchat] 送信完了")
    except Exception as e:
        print(f"[gchat] 送信失敗: {e}")


def _send_alert_emails(customer_name, date_str, time_str):
    """予約アラートを4名のメールアドレスに送信（別スレッド実行）"""
    if not ALERT_EMAILS or not GMAIL_APP_PASSWORD:
        return
    subject = "【予約が入りました】きしもとカラダ整体"
    body = f"予約が入りました。\n\nお名前: {customer_name} 様\n日時: {date_str} {time_str}〜\n\nきしもとカラダcondiTion"
    for to in ALERT_EMAILS:
        try:
            _send_one(to, subject, body)
            print(f"[alert] 送信完了 → {to}")
        except Exception as e:
            print(f"[alert] 失敗 → {to}: {e}")


app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "kishimoto-reservation-2026")
CORS(app, supports_credentials=True)

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "reservation.db"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "kishimoto2026")


# ── DB 初期化 ──────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS slots (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                date         TEXT NOT NULL,
                time         TEXT NOT NULL,
                duration     INTEGER DEFAULT 60,
                is_available INTEGER DEFAULT 1,
                created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(date, time)
            );
            CREATE TABLE IF NOT EXISTS reservations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                slot_id         INTEGER NOT NULL,
                customer_name   TEXT NOT NULL,
                customer_phone  TEXT NOT NULL,
                customer_note   TEXT,
                status          TEXT DEFAULT 'confirmed',
                created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (slot_id) REFERENCES slots(id)
            );
        """)


init_db()  # gunicorn起動時も含め、常にDB初期化を実行


# ── 認証 ─────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin"):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


# ── 画面ルート ────────────────────────────────────────────

@app.route("/")
def booking_page():
    return render_template("booking.html")


@app.route("/admin")
def admin_page():
    if not session.get("admin"):
        return redirect(url_for("admin_login_page"))
    return render_template("admin.html")


@app.route("/admin/login")
def admin_login_page():
    return render_template("admin_login.html")


# ── 管理者 API ────────────────────────────────────────────

@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json()
    if data.get("password") == ADMIN_PASSWORD:
        session["admin"] = True
        return jsonify({"ok": True})
    return jsonify({"error": "パスワードが違います"}), 401


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("admin", None)
    return jsonify({"ok": True})


@app.route("/api/admin/slots", methods=["POST"])
@login_required
def create_slot():
    """空き枠を追加（複数まとめて登録可）"""
    data = request.get_json()
    slots = data.get("slots", [])
    holiday_adjust = data.get("holiday_adjust", False)

    if not slots and data.get("date"):
        slots = [{"date": data["date"], "time": data["time"], "duration": data.get("duration", 60)}]

    with get_db() as conn:
        inserted = 0
        for s in slots:
            t = s.get("time", "")
            # 祝日は HOLIDAY_CUTOFF 以降のスロットをスキップ
            if holiday_adjust and is_jp_holiday(s["date"]) and t >= HOLIDAY_CUTOFF:
                continue
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO slots (date, time, duration) VALUES (?,?,?)",
                    (s["date"], t, s.get("duration", 45)),
                )
                if conn.execute("SELECT changes()").fetchone()[0]:
                    inserted += 1
            except Exception:
                pass
    return jsonify({"ok": True, "inserted": inserted})


@app.route("/api/holidays")
def get_holidays():
    """month=YYYY-MM 形式で祝日一覧を返す"""
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    try:
        y, m = map(int, month.split("-"))
    except ValueError:
        return jsonify({}), 400

    last_day = (date(y, m % 12 + 1, 1) - timedelta(days=1)).day if m < 12 else 31
    result = {}
    for d in range(1, last_day + 1):
        try:
            ds = date(y, m, d).isoformat()
            name = jp_holiday_name(ds)
            if name:
                result[ds] = name
        except ValueError:
            break
    return jsonify(result)


@app.route("/api/admin/slots/<int:slot_id>", methods=["PATCH"])
@login_required
def update_slot(slot_id):
    data = request.get_json()
    fields = []
    params = []
    if "is_available" in data:
        fields.append("is_available=?")
        params.append(int(data["is_available"]))
    if not fields:
        return jsonify({"error": "No fields"}), 400
    params.append(slot_id)
    with get_db() as conn:
        conn.execute(f"UPDATE slots SET {', '.join(fields)} WHERE id=?", params)
    return jsonify({"ok": True})


@app.route("/api/admin/slots/<int:slot_id>", methods=["DELETE"])
@login_required
def delete_slot(slot_id):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM reservations WHERE slot_id=? AND status='confirmed'", (slot_id,)).fetchone()
        if row:
            return jsonify({"error": "この枠には予約があります。先に予約をキャンセルしてください。"}), 400
        conn.execute("DELETE FROM slots WHERE id=?", (slot_id,))
    return jsonify({"ok": True})


@app.route("/api/admin/reservations")
@login_required
def list_reservations():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT r.id, r.customer_name, r.customer_phone, r.customer_note,
                   r.status, r.created_at,
                   s.date, s.time, s.duration
            FROM reservations r
            JOIN slots s ON r.slot_id = s.id
            WHERE r.status = 'confirmed'
            ORDER BY s.date, s.time
        """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/reservations/<int:res_id>", methods=["PATCH"])
@login_required
def update_reservation(res_id):
    data = request.get_json()
    if data.get("status") == "cancelled":
        with get_db() as conn:
            conn.execute("UPDATE reservations SET status='cancelled' WHERE id=?", (res_id,))
        return jsonify({"ok": True})
    return jsonify({"error": "Unknown action"}), 400


@app.route("/api/admin/calendar")
@login_required
def admin_calendar():
    """month=YYYY-MM 形式で月間スロット一覧を返す"""
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.id, s.date, s.time, s.duration, s.is_available,
                   (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
            FROM slots s
            WHERE s.date LIKE ?
            ORDER BY s.date, s.time
        """, (month + "%",)).fetchall()
    return jsonify([dict(r) for r in rows])


# ── 顧客向け API ──────────────────────────────────────────

@app.route("/api/slots")
def get_slots():
    """date=YYYY-MM-DD で利用可能な空き枠を返す"""
    req_date = request.args.get("date")
    if not req_date:
        return jsonify({"error": "date required"}), 400
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.id, s.date, s.time, s.duration,
                   (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
            FROM slots s
            WHERE s.date=? AND s.is_available=1
            ORDER BY s.time
        """, (req_date,)).fetchall()
    holiday = is_jp_holiday(req_date)
    result = [
        dict(r) for r in rows
        if r["booked"] == 0
        and not (holiday and r["time"] >= HOLIDAY_CUTOFF)
    ]
    return jsonify(result)


@app.route("/api/slots/calendar")
def slots_calendar():
    """今日から30日間、日付ごとの空き有無を返す"""
    today = date.today()
    dates = {}
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.date,
                   COUNT(*) as total,
                   SUM(CASE WHEN s.is_available=1 AND
                       (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed')=0
                       THEN 1 ELSE 0 END) as available
            FROM slots s
            WHERE s.date >= ?
            GROUP BY s.date
        """, (today.isoformat(),)).fetchall()
    for r in rows:
        dates[r["date"]] = {"total": r["total"], "available": r["available"]}
    return jsonify(dates)


@app.route("/api/reservations", methods=["POST"])
def create_reservation():
    data = request.get_json()
    slot_id = data.get("slot_id")
    name  = (data.get("customer_name")  or "").strip()
    phone = (data.get("customer_phone") or "").strip()
    email = (data.get("customer_email") or "").strip()
    note  = (data.get("customer_note")  or "").strip()

    if not slot_id or not name or not phone or not email:
        return jsonify({"error": "必須項目が不足しています"}), 400

    with get_db() as conn:
        slot = conn.execute(
            "SELECT * FROM slots WHERE id=? AND is_available=1", (slot_id,)
        ).fetchone()
        if not slot:
            return jsonify({"error": "この枠は存在しません"}), 404

        existing = conn.execute(
            "SELECT id FROM reservations WHERE slot_id=? AND status='confirmed'", (slot_id,)
        ).fetchone()
        if existing:
            return jsonify({"error": "この時間帯はすでに予約済みです"}), 409

        cur = conn.execute(
            "INSERT INTO reservations (slot_id, customer_name, customer_phone, customer_email, customer_note) VALUES (?,?,?,?,?)",
            (slot_id, name, phone, email, note),
        )
        res_id = cur.lastrowid

    # 予約確定メールを別スレッドで送信（失敗しても予約は確定）
    threading.Thread(
        target=_send_email,
        args=(res_id, name, phone, email, note,
              slot["date"], slot["time"], slot["duration"]),
        daemon=True,
    ).start()

    # SMS通知を別スレッドで送信（Twilio設定済み時のみ動作）
    threading.Thread(target=_send_sms_all, daemon=True).start()

    # Google Chat通知を別スレッドで送信（Webhook URL設定済み時のみ動作）
    threading.Thread(target=_send_gchat, daemon=True).start()

    # 予約アラートメールを4名に送信
    threading.Thread(
        target=_send_alert_emails,
        args=(name, slot["date"], slot["time"]),
        daemon=True,
    ).start()

    return jsonify({
        "ok": True,
        "reservation_id": res_id,
        "date": slot["date"],
        "time": slot["time"],
        "duration": slot["duration"],
        "customer_name": name,
    })


# ── 起動 ─────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    print("予約管理システム起動: http://localhost:5050")
    print("管理画面: http://localhost:5050/admin")
    app.run(host="0.0.0.0", port=5050, debug=True)

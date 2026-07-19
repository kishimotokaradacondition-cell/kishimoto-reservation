from flask import Flask, request, jsonify, session, redirect, render_template, url_for
from flask_cors import CORS
import sqlite3
import os
import smtplib
import threading
import json
import time
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
    _cfg = None
    GMAIL_ADDRESS      = os.environ.get("GMAIL_ADDRESS", "")
    GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
    NOTIFY_EMAIL       = os.environ.get("NOTIFY_EMAIL", "")
    ALERT_EMAILS       = [e.strip() for e in os.environ.get("ALERT_EMAILS", "").split(",") if e.strip()]
    GCHAT_WEBHOOK_URL  = os.environ.get("GCHAT_WEBHOOK_URL", "")
    TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
    TWILIO_AUTH_TOKEN  = os.environ.get("TWILIO_AUTH_TOKEN", "")
    TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER", "")
    SMS_RECIPIENTS     = [n.strip() for n in os.environ.get("SMS_RECIPIENTS", "").split(",") if n.strip()]

# SendGrid APIキー（設定されていればSMTPの代わりにHTTPS APIでメール送信）
SENDGRID_API_KEY = getattr(_cfg, "SENDGRID_API_KEY", "") if _cfg else ""
SENDGRID_API_KEY = SENDGRID_API_KEY or os.environ.get("SENDGRID_API_KEY", "")

# 送信元アドレス（ドメイン認証済みアドレス推奨。未設定時はGmailアドレス）
MAIL_FROM = (getattr(_cfg, "MAIL_FROM", "") if _cfg else "") or os.environ.get("MAIL_FROM", "") or GMAIL_ADDRESS

# ── Stripe（コンサルティング事前決済用） ──────────────────
# STRIPE_SECRET_KEY を設定すると /consulting の予約が事前カード決済必須になる
STRIPE_SECRET_KEY     = (getattr(_cfg, "STRIPE_SECRET_KEY", "") if _cfg else "") or os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = (getattr(_cfg, "STRIPE_WEBHOOK_SECRET", "") if _cfg else "") or os.environ.get("STRIPE_WEBHOOK_SECRET", "")
# カウンセリング料金（円・税込）
CONSULTING_PRICE = int((getattr(_cfg, "CONSULTING_PRICE", 0) if _cfg else 0) or os.environ.get("CONSULTING_PRICE", "10000"))
# 決済ページからの戻り先URL（未設定時はリクエストのホストから自動判定）
BASE_URL = (getattr(_cfg, "BASE_URL", "") if _cfg else "") or os.environ.get("BASE_URL", "")
# 未決済の仮予約を解放するまでの分数
PENDING_EXPIRE_MINUTES = 30

try:
    import stripe
    if STRIPE_SECRET_KEY:
        stripe.api_key = STRIPE_SECRET_KEY
except ImportError:
    stripe = None

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

# サービス種別ラベル
SERVICE_LABELS = {
    "seitai": "きしもとカラダ整体",
    "hoken": "保険診療",
    "consulting": "きしもとマネジメントオフィス コンサルティング",
}

def service_label(service):
    return SERVICE_LABELS.get(service or "seitai", "きしもとカラダ整体")

def _make_body(res_id, customer_name, customer_phone, customer_note,
               date_str, time_str, slot_duration, label="きしもとカラダ整体",
               paid_amount=None):
    """メール本文を生成"""
    paid_line = f"お支払い   : クレジットカード決済済み（¥{paid_amount:,}）\n" if paid_amount else ""
    return f"""{label} 予約確認
{"="*40}

予約番号   : No.{res_id}
日時       : {date_str}  {time_str}〜（{slot_duration}分）
お名前     : {customer_name} 様
電話番号   : {customer_phone}
ご要望     : {customer_note or "（なし）"}
{paid_line}受付日時   : {datetime.now().strftime("%Y-%m-%d %H:%M")}

{"="*40}
きしもとカラダcondiTion
神戸市垂水区舞子
"""


def _send_one(to_addr, subject, body):
    """1通送信（SendGrid API優先・未設定時はGmail SMTP）"""
    if SENDGRID_API_KEY:
        payload = json.dumps({
            "personalizations": [{"to": [{"email": to_addr}]}],
            "from": {"email": MAIL_FROM, "name": "きしもとカラダ整体"},
            "reply_to": {"email": NOTIFY_EMAIL or GMAIL_ADDRESS},
            "subject": subject,
            "content": [{"type": "text/plain", "value": body}],
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.sendgrid.com/v3/mail/send",
            data=payload,
            headers={
                "Authorization": f"Bearer {SENDGRID_API_KEY}",
                "Content-Type": "application/json",
            },
        )
        urllib.request.urlopen(req, timeout=10)
        return
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = GMAIL_ADDRESS
    msg["To"]      = to_addr
    msg.attach(MIMEText(body, "plain", "utf-8"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as srv:
        srv.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        srv.send_message(msg)


def _send_email(res_id, customer_name, customer_phone, customer_email,
                customer_note, slot_date, slot_time, slot_duration, service="seitai",
                paid_amount=None):
    """予約確定メールを2通送信（別スレッド実行・失敗してもサーバーは止めない）"""
    if not (GMAIL_APP_PASSWORD or SENDGRID_API_KEY):
        return

    try:
        label = service_label(service)
        d = date.fromisoformat(slot_date)
        dow = DOW_JA[d.weekday()]
        date_str = f"{d.year}年{d.month}月{d.day}日（{dow}）"
        time_str = slot_time[:5]
        body = _make_body(res_id, customer_name, customer_phone,
                          customer_note, date_str, time_str, slot_duration, label,
                          paid_amount)

        # ── Email 1: お客様へ予約確認 ──────────────────────
        if customer_email:
            try:
                _send_one(
                    customer_email,
                    f"【ご予約確定】{label} {date_str} {time_str}〜",
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


def _send_alert_emails(customer_name, date_str, time_str, service="seitai"):
    """予約アラートを4名のメールアドレスに送信（別スレッド実行）"""
    if not ALERT_EMAILS or not (GMAIL_APP_PASSWORD or SENDGRID_API_KEY):
        return
    label = service_label(service)
    subject = f"【予約が入りました】{label}"
    body = f"予約が入りました。\n\n種別: {label}\nお名前: {customer_name} 様\n日時: {date_str} {time_str}〜\n\nきしもとカラダcondiTion"
    for to in ALERT_EMAILS:
        try:
            _send_one(to, subject, body)
            print(f"[alert] 送信完了 → {to}")
        except Exception as e:
            print(f"[alert] 失敗 → {to}: {e}")


def _notify_confirmed(res_id, name, phone, email, note,
                      slot_date, slot_time, slot_duration, service, paid_amount=None):
    """予約確定時の通知一式（メール・SMS・Google Chat・アラート）を別スレッドで送信"""
    threading.Thread(
        target=_send_email,
        args=(res_id, name, phone, email, note,
              slot_date, slot_time, slot_duration, service, paid_amount),
        daemon=True,
    ).start()
    threading.Thread(target=_send_sms_all, daemon=True).start()
    threading.Thread(target=_send_gchat, daemon=True).start()
    threading.Thread(
        target=_send_alert_emails,
        args=(name, slot_date, slot_time, service),
        daemon=True,
    ).start()


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
                service      TEXT DEFAULT 'seitai',
                UNIQUE(date, time, service)
            );
            CREATE TABLE IF NOT EXISTS reservations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                slot_id         INTEGER NOT NULL,
                customer_name   TEXT NOT NULL,
                customer_phone  TEXT NOT NULL,
                customer_email  TEXT,
                customer_note   TEXT,
                status          TEXT DEFAULT 'confirmed',
                created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (slot_id) REFERENCES slots(id)
            );
        """)
        # 既存DBに customer_email 列がない場合は追加（マイグレーション）
        try:
            conn.execute("ALTER TABLE reservations ADD COLUMN customer_email TEXT")
        except Exception:
            pass
        # 既存DBに service 列がない場合は追加（整体=seitai / 保険=hoken）
        try:
            conn.execute("ALTER TABLE slots ADD COLUMN service TEXT DEFAULT 'seitai'")
        except Exception:
            pass
        # 事前決済用の列を追加（マイグレーション）
        for ddl in (
            "ALTER TABLE reservations ADD COLUMN payment_status TEXT",
            "ALTER TABLE reservations ADD COLUMN amount INTEGER",
            "ALTER TABLE reservations ADD COLUMN stripe_session_id TEXT",
            "ALTER TABLE reservations ADD COLUMN paid_at TEXT",
        ):
            try:
                conn.execute(ddl)
            except Exception:
                pass
        # UNIQUE(date,time) → UNIQUE(date,time,service) へ移行
        # （整体と保険で同じ日時の枠を持てるようにする）
        try:
            ddl = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='slots'"
            ).fetchone()[0]
            if "UNIQUE(date, time)" in ddl and "UNIQUE(date, time, service)" not in ddl:
                conn.executescript("""
                    CREATE TABLE slots_new (
                        id           INTEGER PRIMARY KEY AUTOINCREMENT,
                        date         TEXT NOT NULL,
                        time         TEXT NOT NULL,
                        duration     INTEGER DEFAULT 60,
                        is_available INTEGER DEFAULT 1,
                        created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
                        service      TEXT DEFAULT 'seitai',
                        UNIQUE(date, time, service)
                    );
                    INSERT INTO slots_new (id, date, time, duration, is_available, created_at, service)
                        SELECT id, date, time, duration, is_available, created_at, service FROM slots;
                    DROP TABLE slots;
                    ALTER TABLE slots_new RENAME TO slots;
                """)
        except Exception:
            pass


init_db()  # gunicorn起動時も含め、常にDB初期化を実行


def _expire_stale_pending(conn):
    """支払い期限切れの仮予約を解放（枠を再度予約可能にする）"""
    conn.execute(
        "UPDATE reservations SET status='expired' "
        "WHERE status='pending_payment' AND created_at <= datetime('now', ?)",
        (f"-{PENDING_EXPIRE_MINUTES} minutes",),
    )


# 枠を塞ぐ予約ステータス（確定＋支払い待ちの仮予約）
ACTIVE_STATUS_SQL = "status IN ('confirmed','pending_payment')"


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
    return render_template("booking.html", service="seitai")


@app.route("/hoken")
def hoken_booking_page():
    return render_template("booking.html", service="hoken")


@app.route("/consulting")
def consulting_booking_page():
    return render_template("booking.html", service="consulting", price=CONSULTING_PRICE)


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
            svc = s.get("service", "seitai")
            # 祝日は HOLIDAY_CUTOFF 以降のスロットをスキップ（整体のみ）
            if holiday_adjust and svc == "seitai" and is_jp_holiday(s["date"]) and t >= HOLIDAY_CUTOFF:
                continue
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO slots (date, time, duration, service) VALUES (?,?,?,?)",
                    (s["date"], t, s.get("duration", 45), svc),
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
        _expire_stale_pending(conn)
        row = conn.execute(f"SELECT id FROM reservations WHERE slot_id=? AND {ACTIVE_STATUS_SQL}", (slot_id,)).fetchone()
        if row:
            return jsonify({"error": "この枠には予約があります。先に予約をキャンセルしてください。"}), 400
        conn.execute("DELETE FROM slots WHERE id=?", (slot_id,))
    return jsonify({"ok": True})


@app.route("/api/admin/reservations")
@login_required
def list_reservations():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT r.id, r.slot_id, r.customer_name, r.customer_phone, r.customer_note,
                   r.status, r.created_at, r.payment_status, r.amount,
                   s.date, s.time, s.duration, s.service
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
        _expire_stale_pending(conn)
        rows = conn.execute(f"""
            SELECT s.id, s.date, s.time, s.duration, s.is_available, s.service,
                   (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.{ACTIVE_STATUS_SQL}) AS booked
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
    service = request.args.get("service", "seitai")
    if not req_date:
        return jsonify({"error": "date required"}), 400
    with get_db() as conn:
        _expire_stale_pending(conn)
        rows = conn.execute(f"""
            SELECT s.id, s.date, s.time, s.duration, s.service,
                   (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.{ACTIVE_STATUS_SQL}) AS booked
            FROM slots s
            WHERE s.date=? AND s.is_available=1 AND s.service=?
            ORDER BY s.time
        """, (req_date, service)).fetchall()
    holiday = is_jp_holiday(req_date)
    result = [
        dict(r) for r in rows
        if r["booked"] == 0
        and not (holiday and service == "seitai" and r["time"] >= HOLIDAY_CUTOFF)
    ]
    return jsonify(result)


@app.route("/api/slots/calendar")
def slots_calendar():
    """今日から30日間、日付ごとの空き有無を返す"""
    today = date.today()
    service = request.args.get("service", "seitai")
    dates = {}
    with get_db() as conn:
        _expire_stale_pending(conn)
        rows = conn.execute(f"""
            SELECT s.date,
                   COUNT(*) as total,
                   SUM(CASE WHEN s.is_available=1 AND
                       (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.{ACTIVE_STATUS_SQL})=0
                       THEN 1 ELSE 0 END) as available
            FROM slots s
            WHERE s.date >= ? AND s.service = ?
            GROUP BY s.date
        """, (today.isoformat(), service)).fetchall()
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
        _expire_stale_pending(conn)
        slot = conn.execute(
            "SELECT * FROM slots WHERE id=? AND is_available=1", (slot_id,)
        ).fetchone()
        if not slot:
            return jsonify({"error": "この枠は存在しません"}), 404

        existing = conn.execute(
            f"SELECT id FROM reservations WHERE slot_id=? AND {ACTIVE_STATUS_SQL}", (slot_id,)
        ).fetchone()
        if existing:
            return jsonify({"error": "この時間帯はすでに予約済みです"}), 409

        slot_service = slot["service"] if "service" in slot.keys() else "seitai"
        # コンサルティングはStripe設定済みなら事前決済必須（仮予約で枠を確保）
        needs_payment = (slot_service == "consulting" and STRIPE_SECRET_KEY and stripe is not None)
        status = "pending_payment" if needs_payment else "confirmed"

        cur = conn.execute(
            "INSERT INTO reservations (slot_id, customer_name, customer_phone, customer_email, customer_note, status, amount) VALUES (?,?,?,?,?,?,?)",
            (slot_id, name, phone, email, note, status,
             CONSULTING_PRICE if needs_payment else None),
        )
        res_id = cur.lastrowid

    if needs_payment:
        d = date.fromisoformat(slot["date"])
        dt_label = f"{d.year}年{d.month}月{d.day}日（{DOW_JA[d.weekday()]}）{slot['time'][:5]}〜"
        try:
            base = (BASE_URL or request.url_root).rstrip("/")
            if base.startswith("http://") and "localhost" not in base and "127.0.0.1" not in base:
                base = "https://" + base[len("http://"):]
            checkout = stripe.checkout.Session.create(
                mode="payment",
                line_items=[{
                    "price_data": {
                        "currency": "jpy",
                        "unit_amount": CONSULTING_PRICE,
                        "product_data": {
                            "name": f"カウンセリング {dt_label}",
                            "description": service_label(slot_service),
                        },
                    },
                    "quantity": 1,
                }],
                customer_email=email,
                client_reference_id=str(res_id),
                metadata={"reservation_id": str(res_id)},
                success_url=f"{base}/payment/success?session_id={{CHECKOUT_SESSION_ID}}",
                cancel_url=f"{base}/payment/cancel?rid={res_id}",
                expires_at=int(time.time()) + PENDING_EXPIRE_MINUTES * 60,
            )
        except Exception as e:
            print(f"[stripe] Checkoutセッション作成失敗: {e}")
            with get_db() as conn:
                conn.execute("UPDATE reservations SET status='cancelled' WHERE id=?", (res_id,))
            return jsonify({"error": "決済ページの作成に失敗しました。時間をおいて再度お試しください。"}), 502

        with get_db() as conn:
            conn.execute("UPDATE reservations SET stripe_session_id=? WHERE id=?",
                         (checkout.id, res_id))
        return jsonify({
            "ok": True,
            "payment_required": True,
            "checkout_url": checkout.url,
            "reservation_id": res_id,
        })

    # 事前決済なし（整体・保険・Stripe未設定時）はここで確定・通知
    _notify_confirmed(res_id, name, phone, email, note,
                      slot["date"], slot["time"], slot["duration"], slot_service)

    return jsonify({
        "ok": True,
        "reservation_id": res_id,
        "date": slot["date"],
        "time": slot["time"],
        "duration": slot["duration"],
        "customer_name": name,
    })


# ── Stripe 決済 ───────────────────────────────────────────

def _confirm_paid_reservation(res_id):
    """支払い完了した仮予約を確定し、初回確定時のみ通知を送信（冪等）"""
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE reservations SET status='confirmed', payment_status='paid', paid_at=datetime('now') "
            "WHERE id=? AND status='pending_payment'", (res_id,))
        newly_confirmed = cur.rowcount > 0
        row = conn.execute("""
            SELECT r.*, s.date AS slot_date, s.time AS slot_time, s.duration, s.service
            FROM reservations r JOIN slots s ON r.slot_id = s.id
            WHERE r.id=?
        """, (res_id,)).fetchone()
    if newly_confirmed and row:
        print(f"[stripe] 支払い確認・予約確定 No.{res_id}")
        _notify_confirmed(res_id, row["customer_name"], row["customer_phone"],
                          row["customer_email"], row["customer_note"],
                          row["slot_date"], row["slot_time"], row["duration"],
                          row["service"], paid_amount=row["amount"])
    return row


def _session_reservation_id(sess):
    rid = sess.get("client_reference_id") or (sess.get("metadata") or {}).get("reservation_id")
    return int(rid) if rid else None


@app.route("/api/stripe/webhook", methods=["POST"])
def stripe_webhook():
    """Stripeからの決済イベント通知を受信"""
    if stripe is None or not STRIPE_SECRET_KEY:
        return jsonify({"error": "stripe not configured"}), 503

    payload = request.get_data()
    try:
        if STRIPE_WEBHOOK_SECRET:
            event = stripe.Webhook.construct_event(
                payload, request.headers.get("Stripe-Signature", ""), STRIPE_WEBHOOK_SECRET)
        else:
            # 署名シークレット未設定時は、通知内容を信用せずStripe APIから取り直して検証
            event = json.loads(payload)
    except Exception as e:
        print(f"[stripe] Webhook検証失敗: {e}")
        return jsonify({"error": "invalid payload"}), 400

    etype = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}

    if etype == "checkout.session.completed":
        if not STRIPE_WEBHOOK_SECRET:
            try:
                obj = stripe.checkout.Session.retrieve(obj.get("id"))
            except Exception as e:
                print(f"[stripe] セッション再取得失敗: {e}")
                return jsonify({"error": "session fetch failed"}), 400
        rid = _session_reservation_id(obj)
        if rid and obj.get("payment_status") == "paid":
            _confirm_paid_reservation(rid)
    elif etype == "checkout.session.expired":
        rid = _session_reservation_id(obj)
        if rid:
            with get_db() as conn:
                conn.execute(
                    "UPDATE reservations SET status='expired' WHERE id=? AND status='pending_payment'",
                    (rid,))
            print(f"[stripe] 支払い期限切れ・仮予約解放 No.{rid}")

    return jsonify({"ok": True})


@app.route("/payment/success")
def payment_success():
    """決済完了後の戻りページ（Webhookが届く前でもここで確定させる）"""
    session_id = request.args.get("session_id", "")
    if not (stripe and STRIPE_SECRET_KEY and session_id):
        return render_template("payment_result.html", ok=False,
                               message="決済情報を確認できませんでした。お店までお問い合わせください。")
    try:
        sess = stripe.checkout.Session.retrieve(session_id)
    except Exception as e:
        print(f"[stripe] セッション取得失敗: {e}")
        return render_template("payment_result.html", ok=False,
                               message="決済情報の確認に失敗しました。お店までお問い合わせください。")

    rid = _session_reservation_id(sess)
    if rid and sess.get("payment_status") == "paid":
        row = _confirm_paid_reservation(rid)
        if row:
            d = date.fromisoformat(row["slot_date"])
            dt_label = f"{d.year}年{d.month}月{d.day}日（{DOW_JA[d.weekday()]}）{row['slot_time'][:5]}〜"
            return render_template("payment_result.html", ok=True,
                                   res_id=rid, dt_label=dt_label,
                                   customer_name=row["customer_name"],
                                   amount=row["amount"])
    return render_template("payment_result.html", ok=False,
                           message="お支払いが完了していません。お手数ですが再度ご予約ください。")


@app.route("/payment/cancel")
def payment_cancel():
    """決済ページで「戻る」した場合：仮予約を取り消して枠を解放"""
    rid = request.args.get("rid", "")
    if rid.isdigit():
        with get_db() as conn:
            conn.execute(
                "UPDATE reservations SET status='cancelled' WHERE id=? AND status='pending_payment'",
                (int(rid),))
    return render_template("payment_result.html", ok=False, cancelled=True,
                           message="お支払いがキャンセルされました。予約は確定していません。")


# ── 起動 ─────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    print("予約管理システム起動: http://localhost:5050")
    print("管理画面: http://localhost:5050/admin")
    app.run(host="0.0.0.0", port=5050, debug=True)

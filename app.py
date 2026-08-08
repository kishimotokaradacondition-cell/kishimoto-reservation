from flask import Flask, request, jsonify, session, redirect, render_template, url_for
from flask_cors import CORS
import sqlite3
import os
import smtplib
import threading
import json
import urllib.request
import urllib.parse
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

# Googleカレンダー連携（Google Apps Script Webhook）
# 設定手順は docs/google-calendar-setup.md を参照
GCAL_WEBHOOK_URL   = (getattr(_cfg, "GCAL_WEBHOOK_URL", "")   if _cfg else "") or os.environ.get("GCAL_WEBHOOK_URL", "")
GCAL_WEBHOOK_TOKEN = (getattr(_cfg, "GCAL_WEBHOOK_TOKEN", "") if _cfg else "") or os.environ.get("GCAL_WEBHOOK_TOKEN", "")

# 送信元アドレス（ドメイン認証済みアドレス推奨。未設定時はGmailアドレス）
MAIL_FROM = (getattr(_cfg, "MAIL_FROM", "") if _cfg else "") or os.environ.get("MAIL_FROM", "") or GMAIL_ADDRESS

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
    "hoken":  "保険診療",
    "online": "オンラインカウンセリング整体",
}

# ── オンラインカウンセリング整体 ─────────────────────────
# 30分 税込3,300円・前払い制（Stripe決済リンク）
# 受付時間: 火・日 12:00〜22:00 ／ 月・水〜土 21:00〜22:00
ONLINE_PRICE_LABEL = "30分 税込3,300円"
ONLINE_CANCEL_POLICY = "キャンセルは自由ですが、キャンセルによるご返金はいたしかねます。"
# Stripeの決済リンクURL（きしもとマネジメントオフィスのStripeで作成した
# 3,300円のPayment LinkのURLを設定する。未設定時はメール・画面に案内文のみ表示）
STRIPE_PAYMENT_LINK_URL = (getattr(_cfg, "STRIPE_PAYMENT_LINK_URL", "") if _cfg else "") \
    or os.environ.get("STRIPE_PAYMENT_LINK_URL", "")
# Stripe Webhookの署名シークレット（whsec_...）。
# Stripeダッシュボード → 開発者 → Webhook でエンドポイント
# https://＜このアプリのURL＞/api/stripe/webhook を登録すると発行される。
# 設定すると、入金完了が予約に自動記録され、オーナーへ入金確認メールが届く。
STRIPE_WEBHOOK_SECRET = (getattr(_cfg, "STRIPE_WEBHOOK_SECRET", "") if _cfg else "") \
    or os.environ.get("STRIPE_WEBHOOK_SECRET", "")
# 21:00より前の枠を開けられる曜日（火=1・日=6。それ以外は21:00〜のみ）
ONLINE_FULLDAY_WEEKDAYS = (1, 6)

# ── Instagram誘導リンク（/ig ページ → /go/<key> 経由で計測して転送）──
HOMEPAGE_URL = "https://www.kishimotocondition.com/"
SHOP_PHONE   = "078-785-5251"

IG_LINKS = {
    # ホームページにはUTMパラメータを付けて、Wix/GAの解析でInstagram経由と分かるようにする
    "home":   HOMEPAGE_URL + "?utm_source=instagram&utm_medium=social&utm_campaign=link_in_bio",
    "seitai": "/",
    "hoken":  "/hoken",
    "online": "/online",
    "tel":    "tel:" + SHOP_PHONE,
    "map":    "https://www.google.com/maps/search/?api=1&query=" +
              urllib.parse.quote("きしもとカラダcondiTion 神戸市垂水区舞子"),
}

def service_label(service):
    return SERVICE_LABELS.get(service or "seitai", "きしもとカラダ整体")

def _make_body(res_id, customer_name, customer_phone, customer_note,
               date_str, time_str, slot_duration, label="きしもとカラダ整体"):
    """メール本文を生成"""
    return f"""{label} 予約確認
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


def _stripe_payment_url(res_id=None):
    """Stripe決済リンクのURLを返す。

    予約番号を client_reference_id として付けることで、Stripe Webhook経由で
    「どの予約への入金か」を自動で突き合わせられるようにする。
    """
    if not STRIPE_PAYMENT_LINK_URL:
        return ""
    if not res_id:
        return STRIPE_PAYMENT_LINK_URL
    sep = "&" if "?" in STRIPE_PAYMENT_LINK_URL else "?"
    return f"{STRIPE_PAYMENT_LINK_URL}{sep}client_reference_id=res-{res_id}"


def _online_customer_sections(meet_url="", res_id=None):
    """オンラインカウンセリング整体のお客様向けメールに追記する案内文"""
    if meet_url:
        meet_part = (
            "【当日のご参加方法（Google Meet）】\n"
            "開始時刻になりましたら、下記のリンクからご参加ください。\n"
            f"{meet_url}\n"
            "（スマホの場合は Google Meet アプリのインストールをおすすめします）\n"
        )
    else:
        meet_part = (
            "【当日のご参加方法（Google Meet）】\n"
            "参加用のGoogle Meetリンクは、ご予約日までに別途メールでお送りします。\n"
        )
    if STRIPE_PAYMENT_LINK_URL:
        pay_part = (
            "【お支払い（前払い制）】\n"
            f"料金：{ONLINE_PRICE_LABEL}\n"
            "下記のリンクから、ご予約日までにお支払いをお願いいたします。\n"
            f"{_stripe_payment_url(res_id)}\n"
        )
    else:
        pay_part = (
            "【お支払い（前払い制）】\n"
            f"料金：{ONLINE_PRICE_LABEL}\n"
            "お支払い方法は別途ご案内いたします。\n"
        )
    return (
        "\n" + meet_part +
        "\n" + pay_part +
        "\n【キャンセルについて】\n"
        f"{ONLINE_CANCEL_POLICY}\n"
    )


def _notify_gcal(action, res_id, customer_name="", customer_phone="", customer_note="",
                 slot_date="", slot_time="", slot_duration=45, service="seitai",
                 customer_email=""):
    """Google Apps Script Webhook経由でGoogleカレンダーに予定を作成/削除する。

    GCAL_WEBHOOK_URL が未設定なら何もしない（連携オフ）。
    失敗しても予約処理には影響させない（別スレッドから呼ばれる前提）。
    オンライン枠の作成時は、GAS側が発行したGoogle MeetのURLを返す。
    """
    if not GCAL_WEBHOOK_URL:
        return ""
    try:
        payload = json.dumps({
            "token": GCAL_WEBHOOK_TOKEN,
            "action": action,                      # "create" or "cancel"
            "reservation_id": res_id,
            "customer_name": customer_name,
            "customer_phone": customer_phone,
            "customer_email": customer_email,
            "customer_note": customer_note,
            "date": slot_date,                     # YYYY-MM-DD
            "time": (slot_time or "")[:5],         # HH:MM
            "duration": slot_duration,             # 分
            "service": service,                    # "online" ならMeetリンクを発行
            "service_label": service_label(service),
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            GCAL_WEBHOOK_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(f"[gcal] {action} No.{res_id} → HTTP {resp.status} {body[:200]}")
            try:
                return (json.loads(body) or {}).get("meet_url", "") or ""
            except Exception:
                return ""
    except Exception as e:
        print(f"[gcal] 連携失敗 ({action} No.{res_id}): {e}")
        return ""


def _ics_escape(text):
    """iCalendarのテキスト値エスケープ"""
    return (text or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _build_ics(res_id, customer_name, customer_phone, customer_note,
               slot_date, slot_time, slot_duration, service="seitai"):
    """予約1件分のGoogleカレンダー招待（iCalendar/ICS）を生成する。

    オーナー通知メールに添付すると、Gmail上で「カレンダーに追加」でき、
    カレンダー設定によっては自動でカレンダーに載る。
    """
    label = service_label(service)
    start_jst = datetime.fromisoformat(f"{slot_date}T{(slot_time or '')[:5]}:00")
    start_utc = start_jst - timedelta(hours=9)
    end_utc = start_utc + timedelta(minutes=int(slot_duration or 45))
    now_utc = datetime.utcnow()
    fmt = "%Y%m%dT%H%M%SZ"
    summary = f"予約No.{res_id} {customer_name}様（{label}{slot_duration}分）"
    description = (
        f"お名前: {customer_name} 様\n"
        f"電話番号: {customer_phone}\n"
        f"区分: {label}（{slot_duration}分）\n"
        f"ご要望: {customer_note or '（なし）'}\n"
        f"Web予約システムから自動作成"
    )
    lines = [
        "BEGIN:VCALENDAR",
        "PRODID:-//kishimotocondition//reservation//JA",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        f"UID:reservation-{res_id}@kishimotocondition.com",
        f"DTSTAMP:{now_utc.strftime(fmt)}",
        f"DTSTART:{start_utc.strftime(fmt)}",
        f"DTEND:{end_utc.strftime(fmt)}",
        f"SUMMARY:{_ics_escape(summary)}",
        f"DESCRIPTION:{_ics_escape(description)}",
        f"ORGANIZER;CN=きしもとカラダcondiTion:mailto:{MAIL_FROM}",
        f"ATTENDEE;CN=院長;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{NOTIFY_EMAIL or GMAIL_ADDRESS}",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines) + "\r\n"


def _send_one(to_addr, subject, body, ics=None):
    """1通送信（SendGrid API優先・未設定時はGmail SMTP）。ics指定時はカレンダー招待を添付"""
    if SENDGRID_API_KEY:
        sg_payload = {
            "personalizations": [{"to": [{"email": to_addr}]}],
            "from": {"email": MAIL_FROM, "name": "きしもとカラダ整体"},
            "reply_to": {"email": NOTIFY_EMAIL or GMAIL_ADDRESS},
            "subject": subject,
            "content": [{"type": "text/plain", "value": body}],
        }
        if ics:
            import base64
            sg_payload["attachments"] = [{
                "content": base64.b64encode(ics.encode("utf-8")).decode("ascii"),
                "type": "text/calendar; method=REQUEST",
                "filename": "invite.ics",
                "disposition": "attachment",
            }]
        payload = json.dumps(sg_payload).encode("utf-8")
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
    if ics:
        part = MIMEText(ics, "calendar", "utf-8")
        part.set_param("method", "REQUEST")
        part.add_header("Content-Disposition", "attachment", filename="invite.ics")
        msg.attach(part)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as srv:
        srv.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        srv.send_message(msg)


def _send_email(res_id, customer_name, customer_phone, customer_email,
                customer_note, slot_date, slot_time, slot_duration, service="seitai",
                meet_url=""):
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
                          customer_note, date_str, time_str, slot_duration, label)

        # ── Email 1: お客様へ予約確認 ──────────────────────
        if customer_email:
            try:
                customer_body = f"{customer_name} 様\n\nご予約が確定しました。\n\n" + body
                if service == "online":
                    customer_body += _online_customer_sections(meet_url, res_id)
                _send_one(
                    customer_email,
                    f"【ご予約確定】{label} {date_str} {time_str}〜",
                    customer_body
                )
                print(f"[mail] お客様へ送信完了 → {customer_email}  No.{res_id}")
            except Exception as e:
                print(f"[mail] お客様メール失敗: {e}")

        # ── Email 2: オーナーへ新規予約通知 ────────────────
        # Webhook連携が無い場合はカレンダー招待(ICS)を添付し、
        # Gmailから1タップでGoogleカレンダーに追加できるようにする
        # （Webhook連携がある場合は二重登録を避けるため添付しない）
        try:
            ics = None
            if not GCAL_WEBHOOK_URL:
                try:
                    ics = _build_ics(res_id, customer_name, customer_phone,
                                     customer_note, slot_date, slot_time,
                                     slot_duration, service)
                except Exception as e:
                    print(f"[mail] ICS生成失敗: {e}")
            owner_body = f"新しい予約が入りました。\n\n" + body
            if service == "online":
                owner_body += (
                    f"\n【オンライン】Google Meet: {meet_url or '（リンク未発行。手動で送付してください）'}\n"
                    f"料金: {ONLINE_PRICE_LABEL}（前払い・Stripe決済リンク）\n"
                )
            _send_one(
                NOTIFY_EMAIL,
                f"【新規予約】{customer_name}様 {date_str} {time_str}〜",
                owner_body,
                ics=ics,
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
            CREATE TABLE IF NOT EXISTS link_clicks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                link_key   TEXT NOT NULL,
                source     TEXT DEFAULT 'ig',
                created_at TEXT NOT NULL
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
        # オンライン枠用: Google MeetのURLを保存する列
        try:
            conn.execute("ALTER TABLE reservations ADD COLUMN meet_url TEXT")
        except Exception:
            pass
        # オンライン枠用: 入金状態（unpaid/paid）と入金日時
        try:
            conn.execute("ALTER TABLE reservations ADD COLUMN payment_status TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE reservations ADD COLUMN paid_at TEXT")
        except Exception:
            pass
        # 既存DBに service 列がない場合は追加（整体=seitai / 保険=hoken）
        try:
            conn.execute("ALTER TABLE slots ADD COLUMN service TEXT DEFAULT 'seitai'")
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


@app.route("/online")
def online_booking_page():
    return render_template("booking.html", service="online",
                           stripe_link=STRIPE_PAYMENT_LINK_URL)


@app.route("/ig")
@app.route("/links")
def instagram_links_page():
    """Instagramプロフィールに貼るリンクまとめページ"""
    return render_template("links.html", phone=SHOP_PHONE)


@app.route("/go/<key>")
def go_redirect(key):
    """クリックを記録してから各リンク先へ転送する"""
    url = IG_LINKS.get(key)
    if not url:
        return redirect(url_for("instagram_links_page"))
    src = (request.args.get("src") or "ig")[:30]
    try:
        # 日本時間で記録（集計を日本の1日単位で見られるように）
        jst_now = (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")
        with get_db() as conn:
            conn.execute(
                "INSERT INTO link_clicks (link_key, source, created_at) VALUES (?,?,?)",
                (key, src, jst_now),
            )
    except Exception as e:
        print(f"[link] クリック記録失敗: {e}")
    return redirect(url)


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
            # オンラインは 火・日のみ12:00〜、それ以外の曜日は21:00〜のみ
            if svc == "online" and t < "21:00:00":
                try:
                    if date.fromisoformat(s["date"]).weekday() not in ONLINE_FULLDAY_WEEKDAYS:
                        continue
                except ValueError:
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
            SELECT r.id, r.slot_id, r.customer_name, r.customer_phone, r.customer_note,
                   r.status, r.created_at, r.meet_url, r.payment_status, r.paid_at,
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
        # Googleカレンダーの該当予定を削除（GCAL_WEBHOOK_URL設定済み時のみ動作）
        threading.Thread(
            target=_notify_gcal, args=("cancel", res_id), daemon=True,
        ).start()
        return jsonify({"ok": True})
    return jsonify({"error": "Unknown action"}), 400


@app.route("/api/admin/calendar")
@login_required
def admin_calendar():
    """month=YYYY-MM 形式で月間スロット一覧を返す"""
    month = request.args.get("month", date.today().strftime("%Y-%m"))
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.id, s.date, s.time, s.duration, s.is_available, s.service,
                   (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
            FROM slots s
            WHERE s.date LIKE ?
            ORDER BY s.date, s.time
        """, (month + "%",)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/link-stats")
@login_required
def link_stats():
    """リンククリック集計（全期間・直近30日・日別）を返す"""
    days = 30
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    with get_db() as conn:
        total = conn.execute(
            "SELECT link_key, COUNT(*) AS cnt FROM link_clicks GROUP BY link_key"
        ).fetchall()
        recent = conn.execute(
            "SELECT link_key, COUNT(*) AS cnt FROM link_clicks WHERE created_at >= ? GROUP BY link_key",
            (since,),
        ).fetchall()
        daily = conn.execute(
            """SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS cnt
               FROM link_clicks WHERE created_at >= ?
               GROUP BY day ORDER BY day DESC""",
            (since,),
        ).fetchall()
    return jsonify({
        "days": days,
        "total":  {r["link_key"]: r["cnt"] for r in total},
        "recent": {r["link_key"]: r["cnt"] for r in recent},
        "daily":  [dict(r) for r in daily],
    })


# ── Stripe Webhook（入金確認） ────────────────────────────

def _verify_stripe_signature(payload, sig_header, secret, tolerance=300):
    """Stripe-Signatureヘッダーを検証する（stripeライブラリ不要の実装）。

    署名方式: HMAC-SHA256("{タイムスタンプ}.{リクエスト本文}", シークレット)
    https://docs.stripe.com/webhooks#verify-manually
    """
    import hmac
    import hashlib
    import time
    timestamp = None
    candidates = []
    for item in (sig_header or "").split(","):
        k, _, v = item.strip().partition("=")
        if k == "t":
            timestamp = v
        elif k == "v1":
            candidates.append(v)
    if not timestamp or not candidates:
        return False
    try:
        if abs(time.time() - int(timestamp)) > tolerance:
            return False
    except ValueError:
        return False
    signed = f"{timestamp}.".encode("utf-8") + payload
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, c) for c in candidates)


def _send_payment_email(res_id, customer_name, date_str, time_str, amount, payer_email):
    """オーナーへ入金確認メールを送信（別スレッド実行）"""
    if not (GMAIL_APP_PASSWORD or SENDGRID_API_KEY) or not NOTIFY_EMAIL:
        return
    amount_str = f"{amount:,}円" if isinstance(amount, int) else "（金額不明）"
    try:
        if res_id:
            subject = f"【入金確認】No.{res_id} {customer_name}様（オンラインカウンセリング整体）"
            body = (
                f"オンラインカウンセリング整体のお支払いが完了しました。\n\n"
                f"予約番号   : No.{res_id}\n"
                f"お名前     : {customer_name} 様\n"
                f"予約日時   : {date_str} {time_str}〜\n"
                f"金額       : {amount_str}\n"
                f"支払メール : {payer_email or '（不明）'}\n\n"
                f"管理画面の予約一覧でも「入金済」になっています。\n\n"
                f"きしもとカラダcondiTion 予約システム"
            )
        else:
            subject = "【入金確認・要チェック】予約と紐づけできない入金がありました"
            body = (
                f"Stripeで入金がありましたが、どの予約への入金か自動で特定できませんでした。\n\n"
                f"金額       : {amount_str}\n"
                f"支払メール : {payer_email or '（不明）'}\n\n"
                f"Stripeダッシュボードの「支払い」で内容を確認し、\n"
                f"該当のお客様の予約と手動で突き合わせてください。\n\n"
                f"きしもとカラダcondiTion 予約システム"
            )
        _send_one(NOTIFY_EMAIL, subject, body)
        print(f"[stripe] 入金確認メール送信完了 → {NOTIFY_EMAIL} (No.{res_id or '不明'})")
    except Exception as e:
        print(f"[stripe] 入金確認メール失敗: {e}")


@app.route("/api/stripe/webhook", methods=["POST"])
def stripe_webhook():
    """Stripeからの入金通知（checkout.session.completed）を受け取り、
    予約に入金済みを記録してオーナーへ通知する。

    予約との突き合わせは
    ①決済リンクに付けた client_reference_id（res-予約番号）
    ②支払い時のメールアドレス＝予約時のメールアドレス
    の順で行う。どちらでも特定できない場合も「要チェック」として通知する。
    """
    payload = request.get_data()
    sig_header = request.headers.get("Stripe-Signature", "")
    if STRIPE_WEBHOOK_SECRET:
        if not _verify_stripe_signature(payload, sig_header, STRIPE_WEBHOOK_SECRET):
            return jsonify({"error": "invalid signature"}), 400
    try:
        event = json.loads(payload)
    except Exception:
        return jsonify({"error": "invalid payload"}), 400

    if event.get("type") != "checkout.session.completed":
        return jsonify({"ok": True, "ignored": event.get("type")})

    obj = (event.get("data") or {}).get("object") or {}
    # カード決済は即時に paid になる。銀行振込等の遅延決済は完了イベント側で拾う
    if obj.get("payment_status") not in ("paid", "no_payment_required"):
        return jsonify({"ok": True, "ignored": "not paid yet"})

    ref = obj.get("client_reference_id") or ""
    payer_email = ((obj.get("customer_details") or {}).get("email") or "").strip()
    amount = obj.get("amount_total")  # JPYはそのまま円額

    res = None
    with get_db() as conn:
        # ① client_reference_id（res-予約番号）で特定
        if ref.startswith("res-"):
            try:
                rid = int(ref[4:])
                res = conn.execute("""
                    SELECT r.id, r.customer_name, r.payment_status, s.date, s.time
                    FROM reservations r JOIN slots s ON r.slot_id = s.id
                    WHERE r.id=?
                """, (rid,)).fetchone()
            except ValueError:
                pass
        # ② メールアドレスで、入金前のオンライン予約（直近の日程）を探す
        if res is None and payer_email:
            res = conn.execute("""
                SELECT r.id, r.customer_name, r.payment_status, s.date, s.time
                FROM reservations r JOIN slots s ON r.slot_id = s.id
                WHERE lower(r.customer_email) = lower(?)
                  AND r.status = 'confirmed' AND s.service = 'online'
                  AND (r.payment_status IS NULL OR r.payment_status != 'paid')
                ORDER BY s.date, s.time LIMIT 1
            """, (payer_email,)).fetchone()

        if res and res["payment_status"] == "paid":
            # Stripeは同じイベントを再送することがあるので二重処理しない
            return jsonify({"ok": True, "skipped": "already paid"})

        if res:
            jst_now = (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")
            conn.execute("UPDATE reservations SET payment_status='paid', paid_at=? WHERE id=?",
                         (jst_now, res["id"]))

    if res:
        d = date.fromisoformat(res["date"])
        date_str = f"{d.year}年{d.month}月{d.day}日（{DOW_JA[d.weekday()]}）"
        threading.Thread(
            target=_send_payment_email,
            args=(res["id"], res["customer_name"], date_str, res["time"][:5], amount, payer_email),
            daemon=True,
        ).start()
        print(f"[stripe] 入金を記録 No.{res['id']} ({amount}円, {payer_email})")
    else:
        threading.Thread(
            target=_send_payment_email,
            args=(None, "", "", "", amount, payer_email),
            daemon=True,
        ).start()
        print(f"[stripe] 予約と紐づけできない入金 ({amount}円, {payer_email})")

    return jsonify({"ok": True, "matched": bool(res)})


# ── 顧客向け API ──────────────────────────────────────────

@app.route("/api/slots")
def get_slots():
    """date=YYYY-MM-DD で利用可能な空き枠を返す"""
    req_date = request.args.get("date")
    service = request.args.get("service", "seitai")
    if not req_date:
        return jsonify({"error": "date required"}), 400
    with get_db() as conn:
        rows = conn.execute("""
            SELECT s.id, s.date, s.time, s.duration, s.service,
                   (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
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
        rows = conn.execute("""
            SELECT s.date,
                   COUNT(*) as total,
                   SUM(CASE WHEN s.is_available=1 AND
                       (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed')=0
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

        slot_service = slot["service"] if "service" in slot.keys() else "seitai"
        # オンラインは前払い制なので「未入金」で開始（Stripe Webhookで入金済みに更新）
        if slot_service == "online":
            conn.execute("UPDATE reservations SET payment_status='unpaid' WHERE id=?", (res_id,))

    if slot_service == "online":
        # オンラインは順序が大事:
        # ①カレンダー登録でGoogle Meetリンクを発行 → ②リンク入りの確認メールを送信
        def _online_flow():
            meet_url = _notify_gcal(
                "create", res_id, name, phone, note,
                slot["date"], slot["time"], slot["duration"], slot_service,
                customer_email=email,
            )
            if meet_url:
                try:
                    with get_db() as conn:
                        conn.execute("UPDATE reservations SET meet_url=? WHERE id=?",
                                     (meet_url, res_id))
                except Exception as e:
                    print(f"[gcal] meet_url保存失敗 No.{res_id}: {e}")
            _send_email(res_id, name, phone, email, note,
                        slot["date"], slot["time"], slot["duration"], slot_service,
                        meet_url=meet_url)
        threading.Thread(target=_online_flow, daemon=True).start()
    else:
        # 予約確定メールを別スレッドで送信（失敗しても予約は確定）
        threading.Thread(
            target=_send_email,
            args=(res_id, name, phone, email, note,
                  slot["date"], slot["time"], slot["duration"], slot_service),
            daemon=True,
        ).start()

        # Googleカレンダーに予定を自動作成（GCAL_WEBHOOK_URL設定済み時のみ動作）
        threading.Thread(
            target=_notify_gcal,
            args=("create", res_id, name, phone, note,
                  slot["date"], slot["time"], slot["duration"], slot_service),
            daemon=True,
        ).start()

    # SMS通知を別スレッドで送信（Twilio設定済み時のみ動作）
    threading.Thread(target=_send_sms_all, daemon=True).start()

    # Google Chat通知を別スレッドで送信（Webhook URL設定済み時のみ動作）
    threading.Thread(target=_send_gchat, daemon=True).start()

    # 予約アラートメールを4名に送信
    threading.Thread(
        target=_send_alert_emails,
        args=(name, slot["date"], slot["time"], slot_service),
        daemon=True,
    ).start()

    return jsonify({
        "ok": True,
        "reservation_id": res_id,
        "date": slot["date"],
        "time": slot["time"],
        "duration": slot["duration"],
        "customer_name": name,
        # オンラインのみ: 予約番号つきの決済リンク（完了画面のボタンに使う）
        "payment_url": _stripe_payment_url(res_id) if slot_service == "online" else "",
    })


# ── Stripe Webhook（決済完了の受信口）──────────────────

import hmac
import hashlib
import time

STRIPE_WEBHOOK_SECRET = (getattr(_cfg, "STRIPE_WEBHOOK_SECRET", "") if _cfg else "") \
    or os.environ.get("STRIPE_WEBHOOK_SECRET", "")


def _verify_stripe_signature(payload, sig_header, secret, tolerance=300):
    """Stripe-Signature ヘッダーを検証する（stripeライブラリ不要）"""
    if not secret or not sig_header:
        return False
    timestamp = ""
    signatures = []
    for part in sig_header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    if not timestamp or not signatures:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs(time.time() - ts) > tolerance:
        return False
    signed_payload = (timestamp + ".").encode("utf-8") + payload
    expected = hmac.new(
        secret.encode("utf-8"), signed_payload, hashlib.sha256
    ).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in signatures)


@app.route("/api/stripe/webhook", methods=["POST"])
def stripe_webhook():
    """Stripeの決済完了通知を受け取り、管理者へ入金通知メールを送る"""
    payload = request.get_data()
    sig_header = request.headers.get("Stripe-Signature", "")

    if not STRIPE_WEBHOOK_SECRET:
        print("[stripe] STRIPE_WEBHOOK_SECRET が未設定です")
        return jsonify({"error": "webhook secret not configured"}), 500

    if not _verify_stripe_signature(payload, sig_header, STRIPE_WEBHOOK_SECRET):
        print("[stripe] 署名の検証に失敗しました")
        return jsonify({"error": "invalid signature"}), 400

    try:
        event = json.loads(payload.decode("utf-8"))
    except Exception:
        return jsonify({"error": "invalid payload"}), 400

    if event.get("type") == "checkout.session.completed":
        obj = (event.get("data") or {}).get("object") or {}
        details = obj.get("customer_details") or {}
        cname = details.get("name") or "(未取得)"
        cemail = details.get("email") or "(未取得)"
        amount = obj.get("amount_total")
        currency = (obj.get("currency") or "jpy").upper()
        if isinstance(amount, int):
            amount_label = "{:,} {}".format(amount, currency)
        else:
            amount_label = "(不明)"
        body = (
            "Stripeで入金がありました。\n\n"
            "お名前: " + cname + "\n"
            "メール: " + cemail + "\n"
            "金額: " + amount_label + "\n"
            "決済ID: " + str(obj.get("id") or "") + "\n\n"
            "オンラインカウンセリング整体の前払い分と思われます。\n"
            "予約一覧と照合してご確認ください。\n"
        )
        to_addr = NOTIFY_EMAIL or GMAIL_ADDRESS
        if to_addr:
            threading.Thread(
                target=_send_one,
                args=(to_addr, "【入金通知】Stripe決済が完了しました", body),
                daemon=True,
            ).start()
        print("[stripe] checkout.session.completed:", obj.get("id"))

    return jsonify({"received": True}), 200


# ── 起動 ─────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    print("予約管理システム起動: http://localhost:5050")
    print("管理画面: http://localhost:5050/admin")
    app.run(host="0.0.0.0", port=5050, debug=True)

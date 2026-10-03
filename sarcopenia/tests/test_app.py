"""
Flask アプリ（API）のテスト。一時ファイルの DB を使うので本番データには触れない。

実行: cd sarcopenia && python -m pytest -q
"""
import io
import json
import os
import sys
import tempfile

import pytest

_tmpdir = tempfile.mkdtemp()
os.environ["SARCOPENIA_DB_PATH"] = os.path.join(_tmpdir, "test.db")
os.environ["SARCOPENIA_PASSWORD"] = ""  # 認証なしで動かす（認証のテストは別に行う）

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app as app_module  # noqa: E402

PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478"
    "9c6360000002000154a24f5d0000000049454e44ae426082"
)


@pytest.fixture
def client():
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


def base_form(**kw):
    d = {
        "patient_name": "テスト 花子", "sex": "female", "age": "74", "height_cm": "152.0",
        "weight_kg": "48.5", "calf_cm": "31.0",
        "sarcf_strength": "1", "sarcf_walk": "0", "sarcf_chair": "1", "sarcf_stairs": "1", "sarcf_falls": "1",
        "grip_kg": "16.5", "gait_speed_ms": "0.92", "chair_stand_sec": "13.0",
        "arm_r_kg": "1.40", "arm_l_kg": "1.35", "leg_r_kg": "4.90", "leg_l_kg": "4.85",
        "note": "初回評価",
    }
    d.update(kw)
    return d


def test_index_renders_without_login(client):
    res = client.get("/")
    assert res.status_code == 200
    html = res.get_data(as_text=True)
    assert "サルコペニア簡易評価" in html
    assert "SARC-F" in html
    assert 'name="sarcf_falls"' in html


def test_evaluate_without_saving(client):
    res = client.post("/api/evaluate", json={"sex": "male", "grip_kg": 25})
    assert res.status_code == 200
    body = res.get_json()
    assert body["result"]["level"] == "possible"


def test_evaluate_requires_sex(client):
    res = client.post("/api/evaluate", json={"grip_kg": 25})
    assert res.status_code == 400


def test_create_requires_name(client):
    res = client.post("/api/assessments", data=base_form(patient_name=""))
    assert res.status_code == 400
    assert "お名前" in res.get_json()["error"]


def test_create_with_image_then_fetch_list_delete(client):
    data = base_form()
    data["inbody_image"] = (io.BytesIO(PNG_1PX), "inbody.png", "image/png")
    res = client.post("/api/assessments", data=data, content_type="multipart/form-data")
    assert res.status_code == 200, res.get_data(as_text=True)
    a = res.get_json()["assessment"]

    # 判定: 女性 SMI = 12.5 / 1.52² = 5.41 (<5.7) 低下、握力 16.5 (<18) 低下、歩行 0.92 (<1.0) 低下 → 重症
    assert a["result"]["level"] == "severe"
    assert a["asm_kg"] == 12.5
    assert a["smi"] == round(12.5 / 1.52 ** 2, 2)
    assert a["sarcf_score"] == 4
    assert a["has_image"] is True
    assert a["previous"] is None
    assert "image_blob" not in a

    # 画像の取得
    img = client.get(a["image_url"])
    assert img.status_code == 200
    assert img.mimetype == "image/png"
    assert img.data == PNG_1PX

    # 一覧
    lst = client.get("/api/assessments?name=花子").get_json()["items"]
    assert any(it["id"] == a["id"] for it in lst)
    assert lst[0]["result_label"] == "重症サルコペニアの可能性"

    # 名前候補
    assert "テスト 花子" in client.get("/api/names").get_json()["names"]

    # 詳細
    detail = client.get(f"/api/assessments/{a['id']}").get_json()["assessment"]
    assert detail["patient_name"] == "テスト 花子"
    assert detail["sarcf"] == {"strength": "1", "walk": "0", "chair": "1", "stairs": "1", "falls": "1"}

    # 削除
    assert client.delete(f"/api/assessments/{a['id']}").status_code == 200
    assert client.get(f"/api/assessments/{a['id']}").status_code == 404
    assert client.get(a["image_url"]).status_code == 404


def test_previous_record_is_attached_for_same_name(client):
    first = client.post("/api/assessments", data=base_form(patient_name="再評価 太郎", sex="male", grip_kg="25")).get_json()["assessment"]
    second = client.post("/api/assessments", data=base_form(patient_name="再評価 太郎", sex="male", grip_kg="27")).get_json()["assessment"]
    assert second["previous"]["id"] == first["id"]
    assert second["previous"]["grip_kg"] == 25.0


def test_rejects_non_image_upload(client):
    data = base_form()
    data["inbody_image"] = (io.BytesIO(b"hello"), "memo.txt", "text/plain")
    res = client.post("/api/assessments", data=data, content_type="multipart/form-data")
    assert res.status_code == 400
    assert "画像" in res.get_json()["error"]


def test_create_without_image_is_fine(client):
    res = client.post("/api/assessments", data=base_form(patient_name="画像なし"))
    assert res.status_code == 200
    a = res.get_json()["assessment"]
    assert a["has_image"] is False and a["image_url"] is None


def test_password_gate(client, monkeypatch):
    monkeypatch.setattr(app_module, "APP_PASSWORD", "secret")
    # 未ログイン: 画面はログインへリダイレクト、API は 401
    assert client.get("/").status_code == 302
    assert client.get("/api/assessments").status_code == 401
    # 間違ったパスワード
    assert client.post("/api/login", json={"password": "x"}).status_code == 401
    # 正しいパスワード
    assert client.post("/api/login", json={"password": "secret"}).status_code == 200
    assert client.get("/").status_code == 200
    assert client.get("/api/assessments").status_code == 200
    # ログアウト
    client.post("/api/logout")
    assert client.get("/api/assessments").status_code == 401


# ── 保存先・バックアップ ──
def test_default_db_path_is_in_documents_on_mac():
    p = app_module.default_db_path(platform="darwin", home="/Users/kishimoto")
    assert p == "/Users/kishimoto/Documents/サルコペニア評価/sarcopenia.db"


def test_default_db_path_is_local_elsewhere():
    p = app_module.default_db_path(platform="linux", home="/home/x")
    assert p == os.path.join(app_module.BASE_DIR, "sarcopenia.db")


def test_backup_db_creates_daily_copy_and_prunes(client):
    client.post("/api/assessments", data=base_form(patient_name="複製 確認"))
    dest = app_module.backup_db(today="2030-01-10", keep_days=2)
    assert dest and os.path.exists(dest)
    # 同じ日は二重に作らない
    assert app_module.backup_db(today="2030-01-10", keep_days=2) is None
    # 複製の中身が読める
    import sqlite3
    n = sqlite3.connect(dest).execute("SELECT COUNT(*) FROM assessments WHERE patient_name='複製 確認'").fetchone()[0]
    assert n == 1
    # 古い分は keep_days を超えたら削除
    app_module.backup_db(today="2030-01-11", keep_days=2)
    app_module.backup_db(today="2030-01-12", keep_days=2)
    names = sorted(os.listdir(app_module.BACKUP_DIR))
    assert "sarcopenia-2030-01-10.db" not in names
    assert "sarcopenia-2030-01-11.db" in names and "sarcopenia-2030-01-12.db" in names


def test_first_request_of_day_makes_backup(client):
    app_module._last_backup_day = None
    client.get("/")
    today = app_module.jst_now()[:10]
    assert os.path.exists(os.path.join(app_module.BACKUP_DIR, f"sarcopenia-{today}.db"))

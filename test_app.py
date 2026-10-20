"""Tests for the CRM backend:  pytest -q"""
import base64
import io
import json
import os
import tempfile

import pytest

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="crm-import-"))
import app as crm  # noqa: E402


def auth(user, pw):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}


ADMIN, EDITOR, VIEWER = auth("admin", "a-secret"), auth("sales", "s-secret"), auth("boss", "b-secret")


@pytest.fixture()
def client(tmp_path):
    app = crm.create_app({"DATABASE": str(tmp_path / "t.sqlite3"), "UPLOAD_DIR": str(tmp_path / "up"), "TESTING": True, "SECRET_KEY": "test"})
    with app.app_context():
        crm.upsert_user("admin", "a-secret", "admin")
        crm.upsert_user("sales", "s-secret", "editor")
        crm.upsert_user("boss", "b-secret", "viewer")
    return app.test_client()


def test_login_required(client):
    r = client.get("/api/me")
    assert r.status_code == 401 and r.json["error"] == "unauthenticated"
    assert "WWW-Authenticate" not in r.headers          # no browser popup: the page shows its own form
    assert client.get("/api/me", headers=auth("admin", "wrong")).status_code == 401
    assert client.get("/api/collections/customers").status_code == 401
    assert client.get("/_blob/abc").status_code == 401


def test_home_and_health_are_public(client):
    # hosting platforms health-check "/" without credentials: it must answer 200
    assert client.get("/").status_code in (200, 404)    # 404 only if static/index.html is missing
    for path in ("/healthz", "/health", "/ping"):
        r = client.get(path)
        assert r.status_code == 200 and r.json == {"ok": True}


def test_session_login_logout(client):
    assert client.post("/api/login", json={"username": "sales", "password": "nope"}).status_code == 401
    r = client.post("/api/login", json={"username": "sales", "password": "s-secret"})
    assert r.status_code == 200 and r.json["role"] == "editor"
    assert client.get("/api/me").json["username"] == "sales"            # cookie carries the session
    assert client.put("/api/docs/customers/c1", json={"name": "A"}).status_code == 201
    client.post("/api/logout")
    assert client.get("/api/me").status_code == 401


def test_login_rate_limit(client):
    for _ in range(10):
        client.post("/api/login", json={"username": "admin", "password": "x"})
    assert client.post("/api/login", json={"username": "admin", "password": "a-secret"}).status_code == 429


def test_setup_state(client):
    assert client.get("/api/setup").json == {"hasUsers": True}


def test_me_roles(client):
    assert client.get("/api/me", headers=ADMIN).json == {"username": "admin", "role": "admin", "canWrite": True, "canEdit": True}
    assert client.get("/api/me", headers=EDITOR).json["canEdit"] is False
    assert client.get("/api/me", headers=VIEWER).json["canWrite"] is False


def test_set_get_update_delete(client):
    r = client.put("/api/docs/customers/kh1", json={"name": "Xưởng A", "code": "PROMOTION1"}, headers=EDITOR)
    assert r.status_code == 201 and r.json["version"] == 1
    r = client.patch("/api/docs/customers/kh1", json={"regStatus": "Đã duyệt", "code": {"__delete__": True}}, headers=EDITOR)
    assert r.json["data"] == {"name": "Xưởng A", "regStatus": "Đã duyệt"} and r.json["version"] == 2
    assert client.get("/api/docs/customers/kh1", headers=VIEWER).json["data"]["name"] == "Xưởng A"
    docs = client.get("/api/collections/customers", headers=VIEWER).json["docs"]
    assert [d["id"] for d in docs] == ["kh1"]
    assert client.delete("/api/docs/customers/kh1", headers=EDITOR).json["deleted"] is True
    assert client.get("/api/docs/customers/kh1", headers=VIEWER).status_code == 404


def test_update_missing_is_404(client):
    assert client.patch("/api/docs/customers/nope", json={"a": 1}, headers=EDITOR).status_code == 404


def test_viewer_cannot_write(client):
    assert client.put("/api/docs/customers/x", json={"a": 1}, headers=VIEWER).status_code == 403
    assert client.post("/api/assets", headers=VIEWER).status_code == 403


def test_optimistic_lock(client):
    client.put("/api/docs/promos/p1", json={"code": "FO"}, headers=EDITOR)
    assert client.put("/api/docs/promos/p1", json={"code": "X"}, headers={**EDITOR, "If-Match": "7"}).status_code == 409
    assert client.put("/api/docs/promos/p1", json={"code": "X"}, headers={**EDITOR, "If-Match": "1"}).status_code == 200


def test_invalid_names_rejected(client):
    assert client.put("/api/docs/cust%20omers/a", json={}, headers=EDITOR).status_code == 400
    assert client.get("/api/collections/a..b?order_by=x;drop", headers=VIEWER).status_code == 400


def test_order_and_limit(client):
    for i, d in enumerate(["2026-09-01", "2026-08-01", "2026-10-01"]):
        client.put(f"/api/docs/orders/o{i}", json={"date": d}, headers=EDITOR)
    docs = client.get("/api/collections/orders?order_by=date&direction=desc&limit=2", headers=VIEWER).json["docs"]
    assert [d["data"]["date"] for d in docs] == ["2026-10-01", "2026-09-01"]


def test_change_feed(client):
    seq0 = client.get("/api/changes?since=0", headers=VIEWER).json["seq"]
    client.put("/api/docs/vouchers/v1", json={"serial": "1"}, headers=EDITOR)
    r = client.get(f"/api/changes?since={seq0}", headers=VIEWER).json
    assert r["seq"] > seq0 and r["collections"] == ["vouchers"]
    assert client.get(f"/api/changes?since={r['seq']}", headers=VIEWER).json["collections"] == []


def test_settings_doc(client):
    client.put("/api/docs/settings/prices", json={"items": [{"product": "HMR E1", "price": 450000}]}, headers=EDITOR)
    assert client.get("/api/docs/settings/prices", headers=VIEWER).json["data"]["items"][0]["price"] == 450000


def test_assets_roundtrip(client):
    pdf = b"%PDF-1.4\n%test\n"
    r = client.post("/api/assets", data={"file": (io.BytesIO(pdf), "don-hang.pdf", "application/pdf")},
                    headers=EDITOR, content_type="multipart/form-data")
    assert r.status_code == 201
    a = r.json
    assert a["url"] == "/_blob/" + a["id"] and a["sizeBytes"] == len(pdf)
    got = client.get(a["url"], headers=VIEWER)
    assert got.data == pdf and got.mimetype == "application/pdf"
    assert client.delete("/api/assets/" + a["id"], headers=EDITOR).json["deleted"] is True
    assert client.get(a["url"], headers=VIEWER).status_code == 404


def test_asset_type_allowlist(client):
    r = client.post("/api/assets", data={"file": (io.BytesIO(b"MZ"), "x.exe", "application/x-msdownload")},
                    headers=EDITOR, content_type="multipart/form-data")
    assert r.status_code == 415


def test_export_import_admin_only(client):
    payload = {"customers": [{"id": "kh9", "name": "Việt Ken"}], "settings": [{"id": "npps", "items": []}]}
    assert client.post("/api/import", json=payload, headers=EDITOR).status_code == 403
    assert client.post("/api/import", json=payload, headers=ADMIN).json["imported"] == 2
    dump = client.get("/api/export", headers=ADMIN).json
    assert dump["customers"][0] == {"id": "kh9", "name": "Việt Ken"}


def test_user_management(client):
    assert client.put("/api/users/newbie", json={"password": "p", "role": "editor"}, headers=EDITOR).status_code == 403
    assert client.put("/api/users/newbie", json={"password": "p", "role": "editor"}, headers=ADMIN).status_code == 200
    assert client.get("/api/me", headers=auth("newbie", "p")).json["role"] == "editor"


def test_seed_file_imports(client, tmp_path):
    seed = os.path.join(os.path.dirname(__file__), "crm-data.json")
    if not os.path.exists(seed):
        pytest.skip("no seed file")
    with open(seed, encoding="utf-8") as f:
        payload = json.load(f)
    n = client.post("/api/import", json=payload, headers=ADMIN).json["imported"]
    assert n == sum(len(v) for v in payload.values())
    assert len(client.get("/api/collections/customers", headers=VIEWER).json["docs"]) == len(payload["customers"])


def test_only_frontend_files_are_public(client):
    assert client.get("/static/claude-shim.js").status_code in (200, 404)
    for bad in ("/static/app.py", "/static/schema.sql", "/static/../app.py", "/app.py"):
        assert client.get(bad).status_code == 404

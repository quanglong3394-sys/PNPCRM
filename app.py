"""CRM Panel Plus — self-hosted backend.

Serves the single-page CRM (static/index.html) and the small document-store
API it needs: collections of JSON documents, a change feed for live refresh,
file uploads (purchase documents, signed reports) and users with roles.

Run locally:   python app.py init-db && python app.py create-user admin <password> admin
               flask --app app run            (or: gunicorn app:app)
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
ROLES = {"viewer": 0, "editor": 1, "admin": 2}
NAME_RX = re.compile(r"^[A-Za-z0-9_\-.~:@+]{1,200}$")
MAX_UPLOAD = 20 * 1024 * 1024
ALLOWED_TYPES = {
    "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "text/csv", "text/plain", "text/markdown", "application/json",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def create_app(config: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    data_dir = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
    app.config.update(
        DATABASE=os.environ.get("DATABASE", str(data_dir / "crm.sqlite3")),
        UPLOAD_DIR=os.environ.get("UPLOAD_DIR", str(data_dir / "uploads")),
        STATIC_DIR=str(BASE_DIR / "static") if (BASE_DIR / "static").is_dir() else str(BASE_DIR),
        MAX_CONTENT_LENGTH=MAX_UPLOAD + 1024 * 1024,
        SESSION_COOKIE_NAME="crm_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
        PERMANENT_SESSION_LIFETIME=timedelta(days=int(os.environ.get("SESSION_DAYS", "14"))),
    )
    if config:
        app.config.update(config)
    Path(app.config["UPLOAD_DIR"]).mkdir(parents=True, exist_ok=True)
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    app.secret_key = app.config.get("SECRET_KEY") or os.environ.get("SECRET_KEY") or _stored_secret(
        Path(app.config["DATABASE"]).parent / ".secret_key")

    with app.app_context():
        init_db()
        bootstrap_admin()

    # ------------------------------------------------------------------ auth
    def check_login(username: str, password: str, any_status: bool = False):
        row = db().execute("SELECT username, password_hash, role, status FROM users WHERE username = ?",
                           (username,)).fetchone()
        if not row or not check_password_hash(row["password_hash"], password or ""):
            return None
        if row["status"] != "active" and not any_status:
            return None
        return {"username": row["username"], "role": row["role"], "status": row["status"]}

    def current_user():
        # 1) explicit HTTP Basic header (scripts, curl)  2) browser session cookie (login form)
        auth = request.authorization
        if auth and auth.type == "basic" and auth.username:
            return check_login(auth.username, auth.password or "")
        name = session.get("u")
        if name:
            row = db().execute("SELECT username, role FROM users WHERE username = ? AND status = 'active'",
                               (name,)).fetchone()
            if row:
                return {"username": row["username"], "role": row["role"]}
            session.clear()
        return None

    def require(level: str = "viewer"):
        def deco(fn):
            @wraps(fn)
            def wrapper(*a, **kw):
                user = current_user()
                if user is None:
                    return jsonify(error="unauthenticated", message="Cần đăng nhập / Login required"), 401
                if ROLES[user["role"]] < ROLES[level]:
                    return jsonify(error="forbidden", message="Không đủ quyền / Not allowed"), 403
                g.user = user
                return fn(*a, **kw)
            return wrapper
        return deco

    def check_name(*names: str) -> None:
        for n in names:
            if not NAME_RX.match(n or "") or n in (".", ".."):
                abort(400, description="invalid name")

    def doc_out(row) -> dict:
        return {"id": row["id"], "data": json.loads(row["data"]), "version": row["version"],
                "updatedAt": row["updated_at"]}

    def log_change(collection: str, doc_id: str, op: str) -> None:
        db().execute("INSERT INTO changes (collection, doc_id, op, by_user) VALUES (?,?,?,?)",
                     (collection, doc_id, op, g.user["username"]))

    # --------------------------------------------------------------- pages
    # The page itself holds no data, so it is public: hosting health checks on "/" get 200,
    # and the page shows a login form; every /api route and file still requires login.
    # Front-end files may sit in static/ or next to app.py (flat repo). Only these names are served,
    # so app.py, the database or other files in the folder are never exposed.
    PUBLIC_FILES = {"index.html", "claude-shim.js", "favicon.ico"}

    def find_public(name: str):
        for folder in (Path(app.config["STATIC_DIR"]), BASE_DIR / "static", BASE_DIR):
            if (folder / name).is_file():
                return folder
        return None

    @app.get("/")
    def index():
        folder = find_public("index.html")
        if folder is None:   # still answer 200 so the platform health check passes, and say what is missing
            return ("<!doctype html><meta charset=utf-8><title>CRM</title><body style='font:16px system-ui;padding:40px'>"
                    "<h1>CRM Panel Plus</h1><p>Máy chủ đang chạy nhưng thiếu file giao diện <b>index.html</b>. "
                    "Hãy đưa index.html và claude-shim.js vào repo (cùng thư mục với app.py hoặc trong static/) rồi triển khai lại.</p>"), 200
        return send_from_directory(folder, "index.html")

    @app.get("/static/<path:name>")
    @app.get("/<any('claude-shim.js', 'favicon.ico'):name>")
    def static_files(name):
        if name not in PUBLIC_FILES:
            abort(404)
        folder = find_public(name)
        if folder is None:
            abort(404)
        return send_from_directory(folder, name)

    @app.get("/healthz")
    @app.get("/health")
    @app.get("/ping")
    def healthz():
        db().execute("SELECT 1").fetchone()
        return jsonify(ok=True)

    # ---------------------------------------------------------------- login
    failed: dict[str, list[float]] = {}

    @app.post("/api/login")
    def login():
        ip = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()
        now = time.time()
        recent = [t for t in failed.get(ip, []) if now - t < 300]
        if len(recent) >= 10:
            return jsonify(error="rate_limited", message="Sai quá nhiều lần, thử lại sau 5 phút"), 429
        body = request.get_json(silent=True) or {}
        user = check_login(str(body.get("username", "")).strip(), str(body.get("password", "")), any_status=True)
        if not user:
            failed[ip] = recent + [now]
            return jsonify(error="invalid_credentials", message="Sai tên đăng nhập hoặc mật khẩu"), 401
        if user["status"] == "pending":
            return jsonify(error="pending", message="Tài khoản đang chờ admin duyệt và phân quyền"), 403
        if user["status"] == "disabled":
            return jsonify(error="disabled", message="Tài khoản đã bị khóa, liên hệ admin"), 403
        failed.pop(ip, None)
        session.clear()
        session.permanent = True
        session["u"] = user["username"]
        return jsonify(username=user["username"], role=user["role"])

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/setup")
    def setup_state():
        has_users = bool(db().execute("SELECT 1 FROM users LIMIT 1").fetchone())
        return jsonify(hasUsers=has_users, needsToken=bool(os.environ.get("SETUP_TOKEN")))

    @app.post("/api/setup")
    def setup_first_admin():
        """First run only: while there is no user at all, the first visitor creates the admin account.
        Set SETUP_TOKEN to require a token for this step."""
        if db().execute("SELECT 1 FROM users LIMIT 1").fetchone():
            return jsonify(error="already_setup", message="Đã có tài khoản, hãy đăng nhập"), 409
        body = request.get_json(silent=True) or {}
        token = os.environ.get("SETUP_TOKEN")
        if token and body.get("token") != token:
            return jsonify(error="invalid_token", message="Sai mã cài đặt (SETUP_TOKEN)"), 403
        username, password = str(body.get("username", "")).strip(), str(body.get("password", ""))
        if not NAME_RX.match(username):
            return jsonify(error="invalid_username", message="Tên đăng nhập chỉ gồm chữ không dấu, số, . _ -"), 400
        if len(password) < 8:
            return jsonify(error="weak_password", message="Mật khẩu tối thiểu 8 ký tự"), 400
        upsert_user(username, password, "admin")
        session.clear()
        session.permanent = True
        session["u"] = username
        return jsonify(username=username, role="admin"), 201

    @app.post("/api/register")
    def register():
        """Sign-up form: the account waits ('pending') until an admin approves it and picks a role.
        The very first account on an empty server becomes the active admin."""
        ip = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()
        now = time.time()
        recent = [t for t in failed.get("reg:" + ip, []) if now - t < 3600]
        if len(recent) >= 5:
            return jsonify(error="rate_limited", message="Đăng ký quá nhiều lần, thử lại sau"), 429
        body = request.get_json(silent=True) or {}
        username, password = str(body.get("username", "")).strip(), str(body.get("password", ""))
        full_name = str(body.get("fullName", "")).strip()[:120]
        if not NAME_RX.match(username):
            return jsonify(error="invalid_username", message="Tên đăng nhập chỉ gồm chữ không dấu, số, . _ -"), 400
        if len(password) < 8:
            return jsonify(error="weak_password", message="Mật khẩu tối thiểu 8 ký tự"), 400
        con = db()
        if con.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            return jsonify(error="taken", message="Tên đăng nhập đã có người dùng"), 409
        first = not con.execute("SELECT 1 FROM users LIMIT 1").fetchone()
        token = os.environ.get("SETUP_TOKEN")
        if first and token and body.get("token") != token:
            return jsonify(error="invalid_token", message="Sai mã cài đặt (SETUP_TOKEN)"), 403
        con.execute("INSERT INTO users (username, password_hash, role, status, full_name) VALUES (?,?,?,?,?)",
                    (username, generate_password_hash(password), "admin" if first else "viewer",
                     "active" if first else "pending", full_name or None))
        con.commit()
        failed["reg:" + ip] = recent + [now]
        if first:
            session.clear(); session.permanent = True; session["u"] = username
            return jsonify(username=username, role="admin", status="active"), 201
        return jsonify(username=username, status="pending",
                       message="Đã gửi đăng ký. Chờ admin duyệt và phân quyền rồi đăng nhập."), 201

    @app.post("/api/me/password")
    @require("viewer")
    def change_password():
        body = request.get_json(silent=True) or {}
        if not check_login(g.user["username"], str(body.get("current", ""))):
            return jsonify(error="invalid_credentials", message="Mật khẩu hiện tại không đúng"), 403
        new = str(body.get("password", ""))
        if len(new) < 8:
            return jsonify(error="weak_password", message="Mật khẩu tối thiểu 8 ký tự"), 400
        upsert_user(g.user["username"], new, g.user["role"])
        return jsonify(ok=True)

    # ----------------------------------------------------------------- api
    @app.get("/api/me")
    @require("viewer")
    def me():
        role = g.user["role"]
        out = dict(username=g.user["username"], role=role,
                   canWrite=ROLES[role] >= ROLES["editor"], canEdit=role == "admin")
        if role == "admin":
            out["pendingUsers"] = int(db().execute("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").fetchone()["n"])
        return jsonify(out)

    @app.get("/api/collections/<collection>")
    @require("viewer")
    def list_docs(collection):
        check_name(collection)
        limit = max(1, min(int(request.args.get("limit", 1000)), 5000))
        sql = "SELECT * FROM documents WHERE collection = ?"
        params: list = [collection]
        order_by = request.args.get("order_by")
        if order_by:
            if not re.match(r"^[A-Za-z0-9_]{1,64}$", order_by):
                abort(400, description="invalid order_by")
            direction = "DESC" if request.args.get("direction", "asc").lower() == "desc" else "ASC"
            sql += f" ORDER BY json_extract(data, '$.{order_by}') {direction}, id"
        else:
            sql += " ORDER BY id"
        sql += " LIMIT ?"
        params.append(limit)
        rows = db().execute(sql, params).fetchall()
        return jsonify(docs=[doc_out(r) for r in rows], seq=last_seq())

    @app.get("/api/docs/<collection>/<doc_id>")
    @require("viewer")
    def get_doc(collection, doc_id):
        check_name(collection, doc_id)
        row = db().execute("SELECT * FROM documents WHERE collection = ? AND id = ?",
                           (collection, doc_id)).fetchone()
        if not row:
            return jsonify(error="not_found"), 404
        return jsonify(doc_out(row))

    def write_doc(collection: str, doc_id: str, merge: bool):
        check_name(collection, doc_id)
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            abort(400, description="body must be a JSON object")
        if_version = request.headers.get("If-Match")
        con = db()
        row = con.execute("SELECT * FROM documents WHERE collection = ? AND id = ?",
                          (collection, doc_id)).fetchone()
        if if_version and (not row or str(row["version"]) != if_version.strip('"')):
            return jsonify(error="conflict", version=row["version"] if row else None), 409
        if merge:
            if not row:
                return jsonify(error="not_found"), 404
            data = json.loads(row["data"])
            for k, v in payload.items():
                if isinstance(v, dict) and v.get("__delete__") is True:
                    data.pop(k, None)
                else:
                    data[k] = v
        else:
            data = payload
        body = json.dumps(data, ensure_ascii=False)
        if len(body.encode()) > 1024 * 1024:
            return jsonify(error="too_large"), 413
        ts = now_iso()
        if row:
            con.execute("UPDATE documents SET data = ?, version = version + 1, updated_at = ?, updated_by = ? "
                        "WHERE collection = ? AND id = ?", (body, ts, g.user["username"], collection, doc_id))
        else:
            con.execute("INSERT INTO documents (collection, id, data, version, created_at, updated_at, updated_by) "
                        "VALUES (?,?,?,1,?,?,?)", (collection, doc_id, body, ts, ts, g.user["username"]))
        log_change(collection, doc_id, "update" if merge else "set")
        con.commit()
        out = con.execute("SELECT * FROM documents WHERE collection = ? AND id = ?", (collection, doc_id)).fetchone()
        return jsonify(doc_out(out)), (200 if row else 201)

    @app.put("/api/docs/<collection>/<doc_id>")
    @require("editor")
    def set_doc(collection, doc_id):
        return write_doc(collection, doc_id, merge=False)

    @app.patch("/api/docs/<collection>/<doc_id>")
    @require("editor")
    def update_doc(collection, doc_id):
        return write_doc(collection, doc_id, merge=True)

    @app.delete("/api/docs/<collection>/<doc_id>")
    @require("editor")
    def delete_doc(collection, doc_id):
        check_name(collection, doc_id)
        con = db()
        cur = con.execute("DELETE FROM documents WHERE collection = ? AND id = ?", (collection, doc_id))
        if cur.rowcount:
            log_change(collection, doc_id, "delete")
        con.commit()
        return jsonify(deleted=bool(cur.rowcount))

    @app.get("/api/changes")
    @require("viewer")
    def changes():
        since = int(request.args.get("since", 0))
        rows = db().execute("SELECT DISTINCT collection FROM changes WHERE seq > ?", (since,)).fetchall()
        return jsonify(seq=last_seq(), collections=[r["collection"] for r in rows])

    # -------------------------------------------------------------- assets
    @app.post("/api/assets")
    @require("editor")
    def upload_asset():
        f = request.files.get("file")
        if not f or not f.filename:
            return jsonify(error="invalid_argument", message="missing file"), 400
        ctype = (request.form.get("type") or f.mimetype or mimetypes.guess_type(f.filename)[0]
                 or "application/octet-stream").split(";")[0].strip().lower()
        if ctype not in ALLOWED_TYPES:
            return jsonify(error="unsupported_type"), 415
        asset_id = uuid.uuid4().hex
        path = Path(app.config["UPLOAD_DIR"]) / asset_id
        f.save(path)
        size = path.stat().st_size
        if size > MAX_UPLOAD:
            path.unlink(missing_ok=True)
            return jsonify(error="too_large"), 413
        con = db()
        con.execute("INSERT INTO assets (id, filename, content_type, size_bytes, created_by) VALUES (?,?,?,?,?)",
                    (asset_id, f.filename, ctype, size, g.user["username"]))
        con.commit()
        return jsonify(id=asset_id, url=f"/_blob/{asset_id}", sizeBytes=size, contentType=ctype), 201

    @app.delete("/api/assets/<asset_id>")
    @require("editor")
    def delete_asset(asset_id):
        check_name(asset_id)
        con = db()
        cur = con.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
        con.commit()
        (Path(app.config["UPLOAD_DIR"]) / asset_id).unlink(missing_ok=True)
        return jsonify(deleted=bool(cur.rowcount))

    @app.get("/_blob/<asset_id>")
    @require("viewer")
    def get_asset(asset_id):
        check_name(asset_id)
        row = db().execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        path = Path(app.config["UPLOAD_DIR"]) / asset_id
        if not row or not path.exists():
            abort(404)
        resp = send_file(path, mimetype=row["content_type"], download_name=row["filename"],
                         as_attachment=row["content_type"] == "image/svg+xml")
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    # ------------------------------------------------------- backup / admin
    @app.get("/api/export")
    @require("admin")
    def export_all():
        rows = db().execute("SELECT * FROM documents ORDER BY collection, id").fetchall()
        out: dict = {}
        for r in rows:
            out.setdefault(r["collection"], []).append({"id": r["id"], **json.loads(r["data"])})
        resp = jsonify(out)
        resp.headers["Content-Disposition"] = f'attachment; filename="crm-backup-{now_iso()[:10]}.json"'
        return resp

    @app.post("/api/import")
    @require("admin")
    def import_all():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            abort(400, description="body must be {collection: [docs]}")
        n = import_data(payload, g.user["username"])
        return jsonify(imported=n)

    @app.get("/api/users")
    @require("admin")
    def users_list():
        rows = db().execute("SELECT username, role, status, full_name, created_at FROM users "
                            "ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, username").fetchall()
        return jsonify(users=[dict(r) for r in rows])

    @app.put("/api/users/<username>")
    @require("admin")
    def users_put(username):
        check_name(username)
        body = request.get_json(silent=True) or {}
        exists = db().execute("SELECT role, status FROM users WHERE username = ?", (username,)).fetchone()
        role = body.get("role") or (exists["role"] if exists else "viewer")
        status = body.get("status") or (exists["status"] if exists else "active")
        password = body.get("password") or None
        if role not in ROLES:
            return jsonify(error="invalid_role", message="Vai trò không hợp lệ"), 400
        if status not in ("active", "pending", "disabled"):
            return jsonify(error="invalid_status", message="Trạng thái không hợp lệ"), 400
        if username == g.user["username"] and (status != "active" or role != "admin"):
            return jsonify(error="self", message="Không thể tự hạ quyền hoặc khóa chính mình"), 400
        if not exists and not password:
            return jsonify(error="weak_password", message="Tài khoản mới cần mật khẩu"), 400
        if password is not None and len(password) < 8:
            return jsonify(error="weak_password", message="Mật khẩu tối thiểu 8 ký tự"), 400
        if exists and exists["role"] == "admin" and exists["status"] == "active" \
                and (role != "admin" or status != "active") and admin_count() <= 1:
            return jsonify(error="last_admin", message="Phải còn ít nhất một admin"), 400
        upsert_user(username, password, role)
        con = db()
        if "fullName" in body:
            con.execute("UPDATE users SET full_name = ? WHERE username = ?", (str(body["fullName"])[:120] or None, username))
        con.execute("UPDATE users SET status = ? WHERE username = ?", (status, username))
        con.commit()
        return jsonify(username=username, role=role, status=status), (200 if exists else 201)

    @app.delete("/api/users/<username>")
    @require("admin")
    def users_delete(username):
        check_name(username)
        if username == g.user["username"]:
            return jsonify(error="self", message="Không thể xóa chính mình"), 400
        row = db().execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            return jsonify(error="not_found"), 404
        if row["role"] == "admin" and admin_count() <= 1:
            return jsonify(error="last_admin", message="Phải còn ít nhất một admin"), 400
        con = db()
        con.execute("DELETE FROM users WHERE username = ?", (username,))
        con.commit()
        return jsonify(deleted=True)

    @app.errorhandler(400)
    def bad_request(e):
        return jsonify(error="invalid_argument", message=getattr(e, "description", "")), 400

    @app.errorhandler(413)
    def too_large(e):
        return jsonify(error="too_large"), 413

    @app.after_request
    def headers(resp):
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    app.teardown_appcontext(close_db)
    return app


def _stored_secret(path: Path) -> str:
    """Keep one random signing key next to the database so logins survive restarts."""
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        key = os.urandom(32).hex()
        path.write_text(key)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return key


# ------------------------------------------------------------------ database
def db() -> sqlite3.Connection:
    from flask import current_app
    if "db" not in g:
        con = sqlite3.connect(current_app.config["DATABASE"], timeout=15)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        g.db = con
    return g.db


def close_db(_exc=None) -> None:
    con = g.pop("db", None)
    if con is not None:
        con.close()


def init_db() -> None:
    con = db()
    con.executescript((BASE_DIR / "schema.sql").read_text(encoding="utf-8"))
    cols = {r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()}
    if "status" not in cols:   # databases created by an earlier version
        con.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    if "full_name" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN full_name TEXT")
    con.commit()


def last_seq() -> int:
    row = db().execute("SELECT COALESCE(MAX(seq), 0) AS s FROM changes").fetchone()
    return int(row["s"])


def upsert_user(username: str, password: str | None, role: str) -> None:
    con = db()
    exists = con.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
    if exists and not password:
        con.execute("UPDATE users SET role = ? WHERE username = ?", (role, username))
    else:
        if not password:
            raise ValueError("password required for a new user")
        con.execute("INSERT INTO users (username, password_hash, role) VALUES (?,?,?) "
                    "ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role",
                    (username, generate_password_hash(password), role))
    con.commit()


def admin_count() -> int:
    return int(db().execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").fetchone()["n"])


def bootstrap_admin() -> None:
    """Create accounts from the environment when no user exists yet:
    ADMIN_USER / ADMIN_PASSWORD, and/or CRM_USERS="name:password:role,name2:password2:role2"."""
    if db().execute("SELECT 1 FROM users LIMIT 1").fetchone():
        return
    user, pw = os.environ.get("ADMIN_USER"), os.environ.get("ADMIN_PASSWORD")
    if user and pw:
        upsert_user(user, pw, "admin")
    for item in filter(None, (x.strip() for x in os.environ.get("CRM_USERS", "").split(","))):
        parts = item.split(":")
        if len(parts) == 3 and parts[2] in ROLES and NAME_RX.match(parts[0]) and parts[1]:
            upsert_user(parts[0], parts[1], parts[2])


def import_data(payload: dict, by: str = "import") -> int:
    """payload = {collection: [{id, ...fields}]}; existing documents with the same id are replaced."""
    con = db()
    n = 0
    ts = now_iso()
    for collection, docs in payload.items():
        if not NAME_RX.match(collection) or not isinstance(docs, list):
            continue
        for d in docs:
            if not isinstance(d, dict) or not NAME_RX.match(str(d.get("id", ""))):
                continue
            body = {k: v for k, v in d.items() if k != "id"}
            con.execute(
                "INSERT INTO documents (collection, id, data, version, created_at, updated_at, updated_by) "
                "VALUES (?,?,?,1,?,?,?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, "
                "version = documents.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                (collection, d["id"], json.dumps(body, ensure_ascii=False), ts, ts, by))
            con.execute("INSERT INTO changes (collection, doc_id, op, by_user) VALUES (?,?,?,?)",
                        (collection, d["id"], "set", by))
            n += 1
    con.commit()
    return n


app = create_app()


# ----------------------------------------------------------------------- CLI
def _cli(argv: list[str]) -> int:
    usage = ("Usage:\n  python app.py init-db\n  python app.py create-user <username> <password> <viewer|editor|admin>\n"
             "  python app.py import <file.json>\n  python app.py export <file.json>\n  python app.py run [port]")
    if not argv:
        print(usage)
        return 1
    cmd, args = argv[0], argv[1:]
    with app.app_context():
        if cmd == "init-db":
            init_db()
            print("Database ready:", app.config["DATABASE"])
        elif cmd == "create-user" and len(args) == 3 and args[2] in ROLES:
            upsert_user(args[0], args[1], args[2])
            print(f"User {args[0]} ({args[2]}) saved")
        elif cmd == "import" and len(args) == 1:
            payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))
            print("Imported", import_data(payload, "cli"), "documents")
        elif cmd == "export" and len(args) == 1:
            rows = db().execute("SELECT * FROM documents ORDER BY collection, id").fetchall()
            out: dict = {}
            for r in rows:
                out.setdefault(r["collection"], []).append({"id": r["id"], **json.loads(r["data"])})
            Path(args[0]).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
            print("Exported", len(rows), "documents to", args[0])
        elif cmd == "run":
            app.run(host="0.0.0.0", port=int(args[0]) if args else 8000)
        else:
            print(usage)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

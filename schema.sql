-- CRM Panel Plus — SQLite schema
-- The web app stores everything as JSON documents grouped in collections
-- (customers, allocations, promos, vouchers, uploads, marketPrices, sowData,
-- reportTemplates, orders, settings). One table holds them all.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
    collection  TEXT    NOT NULL,
    id          TEXT    NOT NULL,
    data        TEXT    NOT NULL CHECK (json_valid(data)),   -- the document body (JSON object)
    version     INTEGER NOT NULL DEFAULT 1,                  -- +1 on every write (optimistic locking)
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_by  TEXT,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (collection, updated_at);

-- Append-only change feed: the browser polls it to refresh live views.
CREATE TABLE IF NOT EXISTS changes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    collection  TEXT    NOT NULL,
    doc_id      TEXT    NOT NULL,
    op          TEXT    NOT NULL CHECK (op IN ('set','update','delete')),
    at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    by_user     TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_collection ON changes (collection, seq);

-- Uploaded files (purchase documents, signed reports, handover notes…).
-- The bytes live on disk under UPLOAD_DIR/<id>; this table keeps the metadata.
CREATE TABLE IF NOT EXISTS assets (
    id            TEXT    PRIMARY KEY,
    filename      TEXT    NOT NULL,
    content_type  TEXT    NOT NULL,
    size_bytes    INTEGER NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by    TEXT
);

-- Users (self sign-up + admin approval). role: viewer (read only) < editor (enter data) < admin (everything,
-- incl. moving volume between promotions and managing users).
CREATE TABLE IF NOT EXISTS users (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('viewer','editor','admin')),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','disabled')),
    full_name      TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- status: 'pending' = registered on the sign-up form, waiting for an admin to approve and pick a role;
--         'active'  = can sign in;  'disabled' = blocked by an admin.

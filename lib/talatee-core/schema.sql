-- Talatee Level 1 core schema — port PostgreSQL dari schema.sql (SQLite).
-- Model dan aturan bisnisnya SAMA PERSIS dengan versi SQLite -- yang beda
-- cuma tipe data & sintaks default value, supaya cocok dengan Postgres:
--   TEXT (untuk id)      -> tetap TEXT, tapi default pakai gen_random_uuid()
--   TEXT (untuk waktu)   -> TIMESTAMPTZ
--   REAL                 -> DOUBLE PRECISION (BUKAN NUMERIC -- driver `pg`
--                           mengembalikan NUMERIC sebagai string, yang akan
--                           diam-diam merusak semua perhitungan arithmetic
--                           di validation.ts/metrics.ts. DOUBLE PRECISION
--                           berperilaku sama seperti REAL di SQLite: selalu
--                           balik sebagai number JS)
--   INTEGER (boolean 0/1)-> BOOLEAN
--   datetime('now')      -> now()

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS businesses (
    business_id     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    business_name   TEXT NOT NULL,
    business_type   TEXT NOT NULL CHECK (business_type IN ('warung', 'laundry', 'bengkel', 'marketplace')),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    password_hash   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- 22 Sept 2026 (token versioning): memungkinkan invalidasi sesi/link per-tenant
    -- tanpa harus mengganti SESSION_SECRET global. Naikkan 1x -> semua token lama gugur.
    --   token_version     : dinaikkan saat logout atau ganti password
    --   share_key_version : dinaikkan saat pemilik toko merotasi link dashboard WA
    -- Untuk DB yang sudah ada, jalankan: scripts/migrate-add-token-versions.ts
    token_version       INTEGER NOT NULL DEFAULT 1,
    share_key_version   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sources (
    source_id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    business_id         TEXT NOT NULL REFERENCES businesses(business_id),
    source_type         TEXT NOT NULL CHECK (source_type IN
                            ('csv_upload', 'excel_upload', 'receipt_ocr', 'whatsapp_manual')),
    original_filename   TEXT,
    file_hash            TEXT NOT NULL,
    uploaded_by           TEXT NOT NULL,
    uploaded_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    status                  TEXT NOT NULL DEFAULT 'RECEIVED'
                              CHECK (status IN ('RECEIVED', 'PROCESSING', 'COMPLETED', 'FAILED')),
    failure_reason           TEXT,
    row_count                 INTEGER,
    processed_row_count       INTEGER DEFAULT 0,
    whatsapp_message_id       TEXT,

    -- Sampah (7 Sept 2026): "batal upload 1 batch sekaligus", dipakai bareng
    -- deleted_at di transactions di bawah -- lihat lifecycle.ts
    -- softDeleteSource()/hardDeleteSource(). deleted_by dicatat sama seperti
    -- performed_by di transaction_events, meski di Phase 1 (single-owner)
    -- isinya selalu sama.
    deleted_at              TIMESTAMPTZ,
    deleted_by                TEXT
);

-- UNIQUE (business_id, file_hash) SENGAJA jadi partial index (bukan
-- constraint UNIQUE biasa) supaya file yang sama BISA diupload ulang
-- setelah batch lamanya dibuang ke Sampah -- constraint biasa akan
-- menolak INSERT baru walau baris lamanya sudah "dihapus" (soft-delete
-- tetap menyisakan barisnya secara fisik, jadi UNIQUE biasa masih akan
-- bentrok). Kalau baris lama masih deleted_at IS NULL, tetap ditolak
-- seperti biasa (mencegah upload file yang sama 2x tanpa sengaja).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_business_file_hash_active
    ON sources(business_id, file_hash) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS transactions (
    row_id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    transaction_id         TEXT NOT NULL,
    version                  INTEGER NOT NULL,

    business_id                TEXT NOT NULL REFERENCES businesses(business_id),
    source_id                    TEXT NOT NULL REFERENCES sources(source_id),

    external_reference             TEXT,

    transaction_date                 TEXT NOT NULL,
    transaction_time                   TEXT,
    total_amount                         DOUBLE PRECISION NOT NULL,
    line_item_count                        INTEGER NOT NULL,

    status                                   TEXT NOT NULL
                                              CHECK (status IN
                                                ('RECEIVED', 'EXTRACTED', 'VALID', 'NEEDS_REVIEW',
                                                 'ACTIVE', 'SUPERSEDED', 'VOID')),

    previous_row_id                            TEXT REFERENCES transactions(row_id),
    validation_notes                             TEXT,

    -- Channel penjualan (15 Sept 2026, hasil diskusi soal client
    -- multi-channel) -- SUMBER KEBENARAN adalah pilihan dropdown wajib di
    -- UploadCsvForm.tsx (channel_mode), bukan kolom bebas di file upload,
    -- supaya tidak rawan typo/lupa diisi. Default 'Lainnya' murni supaya
    -- ALTER TABLE aman untuk baris lama yang sudah ada sebelum kolom ini
    -- dibuat -- baris baru SELALU eksplisit diisi lewat ingest.ts.
    channel                                        TEXT NOT NULL DEFAULT 'Lainnya'
                                                    CHECK (channel IN
                                                      ('Shopee', 'TikTok Shop', 'Lazada', 'WhatsApp', 'Lainnya')),

    created_at                                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by                                       TEXT NOT NULL,
    resolved_at                                        TIMESTAMPTZ,
    resolved_by                                          TEXT,

    -- Sampah (7 Sept 2026): soft-delete, ORTOGONAL terhadap `status` di
    -- atas -- sengaja BUKAN status baru (mis. 'DELETED'), supaya makna
    -- ACTIVE/VOID/SUPERSEDED yang sudah ada (dan sudah dipakai di banyak
    -- tempat: uq_one_active_per_transaction, laporan, dst) tidak perlu
    -- diubah sama sekali. "Dihapus" di sini murni soal "tampil atau tidak
    -- di semua query", terlepas dari status bisnisnya apa. Baris dengan
    -- deleted_at terisi TIDAK BOLEH muncul di query mana pun kecuali
    -- yang eksplisit untuk halaman Sampah (lihat metrics.ts listTrash*).
    deleted_at                                              TIMESTAMPTZ,
    deleted_by                                                TEXT
);

-- CORE INTEGRITY RULE: at most one ACTIVE row per transaction_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_per_transaction
    ON transactions(transaction_id)
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_transactions_business_date ON transactions(business_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_transaction_id ON transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_deleted_at ON transactions(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS transaction_lines (
    line_id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    transaction_row_id   TEXT NOT NULL REFERENCES transactions(row_id) ON DELETE CASCADE,

    product_or_service     TEXT NOT NULL,
    category                  TEXT,
    quantity                    DOUBLE PRECISION NOT NULL,
    unit_price                    DOUBLE PRECISION NOT NULL,
    subtotal                        DOUBLE PRECISION NOT NULL,

    weight_kg                         DOUBLE PRECISION,
    service_type                        TEXT,
    sparepart                             TEXT,
    technician                              TEXT
);

CREATE INDEX IF NOT EXISTS idx_transaction_lines_row ON transaction_lines(transaction_row_id);

CREATE TABLE IF NOT EXISTS transaction_events (
    event_id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    transaction_id         TEXT NOT NULL,
    from_row_id               TEXT REFERENCES transactions(row_id),
    to_row_id                   TEXT REFERENCES transactions(row_id),

    event_type                    TEXT NOT NULL CHECK (event_type IN ('CORRECTION', 'VOID')),
    reason                          TEXT NOT NULL CHECK (reason IN (
                                      'Salah input', 'OCR salah membaca', 'Duplikat',
                                      'Transaksi dibatalkan', 'Harga salah', 'Qty salah',
                                      'Tanggal salah', 'Lainnya')),
    reason_detail                      TEXT,

    performed_by                         TEXT NOT NULL,
    performed_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),

    confirmed_via_whatsapp                   BOOLEAN DEFAULT false,
    whatsapp_confirmation_message_id           TEXT
);

CREATE INDEX IF NOT EXISTS idx_transaction_events_txn ON transaction_events(transaction_id);

CREATE TABLE IF NOT EXISTS duplicate_flags (
    flag_id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    business_id              TEXT NOT NULL REFERENCES businesses(business_id),

    transaction_row_id         TEXT NOT NULL REFERENCES transactions(row_id),
    candidate_row_id             TEXT NOT NULL REFERENCES transactions(row_id),

    match_type                     TEXT NOT NULL CHECK (match_type IN ('EXACT_DUPLICATE', 'POTENTIAL_DUPLICATE')),
    match_score                      DOUBLE PRECISION,
    matched_fields                     TEXT, -- JSON array as text, sama seperti versi SQLite

    resolution_status                    TEXT NOT NULL DEFAULT 'PENDING'
                                          CHECK (resolution_status IN
                                            ('PENDING', 'CONFIRMED_DUPLICATE', 'CONFIRMED_NEW')),
    resolved_by                             TEXT,
    resolved_at                               TIMESTAMPTZ,

    created_at                                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_duplicate_flags_status ON duplicate_flags(resolution_status);

-- === Kelola Produk & Stok ==================================================
-- Ditambahkan 5 Sept 2026. Sengaja mengikuti prinsip yang sama dengan
-- transactions/transaction_events: stok TIDAK PERNAH diubah langsung dengan
-- UPDATE polos dari luar -- satu-satunya jalur adalah adjustStock() di
-- products.ts, yang menulis products.stock_qty DAN 1 baris di
-- stock_adjustments dalam 1 DB transaction (BEGIN/COMMIT), supaya angka stok
-- selalu punya riwayat yang bisa ditelusuri (traceable), bukan cuma angka
-- yang berubah diam-diam.
--
-- Produk TIDAK PERNAH di-hard-delete -- "hapus" = is_active jadi false
-- (soft delete/arsip), konsisten dengan prinsip void transaksi (data tidak
-- pernah hilang, cuma disembunyikan dari tampilan aktif).

CREATE TABLE IF NOT EXISTS products (
    product_id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    business_id           TEXT NOT NULL REFERENCES businesses(business_id),

    name                  TEXT NOT NULL,
    category              TEXT,
    unit                  TEXT NOT NULL DEFAULT 'pcs',
    price                 DOUBLE PRECISION,

    stock_qty             DOUBLE PRECISION NOT NULL DEFAULT 0,
    low_stock_threshold   DOUBLE PRECISION,

    is_active             BOOLEAN NOT NULL DEFAULT true,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            TEXT NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mencegah 2 produk aktif dengan nama sama persis (case-insensitive) di 1
-- bisnis yang sama -- tapi TIDAK berlaku untuk produk yang sudah diarsipkan,
-- supaya nama lama tetap bisa dipakai ulang untuk produk baru kalau perlu.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_product_name_per_business
    ON products(business_id, lower(name))
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);

CREATE TABLE IF NOT EXISTS stock_adjustments (
    adjustment_id     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    product_id        TEXT NOT NULL REFERENCES products(product_id),
    business_id       TEXT NOT NULL REFERENCES businesses(business_id),

    delta             DOUBLE PRECISION NOT NULL, -- positif = stok masuk, negatif = stok keluar
    stock_after       DOUBLE PRECISION NOT NULL, -- snapshot supaya riwayat gampang dibaca tanpa replay

    reason            TEXT NOT NULL CHECK (reason IN
                        ('Stok masuk', 'Terjual manual', 'Rusak/hilang', 'Koreksi hitung ulang', 'Lainnya')),
    reason_detail     TEXT,

    performed_by      TEXT NOT NULL,
    performed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id, performed_at DESC);
-- Rate limiting login (16 Sept 2026) -- mencegah brute-force password.
-- identifier = business_id (client) atau '__platform_admin__' (admin).
-- 5 kali gagal berturut-turut -> terkunci 15 menit. Sukses login reset
-- ke 0. Tidak pakai IP address (bisa dipalsukan/shared NAT), cukup
-- per-akun -- sesuai dengan model ancaman "orang coba tebak password 1
-- link tertentu", bukan DDoS skala besar.
CREATE TABLE IF NOT EXISTS login_attempts (
    identifier    TEXT PRIMARY KEY,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Log audit aksi admin terhadap client (16 Sept 2026) -- siapa
-- buat/nonaktifkan/aktifkan/hapus client mana, kapan. Penting kalau
-- nanti ada lebih dari 1 orang yang kelola /ops/clients. target_business_name
-- disimpan terpisah (bukan cuma JOIN ke businesses) supaya riwayat tetap
-- terbaca jelas walau client itu sudah dihapus permanen.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    log_id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    action               TEXT NOT NULL CHECK (action IN ('CREATE_CLIENT', 'ACTIVATE', 'DEACTIVATE', 'DELETE_CLIENT')),
    target_business_id    TEXT NOT NULL,
    target_business_name   TEXT NOT NULL,
    performed_by             TEXT NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

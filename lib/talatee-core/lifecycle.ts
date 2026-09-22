import { randomUUID } from "crypto";
import { CorrectionReason } from "./types";
import { Db } from "./db";

export class LifecycleError extends Error {}

/** Fix a NEEDS_REVIEW row IN PLACE (same row_id, same version) — this row
 * was never ACTIVE, so there is nothing to preserve a superseded copy of.
 * See flows/02_needs_review_flow.md. */
export async function resolveNeedsReview(
  db: Db,
  row_id: string,
  business_id: string,
  edits: { total_amount?: number; transaction_date?: string; transaction_time?: string },
  resolved_by: string
) {
  const txn = await db.get(`SELECT * FROM transactions WHERE row_id = $1 AND business_id = $2`, [row_id, business_id]);
  if (!txn) throw new LifecycleError("Transaksi tidak ditemukan.");
  if ((txn as any).status !== "NEEDS_REVIEW") {
    throw new LifecycleError(
      "Hanya transaksi berstatus NEEDS_REVIEW yang bisa diselesaikan lewat jalur ini. " +
        "Transaksi ACTIVE harus menggunakan createCorrection()."
    );
  }

  await db.run(
    `UPDATE transactions
     SET status = 'ACTIVE',
         total_amount = COALESCE($1, total_amount),
         transaction_date = COALESCE($2, transaction_date),
         transaction_time = COALESCE($3, transaction_time),
         validation_notes = NULL,
         resolved_by = $4,
         resolved_at = now()
     WHERE row_id = $5 AND business_id = $6`,
    [edits.total_amount ?? null, edits.transaction_date ?? null, edits.transaction_time ?? null, resolved_by, row_id, business_id]
  );

  return { row_id, status: "ACTIVE" as const };
}

/** Correct an ACTIVE transaction: creates a NEW VERSION, old version ->
 * SUPERSEDED. Never increments Orders count. See flows/02.
 *
 * Dulu (SQLite) pakai db.transaction(() => {...}) yang synchronous.
 * Postgres versinya butuh 1 CONNECTION YANG SAMA untuk BEGIN...COMMIT --
 * makanya di sini kita checkout 1 client dari pool (db.connect()), bukan
 * pakai `db` (pool) langsung untuk query di dalam transaksi. Kalau ada
 * error di tengah, ROLLBACK, baru lempar errornya lagi. client.release()
 * WAJIB dipanggil di finally supaya koneksi balik ke pool, tidak bocor. */
export async function createCorrection(
  db: Db,
  row_id: string,
  business_id: string,
  newValues: { total_amount: number },
  reason: CorrectionReason,
  reason_detail: string | null,
  corrected_by: string
) {
  const txn = await db.get(`SELECT * FROM transactions WHERE row_id = $1 AND business_id = $2`, [row_id, business_id]);
  if (!txn) throw new LifecycleError("Transaksi tidak ditemukan.");
  const txnRow = txn as any;
  if (txnRow.status !== "ACTIVE") {
    throw new LifecycleError(
      "Hanya transaksi berstatus ACTIVE yang bisa dikoreksi. " +
        "Transaksi NEEDS_REVIEW harus menggunakan resolveNeedsReview()."
    );
  }

  const new_row_id = randomUUID();
  const new_version = txnRow.version + 1;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Guard: if this row was already superseded by a concurrent correction,
    // this UPDATE affects 0 rows — we detect that and abort instead of
    // silently inserting a second ACTIVE version (uq_one_active_per_transaction
    // would also reject it, but we want a clear message before that).
    const info = await client.query(
      `UPDATE transactions SET status = 'SUPERSEDED' WHERE row_id = $1 AND business_id = $2 AND status = 'ACTIVE'`,
      [row_id, business_id]
    );
    if (info.rowCount === 0) {
      throw new LifecycleError("Transaksi ini sudah diubah oleh proses lain. Silakan muat ulang dan coba lagi.");
    }

    await client.query(
      `INSERT INTO transactions
         (row_id, transaction_id, version, business_id, source_id, external_reference,
          transaction_date, transaction_time, total_amount, line_item_count, status,
          previous_row_id, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11, now(), $12)`,
      [
        new_row_id,
        txnRow.transaction_id,
        new_version,
        txnRow.business_id,
        txnRow.source_id,
        txnRow.external_reference,
        txnRow.transaction_date,
        txnRow.transaction_time,
        newValues.total_amount,
        txnRow.line_item_count,
        row_id,
        corrected_by,
      ]
    );

    await client.query(
      `INSERT INTO transaction_events
         (event_id, transaction_id, from_row_id, to_row_id, event_type, reason, reason_detail, performed_by)
       VALUES ($1, $2, $3, $4, 'CORRECTION', $5, $6, $7)`,
      [randomUUID(), txnRow.transaction_id, row_id, new_row_id, reason, reason_detail, corrected_by]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { row_id: new_row_id, transaction_id: txnRow.transaction_id, version: new_version };
}

/** Void an ACTIVE transaction: the event never happened / is cancelled.
 * Original row is preserved (status flips to VOID), nothing is deleted. */
export async function voidTransaction(
  db: Db,
  row_id: string,
  business_id: string,
  reason: CorrectionReason,
  reason_detail: string | null,
  performed_by: string
) {
  const txn = await db.get(`SELECT * FROM transactions WHERE row_id = $1 AND business_id = $2`, [row_id, business_id]);
  if (!txn) throw new LifecycleError("Transaksi tidak ditemukan.");
  const txnRow = txn as any;
  if (txnRow.status !== "ACTIVE") {
    throw new LifecycleError("Hanya transaksi ACTIVE yang bisa dibatalkan (void).");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const info = await client.query(
      `UPDATE transactions SET status = 'VOID' WHERE row_id = $1 AND business_id = $2 AND status = 'ACTIVE'`,
      [row_id, business_id]
    );
    if (info.rowCount === 0) {
      throw new LifecycleError("Transaksi ini sudah diubah oleh proses lain. Muat ulang dan coba lagi.");
    }

    await client.query(
      `INSERT INTO transaction_events
         (event_id, transaction_id, from_row_id, to_row_id, event_type, reason, reason_detail, performed_by)
       VALUES ($1, $2, $3, NULL, 'VOID', $4, $5, $6)`,
      [randomUUID(), txnRow.transaction_id, row_id, reason, reason_detail, performed_by]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { row_id, status: "VOID" as const };
}

/** Resolve a PENDING duplicate_flags row — either confirming it as a
 * real duplicate (caller should then call voidTransaction separately
 * with reason "Duplikat") or dismissing it as a false positive. Never
 * auto-merges or auto-deletes — this only records the human decision. */
export async function resolveDuplicateFlag(
  db: Db,
  flag_id: string,
  business_id: string,
  resolution: "CONFIRMED_DUPLICATE" | "CONFIRMED_NEW",
  resolved_by: string
) {
  const flag = await db.get(`SELECT * FROM duplicate_flags WHERE flag_id = $1 AND business_id = $2`, [flag_id, business_id]);
  if (!flag) throw new LifecycleError("Duplicate flag tidak ditemukan.");
  if ((flag as any).resolution_status !== "PENDING") {
    throw new LifecycleError("Duplicate flag ini sudah diselesaikan sebelumnya.");
  }

  await db.run(
    `UPDATE duplicate_flags
     SET resolution_status = $1, resolved_by = $2, resolved_at = now()
     WHERE flag_id = $3 AND business_id = $4`,
    [resolution, resolved_by, flag_id, business_id]
  );

  return { flag_id, resolution_status: resolution };
}

// ============================================================================
// SAMPAH (7 Sept 2026) -- soft delete + hard delete, khusus dibuat untuk
// kebutuhan bersih-bersih data LATIHAN/TESTING (lihat DASHBOARD_TERANG_
// MOBILE_NOTES.md untuk konteks diskusinya). Pola 2 tahap yang SENGAJA:
//
//   1. softDelete*  -- reversibel, "ke Sampah". Baris TETAP ada di
//      database (deleted_at diisi), langsung hilang dari semua tampilan/
//      laporan (lihat filter "AND deleted_at IS NULL" di metrics.ts,
//      duplicate.ts, ingest.ts). Bisa dipulihkan kapan saja lewat
//      restore*.
//   2. hardDelete*  -- PERMANEN, TIDAK BISA DIBATALKAN. Sengaja TIDAK
//      diekspos lewat rute yang sama dengan soft delete -- di UI/API,
//      hard delete cuma bisa dipanggil dari halaman Sampah (2 langkah
//      sadar sebelum data beneran hilang), tidak pernah langsung dari
//      halaman Transaksi/Upload.
//
// Ini beda dari voidTransaction() di atas: VOID artinya "transaksi ini
// beneran terjadi tapi dibatalkan" (bagian dari riwayat bisnis, harus
// tetap ada selamanya untuk audit). Soft-delete artinya "baris ini
// sampah/tidak relevan sama sekali" (data uji coba, salah upload, dst) --
// makanya boleh dihapus permanen, sedangkan VOID tidak.

export class DeletionBlockedError extends LifecycleError {}

/** Hapus 1 transaksi ke Sampah (reversibel). Tidak peduli status-nya apa
 * (ACTIVE/NEEDS_REVIEW/VOID/SUPERSEDED) -- untuk keperluan bersih-bersih
 * data uji, semua boleh dibuang, bukan cuma yang ACTIVE. */
export async function softDeleteTransaction(db: Db, row_id: string, business_id: string, deleted_by: string) {
  const result = await db.run(
    `UPDATE transactions SET deleted_at = now(), deleted_by = $2 WHERE row_id = $1 AND business_id = $3 AND deleted_at IS NULL`,
    [row_id, deleted_by, business_id]
  );
  if (result.rowCount === 0) {
    const exists = await db.get(`SELECT row_id FROM transactions WHERE row_id = $1 AND business_id = $2`, [row_id, business_id]);
    throw new LifecycleError(exists ? "Transaksi ini sudah ada di Sampah." : "Transaksi tidak ditemukan.");
  }
  return { row_id, deleted: true };
}

export async function restoreTransaction(db: Db, row_id: string, business_id: string) {
  // Jaga ownership: hanya pemilik business yang bisa memulihkan transaksi miliknya
  const exists = await db.get(
    `SELECT row_id FROM transactions WHERE row_id = $1 AND business_id = $2 AND deleted_at IS NOT NULL`,
    [row_id, business_id]
  );
  if (!exists) throw new LifecycleError("Transaksi tidak ada di Sampah (atau tidak ditemukan / bukan milik Anda).");
  const result = await db.run(
    `UPDATE transactions SET deleted_at = NULL, deleted_by = NULL WHERE row_id = $1 AND business_id = $2 AND deleted_at IS NOT NULL`,
    [row_id, business_id]
  );
  if (result.rowCount === 0) throw new LifecycleError("Transaksi tidak ada di Sampah (atau tidak ditemukan).");
  return { row_id, deleted: false };
}

export async function softDeleteSource(db: Db, source_id: string, business_id: string, deleted_by: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const src = await client.query(`SELECT source_id FROM sources WHERE source_id = $1 AND business_id = $2 AND deleted_at IS NULL`, [
      source_id,
      business_id,
    ]);
    if (src.rowCount === 0) {
      throw new LifecycleError("Batch upload ini tidak ditemukan (atau sudah ada di Sampah).");
    }

    await client.query(`UPDATE sources SET deleted_at = now(), deleted_by = $2 WHERE source_id = $1 AND business_id = $3`, [
      source_id,
      deleted_by,
      business_id,
    ]);
    const txns = await client.query(
      `UPDATE transactions SET deleted_at = now(), deleted_by = $2
         WHERE source_id = $1 AND business_id = $3 AND deleted_at IS NULL
         RETURNING row_id`,
      [source_id, deleted_by, business_id]
    );

    await client.query("COMMIT");
    return { source_id, deleted: true, affected_transactions: txns.rowCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Pulihkan 1 batch upload -- catatan: memulihkan SEMUA transaksi dari
 * source ini yang sedang di Sampah, termasuk yang (secara kebetulan)
 * sebelumnya dihapus satu-satu lewat softDeleteTransaction, bukan cuma
 * yang ikut terhapus lewat softDeleteSource. Ini simplifikasi yang
 * disengaja -- sistem ini tidak mencatat "batch mana yang menyebabkan
 * baris ini kehapus", cuma "kapan". Untuk kebutuhan data uji/testing ini
 * cukup aman; kalau nanti butuh presisi per-aksi, perlu kolom tambahan. */
export async function restoreSource(db: Db, source_id: string, business_id: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const src = await client.query(`SELECT source_id FROM sources WHERE source_id = $1 AND business_id = $2 AND deleted_at IS NOT NULL`, [
      source_id,
      business_id,
    ]);
    if (src.rowCount === 0) {
      throw new LifecycleError("Batch upload ini tidak ada di Sampah (atau tidak ditemukan).");
    }

    await client.query(`UPDATE sources SET deleted_at = NULL, deleted_by = NULL WHERE source_id = $1 AND business_id = $2`, [source_id, business_id]);
    const txns = await client.query(
      `UPDATE transactions SET deleted_at = NULL, deleted_by = NULL
         WHERE source_id = $1 AND business_id = $2 AND deleted_at IS NOT NULL
         RETURNING row_id`,
      [source_id, business_id]
    );

    await client.query("COMMIT");
    return { source_id, deleted: false, affected_transactions: txns.rowCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Hapus 1 transaksi PERMANEN. Membersihkan semua yang "menempel" dulu
 * (urutan penting -- FK-nya tidak ON DELETE CASCADE):
 *   1. transaction_events yang menyebut baris ini (from_row_id/to_row_id)
 *      -- jejak koreksi/void. Untuk data uji ini aman ikut dibuang,
 *      beda dengan transaksi bisnis asli yang jejaknya harus dijaga.
 *   2. duplicate_flags yang menyebut baris ini (di salah satu sisi).
 *   3. previous_row_id di baris LAIN yang menunjuk ke baris ini (kalau
 *      baris ini pernah "dikoreksi jadi versi baru", versi barunya
 *      menunjuk balik ke sini lewat previous_row_id) -- di-NULL-kan dulu,
 *      bukan ikut dihapus (versi barunya sendiri tidak salah, cuma
 *      kehilangan link ke versi sebelumnya).
 *   4. transaction_lines ikut lewat ON DELETE CASCADE otomatis.
 *   5. baris transactions itu sendiri.
 * WAJIB dipanggil hanya untuk baris yang statusnya sudah di Sampah
 * (deleted_at IS NOT NULL) -- dijaga di sini, bukan cuma di lapisan API,
 * supaya fungsi ini sendiri tidak bisa "kebobolan" menghapus data yang
 * belum sempat lewat tahap Sampah. */
export async function hardDeleteTransaction(db: Db, row_id: string, business_id: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const txn = await client.query(
      `SELECT row_id, deleted_at FROM transactions WHERE row_id = $1 AND business_id = $2`,
      [row_id, business_id]
    );
    if (txn.rowCount === 0) throw new LifecycleError("Transaksi tidak ditemukan atau bukan milik Anda.");
    if (!txn.rows[0].deleted_at) {
      throw new DeletionBlockedError(
        "Transaksi ini belum ada di Sampah -- hapus ke Sampah dulu sebelum bisa dihapus permanen."
      );
    }

    await client.query(`DELETE FROM transaction_events WHERE from_row_id = $1 OR to_row_id = $1`, [row_id]);
    await client.query(`DELETE FROM duplicate_flags WHERE transaction_row_id = $1 OR candidate_row_id = $1`, [
      row_id,
    ]);
    await client.query(`UPDATE transactions SET previous_row_id = NULL WHERE previous_row_id = $1`, [row_id]);
    await client.query(`DELETE FROM transactions WHERE row_id = $1 AND business_id = $2`, [row_id, business_id]);

    await client.query("COMMIT");
    return { row_id, permanently_deleted: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Hapus 1 batch upload PERMANEN -- source-nya DAN semua transaksi
 * turunannya. Sama seperti hardDeleteTransaction, WAJIB source-nya sudah
 * di Sampah dulu. */
export async function hardDeleteSource(db: Db, source_id: string, business_id: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const src = await client.query(
      `SELECT source_id, deleted_at FROM sources WHERE source_id = $1 AND business_id = $2`,
      [source_id, business_id]
    );
    if (src.rowCount === 0) throw new LifecycleError("Batch upload tidak ditemukan atau bukan milik Anda.");
    if (!src.rows[0].deleted_at) {
      throw new DeletionBlockedError(
        "Batch upload ini belum ada di Sampah -- hapus ke Sampah dulu sebelum bisa dihapus permanen."
      );
    }

    const rows = await client.query(`SELECT row_id FROM transactions WHERE source_id = $1 AND business_id = $2`, [
      source_id,
      business_id,
    ]);
    for (const { row_id } of rows.rows as { row_id: string }[]) {
      await client.query(`DELETE FROM transaction_events WHERE from_row_id = $1 OR to_row_id = $1`, [row_id]);
      await client.query(`DELETE FROM duplicate_flags WHERE transaction_row_id = $1 OR candidate_row_id = $1`, [
        row_id,
      ]);
      await client.query(`UPDATE transactions SET previous_row_id = NULL WHERE previous_row_id = $1`, [row_id]);
    }
    await client.query(`DELETE FROM transactions WHERE source_id = $1 AND business_id = $2`, [source_id, business_id]);
    await client.query(`DELETE FROM sources WHERE source_id = $1 AND business_id = $2`, [source_id, business_id]);

    await client.query("COMMIT");
    return { source_id, permanently_deleted: true, affected_transactions: rows.rowCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

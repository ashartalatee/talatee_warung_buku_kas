import "./_load-env";

// Perbaikan DATA LAMA untuk bug "tanggal transaksi ada di masa depan"
// (PROJECT_CONTEXT.md §7). Bug KODE-nya sudah diperbaiki di
// lib/talatee-core/validation.ts + metrics.ts + route API terkait (lihat
// lib/talatee-core/date-utils.ts untuk analisis akar penyebabnya) --
// script ini membereskan baris yang SUDAH kadung ke-flag NEEDS_REVIEW
// sebelum perbaikan itu ada, supaya tidak harus di-klik "Selesaikan" satu
// per satu lewat dashboard.
//
// SENGAJA HATI-HATI. Hanya menyentuh baris yang MEMENUHI KETIGANYA:
//   1. status = NEEDS_REVIEW
//   2. validation_notes PERSIS SATU pesan error, dan pesannya PERSIS pola
//      "Tanggal transaksi (...) ada di masa depan" -- baris yang error-nya
//      GABUNGAN (misalnya tanggal + arithmetic sekaligus) DILEWATI, karena
//      itu tetap butuh review manusia, bukan auto-fix.
//   3. Setelah dihitung ulang pakai tanggal-lokal-WIB yang benar (bukan UTC),
//      tanggal transaksinya TERNYATA TIDAK di masa depan -- baris yang
//      memang beneran salah ketik tanggal (kasus asli, bukan gara-gara bug)
//      tetap dilewati, tetap butuh review manusia seperti biasa.
//
// Default: DRY RUN -- cuma menampilkan daftar, TIDAK mengubah apa pun.
// Tambahkan --apply untuk benar-benar menerapkan.
//
// Pakai:
//   npx tsx scripts/fix-future-date-false-positives.ts           (dry run)
//   npx tsx scripts/fix-future-date-false-positives.ts --apply   (terapkan)

import { openDatabase } from "../lib/talatee-core/db";
import { resolveNeedsReview } from "../lib/talatee-core/lifecycle";
import { getTodayLocalDate } from "../lib/talatee-core/date-utils";

const FUTURE_DATE_PATTERN = /^Tanggal transaksi \(\d{4}-\d{2}-\d{2}\) ada di masa depan$/;

interface Candidate {
  row_id: string;
  business_id: string;
  transaction_id: string;
  transaction_date: string;
  validation_notes: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL belum diisi di .env.local.");
    process.exit(1);
  }

  const db = openDatabase(connectionString!);
  const todayLocal = getTodayLocalDate();

  const candidates = await db.all<Candidate>(
    `SELECT row_id, business_id, transaction_id, transaction_date, validation_notes
       FROM transactions
      WHERE status = 'NEEDS_REVIEW'
        AND validation_notes ILIKE '%ada di masa depan%'
      ORDER BY transaction_date ASC`
  );

  console.log(`Ditemukan ${candidates.length} baris NEEDS_REVIEW yang menyebut "masa depan".`);
  console.log(`Tanggal hari ini (WIB, dipakai untuk pengecekan ulang): ${todayLocal}\n`);

  const toFix: Candidate[] = [];
  const skippedMixed: Candidate[] = [];
  const skippedGenuine: Candidate[] = [];

  for (const row of candidates) {
    const notes = (row.validation_notes ?? "").trim();
    const parts = notes.split(";").map((s: string) => s.trim());
    const isSoleFutureDateError = parts.length === 1 && FUTURE_DATE_PATTERN.test(parts[0]);

    if (!isSoleFutureDateError) {
      skippedMixed.push(row);
      continue;
    }
    if (row.transaction_date > todayLocal) {
      // Beneran di masa depan menurut tanggal lokal yang benar -- kemungkinan
      // salah ketik asli, bukan gara-gara bug. Tetap butuh review manusia.
      skippedGenuine.push(row);
      continue;
    }
    toFix.push(row);
  }

  console.log(`-> ${toFix.length} baris terkonfirmasi false-positive (aman di-auto-selesaikan)`);
  console.log(`-> ${skippedMixed.length} baris dilewati (error gabungan, tetap butuh review manusia)`);
  console.log(
    `-> ${skippedGenuine.length} baris dilewati (tanggalnya BENAR di masa depan, kemungkinan salah ketik asli)`
  );

  if (skippedMixed.length > 0) {
    console.log("\nBaris dengan error gabungan (dilewati, cek manual di dashboard):");
    for (const r of skippedMixed) {
      console.log(`  ${r.row_id}  ${r.transaction_date}  ${r.validation_notes}`);
    }
  }
  if (skippedGenuine.length > 0) {
    console.log("\nBaris yang tanggalnya beneran di masa depan (dilewati, cek manual di dashboard):");
    for (const r of skippedGenuine) {
      console.log(`  ${r.row_id}  ${r.transaction_date}`);
    }
  }

  if (!apply) {
    console.log(`\nDRY RUN -- belum ada perubahan disimpan.`);
    console.log(`Jalankan ulang dengan --apply untuk menerapkan ke ${toFix.length} baris di atas.`);
    await db.end();
    return;
  }

  console.log(`\nMenerapkan perbaikan ke ${toFix.length} baris...`);
  for (const row of toFix) {
    await resolveNeedsReview(db, row.row_id, row.business_id, {}, "system:fix-timezone-bug-2026-09-05");
    console.log(`  OK  ${row.row_id}  (${row.transaction_date}) -> ACTIVE`);
  }
  console.log(`\nSelesai. ${toFix.length} baris dipindahkan dari NEEDS_REVIEW ke ACTIVE.`);

  await db.end();
}

main().catch((err) => {
  console.error("Gagal menjalankan perbaikan:", err instanceof Error ? err.message : err);
  process.exit(1);
});
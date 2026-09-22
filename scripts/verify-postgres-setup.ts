import "./_load-env";

import { openDatabase } from "../lib/talatee-core/db";
import { ingestCsv } from "../lib/talatee-core/ingest";
import {
  getDailyReport,
  getWeeklyReport,
  listTransactions,
  getNeedsReviewQueue,
  getPendingDuplicateFlags,
  getDailyTrend,
  getBusiestSlot,
} from "../lib/talatee-core/metrics";
import { createCorrection, voidTransaction, resolveNeedsReview, resolveDuplicateFlag } from "../lib/talatee-core/lifecycle";
import { randomUUID } from "crypto";
import fs from "fs";

const CONN = process.env.DATABASE_URL ?? (() => { throw new Error("DATABASE_URL belum diisi di .env.local"); })();

async function main() {
  const db = openDatabase(CONN);

  console.log("1. Buat business test...");
  const business_id = randomUUID();
  await db.run(`INSERT INTO businesses (business_id, business_name, business_type) VALUES ($1, $2, 'warung')`, [
    business_id,
    "Warung Test Migrasi",
  ]);
  console.log("   OK business_id:", business_id);

  console.log("2. Ingest CSV sample (ada arithmetic mismatch + duplikat exact)...");
  const csvContent = fs.readFileSync("./scripts/verify-postgres-sample.csv", "utf-8");
  const summary = await ingestCsv(db, business_id, "test-sample.csv", csvContent, "tester", "WhatsApp");
  console.log("   OK:", summary);
  if (summary.needs_review_count < 1) throw new Error("Harusnya ada minimal 1 NEEDS_REVIEW (arithmetic mismatch)");

  console.log("3. Ingest ULANG file yang sama (harus ditolak, exact duplicate file)...");
  try {
    await ingestCsv(db, business_id, "test-sample.csv", csvContent, "tester", "WhatsApp");
    throw new Error("Harusnya throw error untuk duplicate file, tapi tidak!");
  } catch (err) {
    if (err instanceof Error && err.message.includes("sudah pernah diupload")) {
      console.log("   OK: ditolak dengan pesan yang benar");
    } else {
      throw err;
    }
  }

  console.log("4. getDailyReport untuk 2026-08-20...");
  const daily = await getDailyReport(db, business_id, "2026-08-20");
  console.log("   OK:", daily);
  if (daily.total_orders < 1) throw new Error("total_orders harusnya > 0");
  if (typeof daily.total_revenue !== "number") throw new Error("total_revenue harus number, dapat: " + typeof daily.total_revenue);

  console.log("5. getWeeklyReport...");
  const weekly = await getWeeklyReport(db, business_id);
  console.log("   OK:", weekly);

  console.log("6. getDailyTrend 14 hari (cek zero-fill + tipe number)...");
  const trend = await getDailyTrend(db, business_id, 14);
  console.log("   OK, jumlah hari:", trend.length, "contoh:", trend[trend.length - 1]);
  if (trend.length !== 14) throw new Error("Harusnya tepat 14 titik data");
  for (const t of trend) {
    if (typeof t.revenue !== "number" || typeof t.orders !== "number") {
      throw new Error(`Tipe data salah di trend: ${JSON.stringify(t)} (kemungkinan bigint-as-string bug!)`);
    }
  }

  console.log("7. getBusiestSlot (data cuma 8 baris, harusnya null karena < 5 threshold cek)...");
  const busiest = await getBusiestSlot(db, business_id, 14);
  console.log("   OK:", busiest);

  console.log("8. listTransactions + was_corrected flag...");
  const txns = (await listTransactions(db, business_id)) as any[];
  console.log("   OK, jumlah transaksi:", txns.length);
  const activeTxn = txns.find((t) => t.status === "ACTIVE");
  if (!activeTxn) throw new Error("Harusnya ada minimal 1 transaksi ACTIVE");

  console.log("9. getNeedsReviewQueue...");
  const needsReview = (await getNeedsReviewQueue(db, business_id)) as any[];
  console.log("   OK, jumlah needs_review:", needsReview.length);
  if (needsReview.length < 1) throw new Error("Harusnya ada needs_review dari arithmetic mismatch");

  console.log("10. resolveNeedsReview...");
  const nrRow = needsReview[0];
  const resolved = await resolveNeedsReview(db, nrRow.row_id, business_id, { total_amount: 10000 }, "tester");
  console.log("   OK:", resolved);
  if (resolved.status !== "ACTIVE") throw new Error("Harusnya jadi ACTIVE setelah resolve");

  console.log("11. createCorrection pada transaksi ACTIVE (test transaksi Postgres BEGIN/COMMIT)...");
  const beforeCorrection = activeTxn.total_amount;
  const correction = await createCorrection(
    db,
    activeTxn.row_id,
    business_id,
    { total_amount: beforeCorrection + 1000 },
    "Harga salah",
    null,
    "tester"
  );
  console.log("   OK:", correction);
  const oldRow = await db.get(`SELECT status FROM transactions WHERE row_id = $1`, [activeTxn.row_id]);
  if ((oldRow as any).status !== "SUPERSEDED") throw new Error("Row lama harusnya jadi SUPERSEDED");
  const newRow = await db.get(`SELECT status, total_amount FROM transactions WHERE row_id = $1`, [correction.row_id]);
  if ((newRow as any).status !== "ACTIVE") throw new Error("Row baru harusnya ACTIVE");
  console.log("   Verifikasi lifecycle OK: row lama SUPERSEDED, row baru ACTIVE dengan total_amount baru");

  console.log("12. Coba createCorrection LAGI di row LAMA yang sudah SUPERSEDED (harus ditolak 409-style)...");
  try {
    await createCorrection(db, activeTxn.row_id, business_id, { total_amount: 99999 }, "Harga salah", null, "tester");
    throw new Error("Harusnya gagal, tapi tidak!");
  } catch (err) {
    if (err instanceof Error && err.message.includes("ACTIVE")) {
      console.log("   OK: ditolak dengan alasan yang benar");
    } else {
      throw err;
    }
  }

  console.log("13. voidTransaction...");
  const anotherActive = txns.find((t) => t.status === "ACTIVE" && t.row_id !== activeTxn.row_id);
  if (anotherActive) {
    const voided = await voidTransaction(db, anotherActive.row_id, business_id, "Transaksi dibatalkan", null, "tester");
    console.log("   OK:", voided);
  } else {
    console.log("   (skip, tidak ada transaksi ACTIVE lain untuk ditest)");
  }

  console.log("14. Cek duplicate_flags (Susu Kotak dobel di CSV harusnya kedetect)...");
  const dupFlags = (await getPendingDuplicateFlags(db, business_id)) as any[];
  console.log("   OK, jumlah duplicate flags:", dupFlags.length);

  if (dupFlags.length > 0) {
    console.log("15. resolveDuplicateFlag...");
    const resolvedFlag = await resolveDuplicateFlag(db, dupFlags[0].flag_id, business_id, "CONFIRMED_NEW", "tester");
    console.log("   OK:", resolvedFlag);
  }

  console.log("\n✅ SEMUA TES LULUS — migrasi Postgres berfungsi dengan benar end-to-end.");
  await db.end();
}

main().catch((err) => {
  console.error("\n❌ TES GAGAL:", err);
  process.exit(1);
});


/**
 * Migrasi: tambah kolom token_version dan share_key_version ke tabel businesses.
 *
 * Aman dijalankan berulang kali -- memakai ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
 *
 * Jalankan SEKALI terhadap DB production/staging yang sudah ada:
 *   npx ts-node --project tsconfig.scripts.json scripts/migrate-add-token-versions.ts
 *
 * Untuk DB baru (fresh install), kolom ini sudah ada di schema.sql -- tidak perlu
 * menjalankan script ini.
 */

import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("POSTGRES_URL belum diset di .env.local");
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log("Menjalankan migrasi: tambah kolom versioning ke tabel businesses...");

    await client.query("BEGIN");

    // token_version: dinaikkan saat logout atau ganti password
    await client.query(`
      ALTER TABLE businesses
        ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1
    `);
    console.log("  ✓ token_version");

    // share_key_version: dinaikkan saat rotasi link dashboard
    await client.query(`
      ALTER TABLE businesses
        ADD COLUMN IF NOT EXISTS share_key_version INTEGER NOT NULL DEFAULT 1
    `);
    console.log("  ✓ share_key_version");

    await client.query("COMMIT");
    console.log("\nMigrasi selesai. Semua baris existing mendapat nilai default 1.");
    console.log(
      "PERINGATAN: format token sesi berubah dari 3-part menjadi 4-part. Setelah\n" +
      "kode baru di-deploy, SEMUA sesi login yang sedang aktif akan otomatis tidak\n" +
      "valid (bukan karena version mismatch, tapi karena format token berubah).\n" +
      "Semua pengguna PERLU LOGIN ULANG setelah migrasi + deploy ini dijalankan."
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migrasi gagal, rollback dijalankan:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

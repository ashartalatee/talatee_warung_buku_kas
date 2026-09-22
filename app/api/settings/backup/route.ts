// Copy to: app/api/settings/backup/route.ts
//
// Diproteksi sama seperti /api/products, /api/transactions, dll: wajib
// cookie sesi (jalur default proxy.ts) -- BEDA dari /api/backup yang
// sudah ada (itu wajib X-Api-Key, dipicu n8n scheduler harian). Ini versi
// untuk dipanggil manual dari browser lewat tombol di Settings, memakai
// fungsi runBackup/listBackups yang SAMA PERSIS -- tidak ada logic baru.

import { NextRequest, NextResponse } from "next/server";
import { runBackup, listBackups } from "@/lib/talatee-core/backup";
import { getCurrentUser } from "@/app/api/_lib/session";
import { PLATFORM_ADMIN_SESSION_ID, verifyLocalApiKey } from "@/app/api/_lib/auth";

const BACKUP_DIR = process.env.BACKUP_DIR ?? "./backups";
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? "14");

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // 1. Cek header X-Api-Key jika dipanggil via mesin automasi
  const apiKey = req.headers.get("x-api-key");
  if (verifyLocalApiKey(apiKey)) {
    return true;
  }

  // 2. Cek sesi Platform Admin
  try {
    const user = await getCurrentUser();
    if (user.business_id === PLATFORM_ADMIN_SESSION_ID) {
      return true;
    }
  } catch {
    // Abaikan jika session tidak ada atau gagal
  }

  return false;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Hanya Platform Admin yang bisa akses ini." }, { status: 403 });
  }

  try {
    const backups = listBackups(BACKUP_DIR);
    return NextResponse.json({ backups });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Gagal memuat daftar backup." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Hanya Platform Admin yang bisa akses ini." }, { status: 403 });
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL belum diisi di .env.local." }, { status: 500 });
  }
  try {
    const result = await runBackup(connectionString, BACKUP_DIR, RETENTION_DAYS);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Backup gagal." }, { status: 500 });
  }
}

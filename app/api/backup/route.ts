// POST /api/backup
//
// Dipicu terjadwal oleh n8n -- proxy.ts mewajibkan header X-Api-Key
// (N8N_LOCAL_API_KEY), sama seperti endpoint upload/reports.

import { NextRequest, NextResponse } from "next/server";
import { runBackup, listBackups } from "@/lib/talatee-core/backup";
import { verifyLocalApiKey, PLATFORM_ADMIN_SESSION_ID } from "@/app/api/_lib/auth";
import { getCurrentUser } from "@/app/api/_lib/session";

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // 1. Cek header X-Api-Key untuk automasi mesin (n8n)
  const apiKey = req.headers.get("x-api-key");
  if (verifyLocalApiKey(apiKey)) {
    return true;
  }

  // 2. Cek sesi Platform Admin (Ashar)
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

function getBackupConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL belum diisi di .env.local.");
  }
  const backupDir = process.env.BACKUP_DIR ?? "./backups";
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? "14");
  return { connectionString, backupDir, retentionDays };
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Hanya Platform Admin atau automasi resmi yang bisa akses backup." }, { status: 403 });
  }

  try {
    const { connectionString, backupDir, retentionDays } = getBackupConfig();
    const result = await runBackup(connectionString, backupDir, retentionDays);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Hanya Platform Admin atau automasi resmi yang bisa akses backup." }, { status: 403 });
  }

  const { backupDir } = getBackupConfig();
  return NextResponse.json({ backups: listBackups(backupDir) });
}

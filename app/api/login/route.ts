import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, PLATFORM_ADMIN_SESSION_ID } from "../_lib/auth";
import { verifyPassword } from "@/lib/talatee-core/password";
import { getDb } from "../_lib/db";

// 16 Sept 2026: rate limiting -- 5x gagal berturut-turut per identifier
// (business_id atau Platform Admin) -> terkunci 15 menit. Mencegah
// orang coba tebak password tanpa batas ke 1 link login tertentu.

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

async function checkLock(db: ReturnType<typeof getDb>, identifier: string): Promise<string | null> {
  const row = (await db.get(`SELECT locked_until FROM login_attempts WHERE identifier = $1`, [
    identifier,
  ])) as { locked_until: string | null } | undefined;

  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    return `Terlalu banyak percobaan gagal. Coba lagi dalam ${LOCKOUT_MINUTES} menit.`;
  }
  return null;
}

async function recordFailure(db: ReturnType<typeof getDb>, identifier: string): Promise<void> {
  const row = (await db.get(
    `INSERT INTO login_attempts (identifier, failed_count, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (identifier) DO UPDATE
       SET failed_count = CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN 1
             ELSE login_attempts.failed_count + 1
           END,
           locked_until = CASE
             WHEN login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now() THEN NULL
             ELSE login_attempts.locked_until
           END,
           updated_at = now()
     RETURNING failed_count`,
    [identifier]
  )) as { failed_count: number };

  if (row.failed_count >= MAX_FAILED_ATTEMPTS) {
    await db.run(
      `UPDATE login_attempts SET locked_until = now() + interval '${LOCKOUT_MINUTES} minutes' WHERE identifier = $1`,
      [identifier]
    );
  }
}

async function recordSuccess(db: ReturnType<typeof getDb>, identifier: string): Promise<void> {
  await db.run(
    `UPDATE login_attempts SET failed_count = 0, locked_until = NULL, updated_at = now() WHERE identifier = $1`,
    [identifier]
  );
}

export async function POST(req: NextRequest) {
  let body: { password?: string; business_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid." }, { status: 400 });
  }

  if (!body.password) {
    return NextResponse.json({ error: "Password salah." }, { status: 401 });
  }

  const db = getDb();

  function issueSession(businessId: string, role: "platform" | "owner", tokenVersion: number) {
    const token = createSessionToken(businessId, tokenVersion);
    const res = NextResponse.json({ ok: true, role });
    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
    return res;
  }

  // 1. Jalur Platform Admin: selalu gunakan kunci statis PLATFORM_ADMIN_SESSION_ID
  // terlepas dari ada atau tidaknya business_id di request.
  const platformHash = process.env.PLATFORM_ADMIN_PASSWORD_HASH;
  const adminLockMessage = await checkLock(db, PLATFORM_ADMIN_SESSION_ID);

  if (platformHash && verifyPassword(body.password, platformHash)) {
    if (adminLockMessage) {
      return NextResponse.json({ error: adminLockMessage }, { status: 429 });
    }
    await recordSuccess(db, PLATFORM_ADMIN_SESSION_ID);
    // Platform Admin tidak ada di DB -- token_version selalu 1 (tidak perlu rotasi per-device)
    return issueSession(PLATFORM_ADMIN_SESSION_ID, "platform", 1);
  }

  // 2. Jika tidak ada business_id di request, ini adalah percobaan login Platform Admin yang gagal
  // (karena halaman /login tanpa ?biz= khusus untuk admin).
  // Catat kegagalan ke kunci statis PLATFORM_ADMIN_SESSION_ID.
  if (!body.business_id) {
    if (adminLockMessage) {
      return NextResponse.json({ error: adminLockMessage }, { status: 429 });
    }
    await recordFailure(db, PLATFORM_ADMIN_SESSION_ID);
    return NextResponse.json({ error: "Password salah." }, { status: 401 });
  }

  // 3. Jalur Klien Toko: gunakan business_id spesifik sebagai identifier rate-limiting.
  // Kegagalan klien terisolasi dan tidak pernah mempengaruhi akun Platform Admin.
  const clientIdentifier = body.business_id;
  const clientLockMessage = await checkLock(db, clientIdentifier);
  if (clientLockMessage) {
    return NextResponse.json({ error: clientLockMessage }, { status: 429 });
  }

  const row = (await db.get(
    `SELECT business_id, password_hash, is_active, token_version FROM businesses WHERE business_id = $1 AND password_hash IS NOT NULL`,
    [clientIdentifier]
  )) as { business_id: string; password_hash: string | null; is_active: boolean; token_version: number } | undefined;

  if (!row || !verifyPassword(body.password, row.password_hash)) {
    await recordFailure(db, clientIdentifier);
    return NextResponse.json({ error: "Password salah." }, { status: 401 });
  }

  if (!row.is_active) {
    await recordFailure(db, clientIdentifier);
    return NextResponse.json({ error: "Password salah." }, { status: 401 });
  }

  await recordSuccess(db, clientIdentifier);
  // Sertakan token_version dari DB agar sesi baru langsung cocok dengan versi terkini
  return issueSession(row.business_id, "owner", row.token_version ?? 1);
}

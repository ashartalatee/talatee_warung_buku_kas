import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
  PLATFORM_ADMIN_SESSION_ID,
} from "../_lib/auth";
import { getDb } from "../_lib/db";

export async function POST(req: NextRequest) {
  // Ambil business_id dari cookie yang masih ada (proxy.ts sudah memvalidasi
  // sebelum request ini masuk, jadi kita tahu cookie ini sah).
  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = verifySessionToken(cookie);

  // Naikkan token_version di DB agar SEMUA sesi tenant ini -- di device lain
  // sekalipun -- langsung tidak valid. Sesi Platform Admin tidak ada di DB,
  // cukup hapus cookie-nya saja.
  if (session && session.business_id !== PLATFORM_ADMIN_SESSION_ID) {
    const db = getDb();
    await db.run(
      `UPDATE businesses SET token_version = token_version + 1 WHERE business_id = $1`,
      [session.business_id]
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", { maxAge: 0, path: "/" });
  return res;
}

// GET /api/dashboard-link -- dilindungi session admin (lewat proxy.ts,
// sama seperti route admin lain). Cuma nyusun ulang link yang bisa
// dikirim ke bot WA (/dashboard?key=...) supaya bisa dibuka juga dari
// panel admin tanpa perlu copy-paste manual.
//
// 15 Sept 2026 (multi-tenant): key sekarang dibikin per-business lewat
// createShareKey() (HMAC, lihat auth.ts) -- BUKAN lagi 1 DASHBOARD_SHARE_KEY
// global dari env var.
//
// 22 Sept 2026 (revocable share key): key sekarang menyertakan share_key_version
// dari DB. Pemilik toko bisa merotasi link via POST /api/settings/rotate-share-key;
// link lama (versi lama) langsung ditolak oleh proxy.ts.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/api/_lib/session";
import { createShareKey } from "@/app/api/_lib/auth";
import { getDb } from "@/app/api/_lib/db";

export async function GET() {
  const user = await getCurrentUser();
  const db = getDb();

  const bizRow = (await db.get(
    `SELECT share_key_version FROM businesses WHERE business_id = $1`,
    [user.business_id]
  )) as { share_key_version: number } | undefined;
  const shareKeyVersion = bizRow?.share_key_version ?? 1;

  const key = createShareKey(user.business_id, shareKeyVersion);
  return NextResponse.json({ url: `/dashboard?key=${encodeURIComponent(key)}` });
}

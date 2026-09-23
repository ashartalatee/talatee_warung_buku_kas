// POST /api/settings/rotate-share-key
//
// Menaikkan share_key_version untuk bisnis yang sedang login sehingga
// SEMUA link dashboard lama (/dashboard?key=...) yang sudah terlanjur
// beredar (mis. dikirim ke WhatsApp grup) langsung tidak bisa dibuka --
// tanpa perlu mengubah SESSION_SECRET global atau mempengaruhi tenant lain.
//
// Diproteksi session cookie biasa (proxy.ts, jalur default) -- cukup
// pemilik toko yang login yang bisa rotasi link miliknya sendiri.
// Platform Admin tidak bisa merotasi link orang lain (sudah terisolasi
// oleh business_id dari getCurrentUser()).
//
// Flow di frontend (saran):
//   1. Tampilkan tombol "Rotasi Link Dashboard" dengan konfirmasi dialog.
//   2. POST ke endpoint ini.
//   3. Setelah berhasil, ambil link baru lewat GET /api/dashboard-link
//      dan tampilkan ke user (agar bisa langsung dikirim ulang ke WA).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/api/_lib/session";
import { getDb } from "@/app/api/_lib/db";
import { PLATFORM_ADMIN_SESSION_ID } from "@/app/api/_lib/auth";

export async function POST() {
  const user = await getCurrentUser();

  // Platform Admin tidak punya share key (tidak ada di tabel businesses)
  if (user.business_id === PLATFORM_ADMIN_SESSION_ID) {
    return NextResponse.json(
      { error: "Platform Admin tidak memiliki share key dashboard." },
      { status: 400 }
    );
  }

  const db = getDb();
  const updated = (await db.get(
    `UPDATE businesses
        SET share_key_version = share_key_version + 1
      WHERE business_id = $1
  RETURNING share_key_version`,
    [user.business_id]
  )) as { share_key_version: number } | undefined;

  if (!updated) {
    return NextResponse.json({ error: "Bisnis tidak ditemukan." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    share_key_version: updated.share_key_version,
    message: "Link dashboard lama sudah dinonaktifkan. Ambil link baru via GET /api/dashboard-link.",
  });
}

// Root ("/") -- tujuannya beda tergantung siapa yang login:
//   - Platform Admin (Ashar) -> /ops/clients (kelola semua client)
//   - Business owner (client) -> /dashboard?key=... (omzet mereka)
// SEBELUM INI: selalu ke /dashboard, salah untuk Platform Admin --
// bikin bingung karena kelihatan seperti "dashboard client kosong".

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/app/api/_lib/session";
import { createShareKey } from "@/app/api/_lib/auth";
import { PLATFORM_ADMIN_SESSION_ID } from "@/app/api/_lib/auth";
import { getDb } from "@/app/api/_lib/db";

export default async function Page() {
  const user = await getCurrentUser();

  if (user.business_id === PLATFORM_ADMIN_SESSION_ID) {
    redirect("/ops/clients");
  }

  // Ambil share_key_version dari DB agar share key yang dihasilkan bisa
  // dirotasi (diinvalidasi) kapan pun pemilik toko mau, tanpa perlu ganti
  // SESSION_SECRET global.
  const db = getDb();
  const bizRow = (await db.get(
    `SELECT share_key_version FROM businesses WHERE business_id = $1`,
    [user.business_id]
  )) as { share_key_version: number } | undefined;
  const shareKeyVersion = bizRow?.share_key_version ?? 1;

  const key = createShareKey(user.business_id, shareKeyVersion);
  redirect(`/dashboard?key=${encodeURIComponent(key)}`);
}

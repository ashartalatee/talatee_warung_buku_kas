// Ganti dari middleware.ts -> proxy.ts, karena file konvensi `middleware`
// sudah deprecated di Next.js 16 versi project ini.
//
// 15 Sept 2026 (multi-tenant): proxy SATU-SATUNYA tempat yang menentukan
// business_id per request, diteruskan lewat header x-talatee-business-id.
//
// 16 Sept 2026 (nonaktifkan client): proxy JUGA yang cek is_active di
// sini, SEBELUM request sampai ke halaman/route mana pun -- supaya
// client yang dinonaktifkan langsung diarahkan ke /login dengan pesan
// jelas, bukan macet di "Memuat..." di berpuluh komponen berbeda.
// Sebelumnya pengecekan ini ada di session.ts (dipanggil tiap route
// handler) -- dipindah ke sini supaya cuma 1 tempat, dan hasilnya
// redirect yang rapi, bukan error mentah yang bikin fetch() gagal parse.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  verifySessionToken,
  verifyLocalApiKey,
  verifyShareKey,
  SESSION_COOKIE_NAME,
  PLATFORM_ADMIN_SESSION_ID,
} from "./app/api/_lib/auth";
import { getDb } from "./app/api/_lib/db";

const BUSINESS_ID_HEADER = "x-talatee-business-id";

const N8N_ROUTES = [
  "/api/transactions/upload",
  "/api/reports/daily",
  "/api/reports/weekly",
  "/api/reports/monthly",
  "/api/backup",
];

const SHARE_LINK_ROUTES = ["/dashboard", "/api/reports/overview"];

const PUBLIC_ROUTES = ["/login", "/api/login"];

interface BusinessRecord {
  is_active: boolean;
  token_version: number;
  share_key_version: number;
}

/**
 * Ambil semua kolom validasi bisnis dalam 1 query.
 * Return undefined kalau business_id tidak ditemukan.
 * Platform Admin tidak ada di DB -- return rekaman "selalu valid" secara inline.
 */
async function getBusinessRecord(businessId: string): Promise<BusinessRecord | undefined> {
  if (businessId === PLATFORM_ADMIN_SESSION_ID) {
    return { is_active: true, token_version: 1, share_key_version: 1 };
  }
  const db = getDb();
  return (await db.get(
    `SELECT is_active, token_version, share_key_version
       FROM businesses WHERE business_id = $1`,
    [businessId]
  )) as BusinessRecord | undefined;
}

function invalidShareLinkPage(): NextResponse {
  const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Link tidak valid — Talatee</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f3efe0;color:#2b2a25;padding:24px;
    font-family:'Courier New',Consolas,monospace;}
  .card{max-width:340px;width:100%;background:#fbfaf3;border:1px solid #e6e0c9;
    border-radius:12px;padding:28px 24px;text-align:center;}
  .badge{display:inline-flex;align-items:center;justify-content:center;width:46px;height:46px;
    border-radius:999px;background:#142850;color:#fff;font-size:20px;font-weight:700;margin-bottom:14px;}
  h1{font-size:15px;margin:0 0 8px;color:#142850;}
  p{font-size:12.5px;line-height:1.6;color:#5b5748;margin:0;}
  .foot{margin-top:18px;font-size:9.5px;letter-spacing:.12em;color:#a39c85;text-transform:uppercase;}
</style>
</head>
<body>
  <div class="card">
    <div class="badge">!</div>
    <h1>Link dashboard tidak valid</h1>
    <p>Link ini sudah kadaluarsa atau salah ketik. Minta link dashboard terbaru langsung lewat WhatsApp toko Anda.</p>
    <div class="foot">Talatee Automation Lab</div>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function nextWithBusinessId(request: NextRequest, businessId: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(BUSINESS_ID_HEADER, businessId);
  return NextResponse.next({ request: { headers } });
}

/** Client dinonaktifkan -- hapus cookie sesi lamanya (biar tidak nyangkut)
 * dan arahkan ke /login dengan pesan jelas, bukan biarkan macet. */
function redirectInactive(request: NextRequest): NextResponse {
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("reason", "inactive");
  const res = NextResponse.redirect(loginUrl);
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
}

function jsonInactive(): NextResponse {
  return NextResponse.json(
    { error: "Akun ini sudah tidak aktif. Hubungi Talatee untuk info lebih lanjut." },
    { status: 403 }
  );
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_ROUTES.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  if (SHARE_LINK_ROUTES.some((p) => pathname === p)) {
    const key = request.nextUrl.searchParams.get("key");
    const sharePayload = verifyShareKey(key);
    if (!sharePayload) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Link tidak valid atau kadaluarsa. Minta link terbaru lewat WhatsApp." },
          { status: 401 }
        );
      }
      return invalidShareLinkPage();
    }
    const { business_id: shareBusinessId, share_key_version } = sharePayload;
    const record = await getBusinessRecord(shareBusinessId);
    if (!record || !record.is_active) {
      if (pathname.startsWith("/api/")) return jsonInactive();
      return invalidShareLinkPage();
    }
    // Verifikasi versi share key: kalau tidak cocok, link ini sudah dirotasi
    if (record.share_key_version !== share_key_version) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Link dashboard sudah dirotasi. Minta link terbaru lewat WhatsApp." },
          { status: 401 }
        );
      }
      return invalidShareLinkPage();
    }
    return nextWithBusinessId(request, shareBusinessId);
  }

  if (N8N_ROUTES.some((p) => pathname === p)) {
    const apiKey = request.headers.get("x-api-key");
    if (verifyLocalApiKey(apiKey)) {
      const fallbackBusinessId = process.env.TALATEE_PILOT_BUSINESS_ID;
      if (!fallbackBusinessId) {
        return NextResponse.json(
          { error: "TALATEE_PILOT_BUSINESS_ID belum diset -- wajib untuk jalur n8n/WA." },
          { status: 500 }
        );
      }
      return nextWithBusinessId(request, fallbackBusinessId);
    }

    const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const sessionPayload = verifySessionToken(sessionCookie);
    if (sessionPayload) {
      const { business_id: n8nBusinessId, token_version } = sessionPayload;
      if (pathname === "/api/backup" && n8nBusinessId !== PLATFORM_ADMIN_SESSION_ID) {
        return NextResponse.json({ error: "Hanya Platform Admin yang bisa akses backup." }, { status: 403 });
      }
      const record = await getBusinessRecord(n8nBusinessId);
      if (!record || !record.is_active) return jsonInactive();
      // Verifikasi versi token -- kalau sudah logout/ganti password, tolak
      if (record.token_version !== token_version) {
        return NextResponse.json({ error: "Sesi sudah tidak valid. Silakan login ulang." }, { status: 401 });
      }
      return nextWithBusinessId(request, n8nBusinessId);
    }

    return NextResponse.json(
      {
        error:
          "Butuh salah satu: header X-Api-Key yang valid (untuk n8n, cek N8N_LOCAL_API_KEY di .env.local) atau login admin yang masih aktif.",
      },
      { status: 401 }
    );
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessionPayload = verifySessionToken(sessionCookie);

  if (!sessionPayload) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Belum login. Silakan login lagi." }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const { business_id: businessId, token_version } = sessionPayload;
  const record = await getBusinessRecord(businessId);

  if (!record || !record.is_active) {
    if (pathname.startsWith("/api/")) return jsonInactive();
    return redirectInactive(request);
  }

  // Verifikasi versi token -- sesi yang sudah di-revoke (logout/ganti password)
  // punya versi lebih rendah dari DB, ditolak di sini sebelum sampai ke handler
  if (record.token_version !== token_version) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("reason", "session_revoked");
    const res = pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Sesi sudah tidak valid. Silakan login ulang." }, { status: 401 })
      : NextResponse.redirect(loginUrl);
    res.cookies.delete(SESSION_COOKIE_NAME); // bersihkan cookie lama yang sudah tidak valid
    return res;
  }

  if (pathname.startsWith("/ops") && businessId !== PLATFORM_ADMIN_SESSION_ID) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (pathname.startsWith("/api/settings/backup") && businessId !== PLATFORM_ADMIN_SESSION_ID) {
    return NextResponse.json({ error: "Hanya Platform Admin yang bisa akses backup." }, { status: 403 });
  }

  return nextWithBusinessId(request, businessId);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|csv)$).*)",
  ],
};

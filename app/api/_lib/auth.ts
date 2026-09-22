// Autentikasi sederhana untuk Phase 1 (single-OWNER per instalasi, lihat
// session.ts). BUKAN sistem multi-user — kalau nanti butuh multi-user
// (mode SaaS mandiri), ganti dengan NextAuth/Clerk; file ini & middleware.ts
// yang perlu diganti, route handler lain tidak perlu tahu.
//
// Desainnya sengaja minim dependency (tanpa jsonwebtoken dll) — cukup HMAC
// pakai modul `crypto` bawaan Node, supaya tidak nambah beban install untuk
// pilot yang cuma dipakai 1 pemilik warung per instalasi.

import { createHmac, timingSafeEqual } from "crypto";

const SESSION_COOKIE_NAME = "talatee_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 hari

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET belum diisi di .env.local (atau terlalu pendek, minimal 16 karakter). " +
        "Ini dipakai untuk menandatangani cookie login — WAJIB diisi sebelum aplikasi dipakai."
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

// =============================================================================
// SESSION TOKEN
//
// Format lama (sebelum 22 Sept 2026): "<business_id>.<expires>.<sig>"
// Format baru: "<business_id>.<token_version>.<expires>.<sig>"
//   sig = HMAC("<business_id>.<token_version>.<expires>")
//
// Penambahan token_version memungkinkan invalidasi SEMUA sesi milik 1 tenant
// hanya dengan menaikkan angka ini di DB — tanpa perlu mengganti SESSION_SECRET
// global (yang akan merusak sesi semua tenant sekaligus). Ini dipakai:
//   • saat logout          → token_version += 1 di DB
//   • saat ganti password  → token_version += 1, lalu terbitkan cookie baru
//     dengan versi terbaru (user langsung bisa pakai lagi di tab yang sama;
//     sesi di device lain expire karena versinya sudah tertinggal)
// =============================================================================

/** Payload yang sudah terverifikasi dari cookie sesi. */
export interface SessionTokenPayload {
  business_id: string;
  token_version: number;
}

/**
 * Bikin token sesi baru untuk business_id tertentu, berlaku 30 hari.
 * token_version HARUS diambil dari DB saat ini (kolom businesses.token_version);
 * untuk Platform Admin (tidak ada di DB) selalu gunakan versi 1.
 */
export function createSessionToken(business_id: string, token_version: number): string {
  const expires = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${business_id}.${token_version}.${expires}`;
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

/**
 * Cek token dari cookie. Return { business_id, token_version } kalau
 * tanda tangan & masa berlaku valid, null kalau tidak.
 * CATATAN: fungsi ini hanya memverifikasi HMAC + expiry — pengecekan apakah
 * token_version masih cocok dengan DB ada di proxy.ts (isValidSession),
 * supaya route handler biasa tidak perlu tahu soal versioning.
 */
export function verifySessionToken(token: string | undefined | null): SessionTokenPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  // Format: uuid(tanpa titik) . number . number . hex64
  if (parts.length !== 4) return null;
  const [business_id, tokenVersionStr, expiresStr, sig] = parts;

  const expected = sign(`${business_id}.${tokenVersionStr}.${expiresStr}`);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null; // tanda tangan tidak cocok -> token dipalsukan/rusak
  }

  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || Date.now() > expires) {
    return null; // kedaluwarsa
  }

  const token_version = Number(tokenVersionStr);
  if (!Number.isInteger(token_version) || token_version < 1) {
    return null; // format versi tidak valid
  }

  return { business_id, token_version };
}

export { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS };

/**
 * Cek header X-Api-Key untuk endpoint yang dipanggil MESIN (n8n), bukan
 * browser: /api/transactions/upload, /api/reports/daily, /api/reports/weekly.
 * Pakai key terpisah dari TALATEE_API_KEY (itu punya Talatee, ini punya
 * n8n) supaya masing-masing bisa dirotasi sendiri-sendiri.
 */

// =============================================================================
// SHARE KEY (link dashboard per-tenant yang dikirim lewat WA)
//
// Format lama (sebelum 22 Sept 2026): "<business_id>.<sig>"
//   → deterministik, tidak bisa dicabut tanpa ganti SESSION_SECRET global.
//
// Format baru: "<business_id>.<share_key_version>.<sig>"
//   sig = HMAC("share:<business_id>.<share_key_version>")
//
// Dengan adanya share_key_version, link lama LANGSUNG tidak valid begitu
// pemilik toko menekan "Rotasi Link Dashboard" (POST /api/settings/rotate-share-key)
// — tanpa memengaruhi sesi login maupun tenant lain.
// Verifikasi versi membutuhkan 1 DB read di proxy.ts (isValidShareKey).
// =============================================================================

/** Payload yang sudah terverifikasi dari query-param ?key=. */
export interface ShareKeyPayload {
  business_id: string;
  share_key_version: number;
}

/**
 * Buat share key baru untuk business_id tertentu.
 * share_key_version HARUS diambil dari DB saat ini (kolom businesses.share_key_version).
 */
export function createShareKey(business_id: string, share_key_version: number): string {
  const sig = sign(`share:${business_id}.${share_key_version}`);
  return `${business_id}.${share_key_version}.${sig}`;
}

/**
 * Verifikasi ?key=... dari link dashboard.
 * Return { business_id, share_key_version } kalau HMAC valid, null kalau tidak.
 * Pengecekan apakah versi masih cocok dengan DB ada di proxy.ts (isValidShareKey).
 */
export function verifyShareKey(keyValue: string | null): ShareKeyPayload | null {
  if (!keyValue) return null;
  // Format: uuid . number . hex64  — ketiganya tidak mengandung titik
  const parts = keyValue.split(".");
  if (parts.length !== 3) return null;
  const [business_id, versionStr, sig] = parts;

  const version = Number(versionStr);
  if (!Number.isInteger(version) || version < 1) return null;

  const expected = sign(`share:${business_id}.${version}`);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  return { business_id, share_key_version: version };
}

/**
 * @deprecated Gunakan verifyShareKey() yang baru.
 * Alias ini hanya ada selama masa transisi — hapus setelah semua pemanggil
 * sudah diperbarui.
 */
export function verifyShareKeyAndGetBusinessId(keyValue: string | null): string | null {
  return verifyShareKey(keyValue)?.business_id ?? null;
}

export function verifyLocalApiKey(headerValue: string | null): boolean {
  const expected = process.env.N8N_LOCAL_API_KEY;
  if (!expected || expected.length < 8) {
    // Sengaja fail-closed: kalau env var belum diisi, JANGAN anggap semua
    // request valid — daripada diam-diam tanpa proteksi.
    return false;
  }
  if (!headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Session id khusus buat Platform Admin (Ashar sendiri) -- BUKAN
 * business_id asli mana pun. proxy.ts memakai ini untuk membatasi
 * /ops hanya bisa diakses session ini, bukan session business owner
 * (client) biasa walau sudah login. */
export const PLATFORM_ADMIN_SESSION_ID = "__platform_admin__";
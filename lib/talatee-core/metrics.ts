import { Db } from "./db";
import { getTodayLocalDate } from "./date-utils";
import { getLowStockProducts } from "./products";

// CATATAN PORTING (baca ini sebelum ubah query di file ini):
//
// 1. COUNT(*) di Postgres balik sebagai BIGINT, dan driver `pg` mengembalikan
//    BIGINT sebagai STRING (bukan number JS) untuk menghindari kehilangan
//    presisi di angka sangat besar. Kalau dibiarkan, `row.orders` akan jadi
//    "25" bukan 25, dan `revenue / orders` di bawah akan pecah diam-diam.
//    Makanya SETIAP `COUNT(*)` di file ini di-cast eksplisit `::int` di SQL.
//
// 2. `strftime('%w', ...)` dan `substr(...)` itu fungsi SQLite, tidak ada di
//    Postgres. Diganti EXTRACT(DOW FROM ...::date) dan substring(... from .. for ..).

/** The entire metric contract: only ACTIVE transactions count. */
export async function getDailyMetrics(db: Db, business_id: string, date: string) {
  const row = (await db.get(
    `SELECT COUNT(*)::int as orders, COALESCE(SUM(total_amount), 0) as revenue
       FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date = $2`,
    [business_id, date]
  )) as { orders: number; revenue: number };

  const aov = row.orders > 0 ? round2(row.revenue / row.orders) : 0;
  return { date, orders: row.orders, revenue: round2(row.revenue), aov };
}

/** Ringkasan untuk dashboard admin baru (6 Sept 2026): revenue/orders/items
 * terjual hari ini DAN kemarin (buat badge "vs kemarin"), plus produk aktif
 * dari total & jumlah stok menipis. Item terjual dihitung terpisah dari
 * transaction_lines (bukan di-JOIN bareng agregat transactions) supaya
 * tidak fan-out -- JOIN 1 transaksi bergaris banyak akan menggandakan
 * COUNT/SUM kalau digabung dalam 1 query yang sama. */
export async function getDashboardSummary(db: Db, business_id: string) {
  const today = getTodayLocalDate();
  const yesterday = shiftDate(today, -1);

  async function dayStats(date: string) {
    const txn = (await db.get(
      `SELECT COUNT(*)::int as orders, COALESCE(SUM(total_amount), 0) as revenue
         FROM transactions
        WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date = $2`,
      [business_id, date]
    )) as { orders: number; revenue: number };

    const items = (await db.get(
      `SELECT COALESCE(SUM(tl.quantity), 0) as qty
         FROM transaction_lines tl
         JOIN transactions t ON t.row_id = tl.transaction_row_id
        WHERE t.business_id = $1 AND t.status = 'ACTIVE' AND t.deleted_at IS NULL AND t.transaction_date = $2`,
      [business_id, date]
    )) as { qty: number };

    return { orders: txn.orders, revenue: round2(txn.revenue), items_sold: round2(items.qty) };
  }

  const [todayStats, yesterdayStats] = await Promise.all([dayStats(today), dayStats(yesterday)]);

  // null = "tidak masuk akal dihitung persen" (kemarin 0, jadi bukan
  // "naik sekian %" -- itu klaim palsu kalau dipaksakan jadi angka).
  function pctChange(curr: number, prev: number): number | null {
    if (prev === 0) return curr === 0 ? 0 : null;
    return round2(((curr - prev) / prev) * 100);
  }

  const productCounts = (await db.get(
    `SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE is_active)::int as active
       FROM products WHERE business_id = $1`,
    [business_id]
  )) as { total: number; active: number };

  const lowStock = await getLowStockProducts(db, business_id);

  return {
    date: today,
    today: {
      ...todayStats,
      aov: todayStats.orders > 0 ? round2(todayStats.revenue / todayStats.orders) : 0,
    },
    vs_yesterday: {
      revenue_pct: pctChange(todayStats.revenue, yesterdayStats.revenue),
      orders_pct: pctChange(todayStats.orders, yesterdayStats.orders),
      items_sold_pct: pctChange(todayStats.items_sold, yesterdayStats.items_sold),
    },
    products: { active: productCounts.active, total: productCounts.total },
    low_stock_count: lowStock.length,
  };
}

export async function getNeedsReviewQueue(db: Db, business_id: string) {
  return db.all(
    `SELECT row_id, transaction_date, transaction_time, total_amount, validation_notes, created_at
       FROM transactions
       WHERE business_id = $1 AND status = 'NEEDS_REVIEW' AND deleted_at IS NULL
       ORDER BY created_at ASC`,
    [business_id]
  );
}

export async function getPendingDuplicateFlags(db: Db, business_id: string) {
  return db.all(
    // created_at ditambahkan (7 Sept 2026) supaya feed aktivitas admin
    // (RecentActivityFeed) bisa mengurutkan flag duplikat bareng dengan
    // kejadian lain (upload, needs-review) berdasarkan waktu asli, bukan
    // dikira-kira. Kolomnya sudah ada dari awal di schema.sql, cuma belum
    // pernah di-SELECT di sini.
    //
    // NOT EXISTS ... deleted_at IS NOT NULL (7 Sept 2026, fitur Sampah):
    // kalau salah satu sisi transaksi yang dibandingkan sudah dibuang ke
    // Sampah, flag-nya ikut disembunyikan -- tidak masuk akal menyuruh
    // user "selesaikan duplikat" untuk transaksi yang sudah tidak ada di
    // tampilan mana pun.
    `SELECT df.flag_id, df.transaction_row_id, df.candidate_row_id, df.match_score, df.matched_fields, df.created_at
       FROM duplicate_flags df
       WHERE df.business_id = $1 AND df.resolution_status = 'PENDING'
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.row_id IN (df.transaction_row_id, df.candidate_row_id) AND t.deleted_at IS NOT NULL
         )`,
    [business_id]
  );
}

/** Full lineage: metric -> transaction -> line items -> source file. */
export async function getLineage(db: Db, row_id: string, business_id: string) {
  const txn = await db.get(`SELECT * FROM transactions WHERE row_id = $1 AND business_id = $2`, [row_id, business_id]);
  if (!txn) {
    return { transaction: undefined, lines: [], source: undefined };
  }
  const lines = await db.all(`SELECT * FROM transaction_lines WHERE transaction_row_id = $1`, [row_id]);
  const source = await db.get(
    `SELECT s.* FROM sources s JOIN transactions t ON t.source_id = s.source_id WHERE t.row_id = $1 AND t.business_id = $2`,
    [row_id, business_id]
  );
  return { transaction: txn, lines, source };
}

export async function getVersionHistory(db: Db, transaction_id: string, business_id: string) {
  return db.all(
    `SELECT version, status, total_amount, created_at, resolved_at
       FROM transactions
       WHERE transaction_id = $1 AND business_id = $2 AND deleted_at IS NULL
       ORDER BY version ASC`,
    [transaction_id, business_id]
  );
}

/** Transactions page listing: current-state view — one row per
 * transaction_id, showing whichever version is "now true" (ACTIVE) or,
 * if voided, the VOID row itself. SUPERSEDED rows are intentionally
 * excluded here (they only surface via version history / lineage),
 * so the list always matches what the metrics actually count.
 * deleted_at IS NULL (7 Sept 2026, fitur Sampah): baris yang sudah dibuang
 * ke Sampah tidak boleh muncul di sini -- lihat halaman /trash untuk
 * lihat/pulihkan baris yang dibuang.
 *
 * 15 Sept 2026: tambah filter source_id opsional -- dipakai halaman
 * "Lihat Detail" per file di Data Inbox (lihat DataInboxList.tsx),
 * supaya bisa lihat transaksi dari 1 batch upload tertentu saja, bukan
 * cuma per tanggal. Kedua filter independen, bisa dipakai sendiri-sendiri
 * atau bareng. */
export async function listTransactions(
  db: Db,
  business_id: string,
  date?: string,
  source_id?: string
) {
  const params: string[] = [business_id];
  const conditions: string[] = [];

  if (date) {
    params.push(date);
    conditions.push(`AND transaction_date = $${params.length}`);
  }
  if (source_id) {
    params.push(source_id);
    conditions.push(`AND source_id = $${params.length}`);
  }

  return db.all(
    `SELECT row_id, transaction_id, version, transaction_date, transaction_time,
              total_amount, line_item_count, status, channel, created_at, resolved_at
       FROM transactions
       WHERE business_id = $1 AND status IN ('ACTIVE', 'NEEDS_REVIEW', 'VOID') AND deleted_at IS NULL ${conditions.join(" ")}
       ORDER BY transaction_date DESC, transaction_time DESC`,
    params
  );
}

/** Whether a transaction currently has any correction history — used by
 * the UI to decide whether to show a "Dikoreksi" badge + "Lihat riwayat". */
export async function hasCorrectionHistory(db: Db, transaction_id: string): Promise<boolean> {
  const row = (await db.get(
    `SELECT COUNT(*)::int as n FROM transaction_events WHERE transaction_id = $1 AND event_type = 'CORRECTION'`,
    [transaction_id]
  )) as { n: number };
  return row.n > 0;
}

/** Data Inbox: recent file uploads with their processing status — the
 * answer to "did my file get in?" per SPEC.md §8. Failed uploads never
 * disappear; they stay here with a reason, ready for re-upload.
 * deleted_at IS NULL (7 Sept 2026): batch yang dibuang ke Sampah hilang
 * dari sini, munculnya di halaman /trash. */
export async function getDataInbox(db: Db, business_id: string, limit = 20) {
  return db.all(
    `SELECT source_id, original_filename, status, failure_reason,
              row_count, processed_row_count, uploaded_at
       FROM sources
       WHERE business_id = $1 AND deleted_at IS NULL
       ORDER BY uploaded_at DESC
       LIMIT $2`,
    [business_id, limit]
  );
}

/** Sampah -- daftar transaksi yang sudah dibuang (deleted_at terisi),
 * terbaru dulu. Dipakai halaman /trash, TIDAK dipakai di tempat lain. */
export async function listTrashTransactions(db: Db, business_id: string) {
  return db.all(
    `SELECT row_id, transaction_id, transaction_date, transaction_time,
              total_amount, status, deleted_at, deleted_by
       FROM transactions
       WHERE business_id = $1 AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    [business_id]
  );
}

/** Sampah -- daftar batch upload yang sudah dibuang, plus berapa transaksi
 * yang ikut terbuang bareng batch-nya (dihitung dari transactions yang
 * source_id-nya sama DAN deleted_at-nya sama -- pendekatan sederhana,
 * lihat catatan di restoreSource() untuk alasan kenapa ini cukup). */
export async function listTrashSources(db: Db, business_id: string) {
  return db.all(
    `SELECT s.source_id, s.original_filename, s.uploaded_at, s.deleted_at, s.deleted_by,
              (SELECT COUNT(*)::int FROM transactions t
                WHERE t.source_id = s.source_id AND t.deleted_at IS NOT NULL) as trashed_transaction_count
       FROM sources s
       WHERE s.business_id = $1 AND s.deleted_at IS NOT NULL
       ORDER BY s.deleted_at DESC`,
    [business_id]
  );
}

/** Top products by quantity sold (ACTIVE transactions only), for a given
 * date or date range. Matches the response shape the old n8n workflow's
 * "Susun Jawaban Teks" node already expects: [{produk, qty_terjual}]. */
async function getTopProducts(db: Db, business_id: string, dateFrom: string, dateTo: string, limit = 3) {
  const rows = (await db.all(
    `SELECT tl.product_or_service AS produk, SUM(tl.quantity) AS qty_terjual
       FROM transaction_lines tl
       JOIN transactions t ON t.row_id = tl.transaction_row_id
       WHERE t.business_id = $1 AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
         AND t.transaction_date BETWEEN $2 AND $3
       GROUP BY tl.product_or_service
       ORDER BY qty_terjual DESC
       LIMIT $4`,
    [business_id, dateFrom, dateTo, limit]
  )) as { produk: string; qty_terjual: number }[];
  return rows.map((r) => ({ produk: r.produk, qty_terjual: Math.round(r.qty_terjual) }));
}

/** Daily report — same response shape as the old Python API's
 * `laporan-harian` (tanggal, total_revenue, total_orders, aov, top_produk)
 * so existing n8n WhatsApp-QA logic can point here with only a URL change. */
export async function getDailyReport(db: Db, business_id: string, date: string) {
  const m = await getDailyMetrics(db, business_id, date);
  return {
    tanggal: date,
    total_revenue: m.revenue,
    total_orders: m.orders,
    aov: m.aov,
    top_produk: await getTopProducts(db, business_id, date, date, 3),
  };
}

/** Weekly report — trailing 7 days ending on the latest ACTIVE transaction
 * date (falls back to today if there's no data yet), matching the old
 * `laporan-mingguan` shape (periode, total_revenue, total_orders, aov,
 * top_produk). */
export async function getWeeklyReport(db: Db, business_id: string) {
  const latest = (await db.get(
    `SELECT MAX(transaction_date) as d FROM transactions WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [business_id]
  )) as { d: string | null };
  const dateTo = latest.d ?? getTodayLocalDate();
  const dateFrom = shiftDate(dateTo, -6);

  const row = (await db.get(
    `SELECT COUNT(*)::int as orders, COALESCE(SUM(total_amount), 0) as revenue
       FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3`,
    [business_id, dateFrom, dateTo]
  )) as { orders: number; revenue: number };

  const aov = row.orders > 0 ? round2(row.revenue / row.orders) : 0;

  return {
    periode: `${dateFrom} s/d ${dateTo}`,
    total_revenue: round2(row.revenue),
    total_orders: row.orders,
    aov,
    top_produk: await getTopProducts(db, business_id, dateFrom, dateTo, 3),
  };
}

/** Monthly report — kalender bulan penuh (tanggal 1 s/d akhir bulan), BUKAN
 * trailing-30-hari, supaya cocok dengan cara pemilik warung mikir ("laporan
 * Agustus"). Default ke BULAN KALENDER SEBELUMNYA kalau year/month tidak
 * diisi -- soalnya kalau ini dikirim otomatis tanggal 1 tiap bulan (lihat
 * TODO_N8N.md), "bulan ini" baru punya 0-1 hari data, jadi tidak berguna
 * kalau default-nya bulan berjalan. year/month tetap bisa diisi manual untuk
 * query bulan tertentu (dipakai app/api/reports/monthly/route.ts). */
export async function getMonthlyReport(db: Db, business_id: string, year?: number, month?: number) {
  let y = year;
  let m = month; // 1-12
  if (!y || !m) {
    const [ty, tm] = getTodayLocalDate().split("-").map(Number);
    m = tm - 1;
    y = ty;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }

  const mm = String(m).padStart(2, "0");
  const dateFrom = `${y}-${mm}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // hari-0 bulan berikutnya = hari terakhir bulan ini
  const dateTo = `${y}-${mm}-${String(lastDay).padStart(2, "0")}`;

  const row = (await db.get(
    `SELECT COUNT(*)::int as orders, COALESCE(SUM(total_amount), 0) as revenue
       FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3`,
    [business_id, dateFrom, dateTo]
  )) as { orders: number; revenue: number };

  const aov = row.orders > 0 ? round2(row.revenue / row.orders) : 0;

  return {
    periode: `${dateFrom} s/d ${dateTo}`,
    total_revenue: round2(row.revenue),
    total_orders: row.orders,
    aov,
    top_produk: await getTopProducts(db, business_id, dateFrom, dateTo, 5),
  };
}

/** Tren pendapatan harian untuk `days` hari terakhir (default 14), rapat
 * sampai tanggal terbaru yang punya data ACTIVE (bukan selalu "hari ini",
 * supaya grafik tidak berakhir di angka 0 kalau belum ada transaksi hari
 * ini). Tanggal yang tidak punya transaksi tetap muncul dengan revenue: 0
 * (zero-filled) supaya barnya tidak bolong di grafik. */
export async function getDailyTrend(db: Db, business_id: string, days = 14) {
  const latest = (await db.get(
    `SELECT MAX(transaction_date) as d FROM transactions WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [business_id]
  )) as { d: string | null };
  const dateTo = latest.d ?? getTodayLocalDate();
  const dateFrom = shiftDate(dateTo, -(days - 1));

  const rows = (await db.all(
    `SELECT transaction_date as date, COALESCE(SUM(total_amount), 0) as revenue,
              COUNT(*)::int as orders
       FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3
       GROUP BY transaction_date`,
    [business_id, dateFrom, dateTo]
  )) as { date: string; revenue: number; orders: number }[];

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: { date: string; revenue: number; orders: number }[] = [];
  for (let i = 0; i < days; i++) {
    const date = shiftDate(dateFrom, i);
    const found = byDate.get(date);
    out.push({ date, revenue: found ? round2(found.revenue) : 0, orders: found?.orders ?? 0 });
  }
  return out;
}

/** Sama seperti getTopProducts (private), tapi diekspor supaya bisa dipakai
 * untuk rentang custom (mis. 14 hari) di luar laporan harian/mingguan. */
export async function getTopProductsInRange(
  db: Db,
  business_id: string,
  dateFrom: string,
  dateTo: string,
  limit = 5
) {
  return getTopProducts(db, business_id, dateFrom, dateTo, limit);
}

/** "Catatan toko": hari dan jam paling ramai (berdasarkan jumlah transaksi)
 * dalam `days` hari terakhir. Return null kalau data terlalu sedikit untuk
 * disimpulkan (< 5 transaksi) -- supaya UI tidak menampilkan insight palsu
 * dari 1-2 data point saja. */
export async function getBusiestSlot(db: Db, business_id: string, days = 14) {
  const latest = (await db.get(
    `SELECT MAX(transaction_date) as d FROM transactions WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [business_id]
  )) as { d: string | null };
  if (!latest.d) return null;
  const dateTo = latest.d;
  const dateFrom = shiftDate(dateTo, -(days - 1));

  const totalRow = (await db.get(
    `SELECT COUNT(*)::int as n FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3`,
    [business_id, dateFrom, dateTo]
  )) as { n: number };
  if (totalRow.n < 5) return null;

  // EXTRACT(DOW ...): 0=Minggu, 1=Senin, ... 6=Sabtu -- sama persis dengan
  // konvensi strftime('%w') di SQLite, jadi tabel HARI di bawah tetap valid.
  const dayRow = (await db.get(
    `SELECT EXTRACT(DOW FROM transaction_date::date)::int as dow, COUNT(*)::int as n
       FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3
       GROUP BY dow ORDER BY n DESC LIMIT 1`,
    [business_id, dateFrom, dateTo]
  )) as { dow: number; n: number } | undefined;

  const hourRow = (await db.get(
    `SELECT substring(transaction_time from 1 for 2) as hour, COUNT(*)::int as n
       FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL AND transaction_date BETWEEN $2 AND $3
         AND transaction_time IS NOT NULL
       GROUP BY hour ORDER BY n DESC LIMIT 1`,
    [business_id, dateFrom, dateTo]
  )) as { hour: string; n: number } | undefined;

  if (!dayRow) return null;
  const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const hourNum = hourRow ? Number(hourRow.hour) : null;

  return {
    day: HARI[dayRow.dow],
    hour_start: hourNum !== null ? `${String(hourNum).padStart(2, "0")}:00` : null,
    hour_end: hourNum !== null ? `${String((hourNum + 1) % 24).padStart(2, "0")}:00` : null,
  };
}

/** Ringkasan omzet 4 periode (hari ini/minggu ini/bulan ini/tahun ini),
 * semua "TO DATE" (dari awal periode kalender sampai HARI INI), bukan
 * "trailing N hari" seperti getWeeklyReport, dan bukan "bulan kemarin"
 * seperti default getMonthlyReport -- dipakai khusus untuk hero omzet di
 * paling atas Overview (7 Sept 2026), yang tujuannya menjawab "progress
 * gue SEKARANG gimana", bukan laporan retrospektif. Minggu dihitung mulai
 * Senin (konvensi Indonesia), bulan mulai tanggal 1, tahun mulai 1
 * Januari -- semua menurut kalender WIB (getTodayLocalDate()).
 *
 * `data_since` = tanggal transaksi ACTIVE paling awal (null kalau belum
 * ada sama sekali) -- dipakai UI untuk kasih keterangan jujur kalau kartu
 * "Tahun Ini" datanya baru berjalan sebagian (mis. baru mulai pakai
 * sistem bulan lalu), bukan pura-pura itu angka setahun penuh. */
/** Awal triwulan (Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Okt-Des) yang
 * memuat tanggal `dateStr`. Dipakai untuk kartu "Triwulan Ini" (12 Sept
 * 2026, diskusi soal penyajian angka di dashboard publik client). */
function startOfQuarter(dateStr: string): string {
  const month = Number(dateStr.slice(5, 7));
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return `${dateStr.slice(0, 4)}-${String(quarterStartMonth).padStart(2, "0")}-01`;
}

/** Nomor triwulan 1-4 untuk ditampilkan di label ("Triwulan 3 2026"). */
function quarterNumber(dateStr: string): number {
  return Math.floor((Number(dateStr.slice(5, 7)) - 1) / 3) + 1;
}

export async function getRevenueSummaryPeriods(db: Db, business_id: string) {
  const today = getTodayLocalDate();
  const weekStart = startOfWeek(today);
  const monthStart = today.slice(0, 7) + "-01";
  const quarterStart = startOfQuarter(today);
  const yearStart = today.slice(0, 4) + "-01-01";

  async function sumRange(dateFrom: string, dateTo: string) {
    const row = (await db.get(
      `SELECT COUNT(*)::int as orders, COALESCE(SUM(total_amount), 0) as revenue
         FROM transactions
        WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
          AND transaction_date BETWEEN $2 AND $3`,
      [business_id, dateFrom, dateTo]
    )) as { orders: number; revenue: number };
    return { revenue: round2(row.revenue), orders: row.orders };
  }

  const earliest = (await db.get(
    `SELECT MIN(transaction_date) as d FROM transactions
       WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
    [business_id]
  )) as { d: string | null };

  const [day, week, month, quarter, year] = await Promise.all([
    sumRange(today, today),
    sumRange(weekStart, today),
    sumRange(monthStart, today),
    sumRange(quarterStart, today),
    sumRange(yearStart, today),
  ]);

  // Perbandingan periode -- "Minggu Ini" dibandingkan ke minggu lalu DI
  // RENTANG HARI YANG SAMA (kalau sekarang baru hari ke-5 minggu ini,
  // dibandingkan ke hari ke-1 s/d ke-5 minggu lalu, BUKAN seminggu penuh)
  // supaya perbandingannya adil -- bukan cuma "angka besar vs kecil"
  // karena minggu lalu memang sudah selesai sementara minggu ini belum.
  // Sama logikanya untuk "Bulan Ini".
  const daysIntoWeek = Math.round(
    (new Date(today + "T00:00:00Z").getTime() - new Date(weekStart + "T00:00:00Z").getTime()) / 86400000
  ) + 1;
  const prevWeekStart = shiftDate(weekStart, -7);
  const prevWeekEnd = shiftDate(prevWeekStart, daysIntoWeek - 1);
  const weekPrevious = await sumRange(prevWeekStart, prevWeekEnd);

  const dayOfMonth = Number(today.slice(8, 10));
  const [prevMonthYear, prevMonthNum] = (() => {
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    return m === 1 ? [y - 1, 12] : [y, m - 1];
  })();
  const daysInPrevMonth = new Date(Date.UTC(prevMonthYear, prevMonthNum, 0)).getUTCDate();
  const cappedDay = Math.min(dayOfMonth, daysInPrevMonth);
  const prevMonthStart = `${prevMonthYear}-${String(prevMonthNum).padStart(2, "0")}-01`;
  const prevMonthEnd = `${prevMonthYear}-${String(prevMonthNum).padStart(2, "0")}-${String(cappedDay).padStart(2, "0")}`;
  const monthPrevious = await sumRange(prevMonthStart, prevMonthEnd);

  return {
    date: today,
    day,
    week,
    week_previous: weekPrevious,
    month,
    month_previous: monthPrevious,
    quarter: { ...quarter, number: quarterNumber(today) },
    year,
    data_since: earliest.d,
  };
}

/** Omzet dipecah per channel (Shopee/TikTok Shop/Lazada/WhatsApp/dst) untuk
 * 1 periode -- dipakai kartu "Omzet per Channel" di Overview (8 Sept 2026,
 * hasil diskusi soal client multi-channel). Diurutkan dari omzet terbesar.
 * `total` = jumlah semua channel, disediakan langsung (bukan cuma dihitung
 * di frontend) supaya tidak ada 2 sumber angka yang bisa beda kalau salah
 * satu berubah rumus pembulatannya. */
export async function getRevenueByChannel(db: Db, business_id: string, dateFrom: string, dateTo: string) {
  const rows = (await db.all(
    `SELECT channel, COUNT(*)::int as orders, COALESCE(SUM(total_amount), 0) as revenue
       FROM transactions
      WHERE business_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL
        AND transaction_date BETWEEN $2 AND $3
      GROUP BY channel
      ORDER BY revenue DESC`,
    [business_id, dateFrom, dateTo]
  )) as { channel: string; orders: number; revenue: number }[];

  const channels = rows.map((r) => ({ channel: r.channel, orders: r.orders, revenue: round2(r.revenue) }));
  const total = round2(channels.reduce((sum, c) => sum + c.revenue, 0));

  return { channels, total };
}

/** Batas tanggal "to date" untuk 1 periode (hari ini s/d hari ini, minggu
 * berjalan s/d hari ini, dst) -- logic yang sama dipakai getRevenueSummaryPeriods
 * di atas, diekspos terpisah supaya endpoint lain (revenue-by-channel) bisa
 * pakai definisi periode yang SAMA PERSIS, bukan menghitung ulang dengan
 * kemungkinan beda pembulatan/hari mulai minggu. */
export function getPeriodBounds(
  period: "day" | "week" | "month" | "quarter" | "year"
): { dateFrom: string; dateTo: string } {
  const today = getTodayLocalDate();
  if (period === "day") return { dateFrom: today, dateTo: today };
  if (period === "week") return { dateFrom: startOfWeek(today), dateTo: today };
  if (period === "month") return { dateFrom: today.slice(0, 7) + "-01", dateTo: today };
  if (period === "quarter") return { dateFrom: startOfQuarter(today), dateTo: today };
  return { dateFrom: today.slice(0, 4) + "-01-01", dateTo: today };
}

function startOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Minggu, 1=Senin, ... 6=Sabtu
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
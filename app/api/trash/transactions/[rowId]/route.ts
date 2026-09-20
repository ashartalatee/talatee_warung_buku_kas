// Copy to: app/api/trash/transactions/[rowId]/route.ts
// DELETE /api/trash/transactions/{rowId} -- hapus transaksi PERMANEN.
// SENGAJA rute terpisah dari /api/transactions/{rowId}/delete (yang cuma
// soft-delete) -- hard delete cuma boleh dipanggil dari halaman Sampah,
// dan hanya berhasil kalau baris ini memang sudah di Sampah (dijaga di
// hardDeleteTransaction() sendiri, bukan cuma di sini).

import { NextRequest, NextResponse } from "next/server";
import { hardDeleteTransaction, DeletionBlockedError, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await hardDeleteTransaction(db, rowId, user.business_id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DeletionBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

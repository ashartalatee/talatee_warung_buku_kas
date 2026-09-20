// Copy to: app/api/transactions/[rowId]/delete/route.ts
// POST /api/transactions/{rowId}/delete -- hapus 1 transaksi ke Sampah
// (reversibel). Untuk hapus PERMANEN, lihat DELETE /api/trash/transactions/{rowId}.

import { NextRequest, NextResponse } from "next/server";
import { softDeleteTransaction, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await softDeleteTransaction(db, rowId, user.business_id, user.user_identifier);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

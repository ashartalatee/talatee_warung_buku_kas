// Copy to: app/api/transactions/[rowId]/lineage/route.ts
// Backs the "Lihat riwayat" / lineage view.

import { NextRequest, NextResponse } from "next/server";
import { getLineage, getVersionHistory } from "@/lib/talatee-core/metrics";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function GET(req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const user = await getCurrentUser();
  const db = getDb();
  const lineage = await getLineage(db, rowId, user.business_id);

  if (!lineage.transaction) {
    return NextResponse.json({ error: "Transaksi tidak ditemukan." }, { status: 404 });
  }

  const transaction_id = (lineage.transaction as any).transaction_id;
  const history = await getVersionHistory(db, transaction_id, user.business_id);

  return NextResponse.json({ ...lineage, version_history: history });
}

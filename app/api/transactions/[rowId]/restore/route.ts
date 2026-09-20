// Copy to: app/api/transactions/[rowId]/restore/route.ts
// POST /api/transactions/{rowId}/restore -- pulihkan 1 transaksi dari Sampah.

import { NextRequest, NextResponse } from "next/server";
import { restoreTransaction, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await restoreTransaction(db, rowId, user.business_id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

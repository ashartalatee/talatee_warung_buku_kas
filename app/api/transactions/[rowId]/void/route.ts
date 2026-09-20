// Copy to: app/api/transactions/[rowId]/void/route.ts
//
// Also backs "Tandai Duplikat" when reason = "Duplikat".

import { NextRequest, NextResponse } from "next/server";
import { voidTransaction, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";
import { CorrectionReason } from "@/lib/talatee-core/types";

export async function POST(req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const body = await req.json();
  const user = await getCurrentUser();
  const db = getDb();

  const reason: CorrectionReason = body.reason ?? "Transaksi dibatalkan";

  try {
    const result = await voidTransaction(db, rowId, user.business_id, reason, body.reason_detail ?? null, user.user_identifier);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

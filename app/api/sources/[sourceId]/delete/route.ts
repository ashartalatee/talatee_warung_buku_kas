// Copy to: app/api/sources/[sourceId]/delete/route.ts
// POST /api/sources/{sourceId}/delete -- hapus 1 batch upload (+ semua
// transaksinya) ke Sampah sekaligus. Reversibel lewat /restore.

import { NextRequest, NextResponse } from "next/server";
import { softDeleteSource, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await softDeleteSource(db, sourceId, user.business_id, user.user_identifier);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

// Copy to: app/api/sources/[sourceId]/restore/route.ts
// POST /api/sources/{sourceId}/restore -- pulihkan 1 batch upload (+ semua
// transaksinya yang sedang di Sampah) dari Sampah.

import { NextRequest, NextResponse } from "next/server";
import { restoreSource, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await restoreSource(db, sourceId, user.business_id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

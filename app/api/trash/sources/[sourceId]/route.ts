// Copy to: app/api/trash/sources/[sourceId]/route.ts
// DELETE /api/trash/sources/{sourceId} -- hapus 1 batch upload (+ semua
// transaksinya) PERMANEN. Sama seperti /api/trash/transactions/{rowId}:
// cuma bisa dipanggil kalau source-nya sudah di Sampah.

import { NextRequest, NextResponse } from "next/server";
import { hardDeleteSource, DeletionBlockedError, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await hardDeleteSource(db, sourceId, user.business_id);
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

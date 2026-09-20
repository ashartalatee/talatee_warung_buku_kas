// Copy to: app/api/transactions/[rowId]/correction/route.ts
//
// Corrects an ACTIVE transaction — creates a new version, old version
// -> SUPERSEDED. Concurrent-correction conflicts return 409.

import { NextRequest, NextResponse } from "next/server";
import { createCorrection, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";
import { CorrectionReason } from "@/lib/talatee-core/types";

const VALID_REASONS: CorrectionReason[] = [
  "Salah input",
  "OCR salah membaca",
  "Duplikat",
  "Transaksi dibatalkan",
  "Harga salah",
  "Qty salah",
  "Tanggal salah",
  "Lainnya",
];

export async function POST(req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const body = await req.json();
  const user = await getCurrentUser();
  const db = getDb();

  if (!VALID_REASONS.includes(body.reason)) {
    return NextResponse.json(
      { error: `reason harus salah satu dari: ${VALID_REASONS.join(", ")}` },
      { status: 400 }
    );
  }
  if (body.reason === "Lainnya" && !body.reason_detail) {
    return NextResponse.json(
      { error: "reason_detail wajib diisi ketika reason = 'Lainnya'." },
      { status: 400 }
    );
  }

  try {
    const result = await createCorrection(
      db,
      rowId,
      user.business_id,
      { total_amount: body.total_amount },
      body.reason,
      body.reason_detail ?? null,
      user.user_identifier
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

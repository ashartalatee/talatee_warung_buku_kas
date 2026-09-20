// Copy to: app/api/needs-review/[rowId]/resolve/route.ts
//
// Resolves a NEEDS_REVIEW transaction IN PLACE (per flows/02 and
// SPEC.md §6 — this is deliberately NOT a correction). Refuses to run
// against a row that isn't NEEDS_REVIEW.

import { NextRequest, NextResponse } from "next/server";
import { resolveNeedsReview, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  const { rowId } = await params;
  const body = await req.json();
  const user = await getCurrentUser();
  const db = getDb();

  try {
    const result = await resolveNeedsReview(
      db,
      rowId,
      user.business_id,
      {
        total_amount: body.total_amount,
        transaction_date: body.transaction_date,
        transaction_time: body.transaction_time,
      },
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

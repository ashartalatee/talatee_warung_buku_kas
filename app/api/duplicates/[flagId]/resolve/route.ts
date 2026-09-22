// Copy to: app/api/duplicates/[flagId]/resolve/route.ts
//
// Body: { resolution: "CONFIRMED_DUPLICATE" | "CONFIRMED_NEW" }
//
// This only records the human decision on the flag. If the resolution
// is CONFIRMED_DUPLICATE, the client should follow up with a call to
// POST /api/transactions/{rowId}/void (reason: "Duplikat") on whichever
// of the two transactions the user picked to remove — this endpoint
// deliberately does not decide that automatically.

import { NextRequest, NextResponse } from "next/server";
import { resolveDuplicateFlag, LifecycleError } from "@/lib/talatee-core/lifecycle";
import { getDb } from "@/app/api/_lib/db";
import { getCurrentUser } from "@/app/api/_lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ flagId: string }> }) {
  const { flagId } = await params;
  const body = await req.json();
  const user = await getCurrentUser();
  const db = getDb();

  if (!["CONFIRMED_DUPLICATE", "CONFIRMED_NEW"].includes(body.resolution)) {
    return NextResponse.json(
      { error: "resolution harus 'CONFIRMED_DUPLICATE' atau 'CONFIRMED_NEW'." },
      { status: 400 }
    );
  }

  try {
    const result = await resolveDuplicateFlag(db, flagId, user.business_id, body.resolution, user.user_identifier);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

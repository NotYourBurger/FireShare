import { NextResponse } from "next/server";
import { currentQuote } from "@/app/current-quote";
import { pickRandomBackdrop } from "@/app/quote";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { quote: currentQuote(), backdrop: pickRandomBackdrop() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

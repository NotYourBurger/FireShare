import { NextResponse } from "next/server";
import { fetchRandomQuote, pickRandomBackdrop } from "@/app/quote";

export const dynamic = "force-dynamic";

export async function GET() {
  const [quote, backdrop] = await Promise.all([fetchRandomQuote(), Promise.resolve(pickRandomBackdrop())]);
  return NextResponse.json(
    { quote, backdrop },
    { headers: { "Cache-Control": "no-store" } },
  );
}

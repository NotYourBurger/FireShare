import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return (await getApp()).finalize(req, (await params).id);
}

import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return (await getApp()).download(req, (await params).token);
}

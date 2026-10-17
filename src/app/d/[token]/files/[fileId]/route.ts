import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string; fileId: string }> };

export async function GET(req: Request, { params }: Context) {
  const { token, fileId } = await params;
  return (await getApp()).download(req, token, fileId);
}

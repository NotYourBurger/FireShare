import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Context) {
  const { token } = await params;
  return (await getApp()).downloadAll(req, token);
}

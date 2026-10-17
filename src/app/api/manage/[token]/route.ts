import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Context) {
  return (await getApp()).getManaged(req, (await params).token);
}

export async function DELETE(req: Request, { params }: Context) {
  return (await getApp()).deleteManaged(req, (await params).token);
}

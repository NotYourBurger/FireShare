import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function OPTIONS() {
  return (await getApp()).optionsUpload();
}

export async function GET(req: Request, { params }: Context) {
  return (await getApp()).getUpload(req, (await params).id);
}

export async function HEAD(req: Request, { params }: Context) {
  return (await getApp()).headUpload(req, (await params).id);
}

export async function PATCH(req: Request, { params }: Context) {
  return (await getApp()).patchUpload(req, (await params).id);
}

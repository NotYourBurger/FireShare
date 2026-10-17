import { getApp } from "@/server/app";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return (await getApp()).createUploadSession(req);
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApp } from "@/server/app";
import { ShareView } from "./share-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared files · FireShare",
  robots: { index: false, follow: false },
};

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await (await getApp()).viewShare(token);
  if (!share) notFound();
  return <ShareView token={token} share={share} />;
}

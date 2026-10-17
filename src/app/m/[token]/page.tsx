import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApp } from "@/server/app";
import { ManageView } from "./manage-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Manage share · FireShare",
  robots: { index: false, follow: false },
};

export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await (await getApp()).viewManagement(token);
  if (!share) notFound();
  return (
    <ManageView
      token={token}
      share={{ ...share, expiresAt: share.expiresAt.toISOString(), deletedAt: share.deletedAt?.toISOString() ?? null }}
    />
  );
}

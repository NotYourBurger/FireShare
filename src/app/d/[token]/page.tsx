import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApp } from "@/server/app";
import { AbuseReportLink } from "./abuse-report-link";
import { ShareUnavailable, ShareView } from "./share-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared files · FireShare",
  robots: { index: false, follow: false },
};

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const app = await getApp();
  const share = await app.viewShare(token);
  if (!share) notFound();
  if (share === "unavailable") return <ShareUnavailable />;
  const abuseReportUrl = app.abuseReportUrl();
  return (
    <ShareView token={token} share={share}>
      {abuseReportUrl && <AbuseReportLink url={abuseReportUrl} />}
    </ShareView>
  );
}

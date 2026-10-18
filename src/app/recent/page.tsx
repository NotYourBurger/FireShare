import type { Metadata } from "next";
import { RecentSharesList } from "./recent-shares-list";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recent shares · FireShare",
  robots: { index: false, follow: false },
};

export default function RecentSharesPage() {
  return (
    <main>
      <div className="page-header-block">
        <h1>Recent shares</h1>
        <p className="tagline">
          Shares created in this browser. <a href="/">Share files</a>
        </p>
      </div>
      <RecentSharesList />
    </main>
  );
}

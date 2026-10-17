import { headers } from "next/headers";
import { getApp } from "@/server/app";
import { UnlockForm } from "./unlock-form";
import { UploadForm } from "./upload-form";

// The expiry presets and upload settings come from the environment at run time.
export const dynamic = "force-dynamic";

export default async function Home() {
  const app = await getApp();
  const access = app.uploadAccess(await headers());
  return (
    <main>
      <div className="page-header-block">
        <h1>FireShare</h1>
        <p className="tagline">
          Upload files and get one link to share them. <a href="/recent">Recent shares</a>
        </p>
      </div>
      {access === "allowed" && <UploadForm {...app.uploadOptions()} />}
      {access === "password" && <UnlockForm />}
      {access === "network" && (
        <p className="card muted">
          Uploads aren&apos;t allowed from your network. Links you&apos;ve been sent still work from anywhere.
        </p>
      )}
    </main>
  );
}

import { getApp } from "@/server/app";
import { UploadForm } from "./upload-form";

// The expiry presets and upload settings come from the environment at run time.
export const dynamic = "force-dynamic";

export default async function Home() {
  const options = (await getApp()).uploadOptions();
  return (
    <main>
      <h1>FireShare</h1>
      <p className="tagline">Upload files and get one link to share them.</p>
      <UploadForm {...options} />
    </main>
  );
}

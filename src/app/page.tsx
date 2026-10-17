import { UploadForm } from "./upload-form";

export default function Home() {
  return (
    <main>
      <h1>FireShare</h1>
      <p className="tagline">Upload files and get one link to share them.</p>
      <UploadForm />
    </main>
  );
}

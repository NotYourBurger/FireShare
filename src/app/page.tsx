import { UploadForm } from "./upload-form";

export default function Home() {
  return (
    <main>
      <h1>FireShare</h1>
      <p className="tagline">Upload a file and get a link to share it.</p>
      <UploadForm />
    </main>
  );
}

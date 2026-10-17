export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Migrate and prepare the bucket before any request is handled. Next.js
    // runs this lazily, so the first request waits until storage is up.
    const { getApp } = await import("./server/app");
    await getApp();
  }
}

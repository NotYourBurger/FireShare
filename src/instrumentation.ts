export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installPeerAddressHeader } = await import("./server/client-address");
    installPeerAddressHeader();

    // A setting that keeps the app from running safely stops it here, before
    // anyone can use it.
    const { configProblems, describeConfigProblems, loadAccessConfig, loadConfig } = await import("./server/config");
    const problems = configProblems(loadConfig, loadAccessConfig);
    if (problems.length > 0) {
      console.error(describeConfigProblems("FireShare", problems));
      process.exit(1);
    }

    // Migrate and prepare the bucket before any request is handled. Next.js
    // runs this lazily, so the first request waits until storage is up.
    const { getApp } = await import("./server/app");
    await getApp();
  }
}

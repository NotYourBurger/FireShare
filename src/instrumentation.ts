export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installPeerAddressHeader } = await import("./server/client-address");
    installPeerAddressHeader();

    // A setting that keeps the app from running safely stops it here, before
    // anyone can use it.
    const { configProblems, configWarnings, describeConfigProblems, loadAccessConfig, loadConfig, loadQuotesConfig } =
      await import("./server/config");
    const problems = configProblems(loadConfig, loadAccessConfig, loadQuotesConfig);
    if (problems.length > 0) {
      console.error(describeConfigProblems("FireShare", problems));
      process.exit(1);
    }
    // Valid but risky or self-defeating settings: start anyway, and say so.
    for (const warning of configWarnings()) console.warn(`Warning: ${warning}`);

    // Migrate and prepare the bucket before any request is handled. Next.js
    // runs this lazily, so the first request waits until storage is up.
    const { getApp } = await import("./server/app");
    await getApp();
  }
}

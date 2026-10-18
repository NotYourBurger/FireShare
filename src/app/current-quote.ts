import { loadQuotesConfig } from "@/server/config";
import { createQuoteCache, fetchLiveQuote, type Quote } from "./quote";

// Server only. With QUOTES=offline the app never calls zenquotes.io.
const quoteCache = createQuoteCache({
  fetchQuote: loadQuotesConfig().live ? fetchLiveQuote : async () => null,
});

/** A quote for this request, without waiting on the network. */
export function currentQuote(): Quote {
  return quoteCache.quote();
}

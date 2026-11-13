// Minimal HTTP abstraction so service code stays testable outside IINA.
// The IINA implementation lives in src/global/iina-http.ts.

export type HttpMethod = "GET" | "POST";

export type HttpOutcome =
  /** Any HTTP response, including 4xx/5xx. `data` is the parsed JSON body if any. */
  | { kind: "response"; statusCode: number; data: unknown }
  /** No HTTP response (offline, DNS, TLS, timeout...). */
  | { kind: "network"; message: string };

/** GET sends `params` in the query string; POST sends them form-urlencoded. */
export type HttpFn = (method: HttpMethod, url: string, params: Record<string, string>) => Promise<HttpOutcome>;

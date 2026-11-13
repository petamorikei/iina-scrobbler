// HttpFn backed by iina.http.
// iina.http rejects any status >= 400 with a plain {statusCode, reason, data, text}
// object (docs/research.md §8.5); fold that back into an ordinary response here.
import type { HttpFn, HttpOutcome } from "../services/http.ts";

function parseBody(data: unknown, text: unknown): unknown {
  if (data !== undefined && data !== null) return data;
  if (typeof text === "string" && text !== "") {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

export const iinaHttp: HttpFn = async (method, url, params): Promise<HttpOutcome> => {
  const options = method === "GET" ? { params, headers: {}, data: {} } : { params: {}, headers: {}, data: params };
  try {
    const res = method === "GET" ? await iina.http.get(url, options) : await iina.http.post(url, options);
    return { kind: "response", statusCode: res.statusCode, data: parseBody(res.data, res.text) };
  } catch (e) {
    const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : null;
    if (o && typeof o.statusCode === "number" && o.statusCode > 0) {
      return { kind: "response", statusCode: o.statusCode, data: parseBody(o.data, o.text) };
    }
    const message = o && typeof o.reason === "string" ? o.reason : String(e);
    return { kind: "network", message };
  }
};

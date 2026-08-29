const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class HttpRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

export function assertLoopbackHostname(hostname: string, label: string): void {
  if (!isLoopbackHostname(hostname)) throw new Error(`${label} must bind to loopback`);
}

export function isLoopbackRequest(request: Request): boolean {
  try {
    return isLoopbackHostname(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    return isLoopbackHostname(requestUrl.hostname)
      && isLoopbackHostname(originUrl.hostname)
      && originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}

export function hasJsonContentType(request: Request): boolean {
  return request.headers.get("content-type")?.toLowerCase().startsWith("application/json") === true;
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new HttpRequestError("request body is required", 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpRequestError("request body is too large", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpRequestError("request body must be valid JSON", 400);
  }
}

/**
 * Network helper for the browser.
 *
 * The link from a client to the server is not reliable enough for a single
 * attempt: a fetch that times out surfaces as a bare `TypeError: Failed to
 * fetch`, which tells the user nothing and aborts the whole upload. Retrying
 * turns a transient blip into a short pause instead of a failure.
 */

export interface RetryOptions {
  /** Human-readable step name, used to build an actionable error message. */
  label: string;
  attempts?: number;
  /** Base delay in ms; grows linearly between attempts. */
  baseDelayMs?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with retries.
 *
 * Only network-level failures are retried. A real HTTP response — including
 * 4xx — is returned immediately, because retrying a rejected request would just
 * repeat the same rejection.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: RetryOptions,
): Promise<Response> {
  const attempts = options.attempts ?? 4;
  const baseDelay = options.baseDelayMs ?? 700;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new Error(`${options.label}已取消。`);
    try {
      return await fetch(input, { ...init, signal: options.signal });
    } catch (error) {
      // An aborted request is intentional; do not retry it.
      if (options.signal?.aborted) throw new Error(`${options.label}已取消。`);
      lastError = error;
      if (attempt < attempts) {
        await sleep(baseDelay * attempt);
      }
    }
  }

  void lastError;
  throw new Error(
    `${options.label}失败：连续 ${attempts} 次无法连接服务器。` +
      `请检查网络后重试；若一直失败，可能是网络对本站或对象存储的访问不稳定。`,
  );
}

/** Sends a JSON request with retries, turning a non-2xx response into a readable error. */
export async function jsonRequestWithRetry<T>(
  url: string,
  init: { method: string; body?: unknown },
  options: RetryOptions,
): Promise<T> {
  const response = await fetchWithRetry(
    url,
    {
      method: init.method,
      headers: { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    options,
  );

  const data = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || `${options.label}失败（HTTP ${response.status}）。`);
  }
  return data;
}

/** POSTs JSON with retries. */
export function postJsonWithRetry<T>(url: string, body: unknown, options: RetryOptions): Promise<T> {
  return jsonRequestWithRetry<T>(url, { method: "POST", body }, options);
}

/** DELETEs with a JSON body and retries. */
export function deleteJsonWithRetry<T>(url: string, body: unknown, options: RetryOptions): Promise<T> {
  return jsonRequestWithRetry<T>(url, { method: "DELETE", body }, options);
}

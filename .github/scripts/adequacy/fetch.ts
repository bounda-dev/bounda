// Fetches the Commission's page, trying again after a network or a server error, which may pass;
// any other answer is final.
export interface FetchPageArgs {
  readonly url: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly attempts: number;
  readonly timeoutMs: number;
}

export interface FetchPageFunction {
  (args: FetchPageArgs): Promise<string>;
}

export class PageFetchError extends Error {
  override readonly name = "PageFetchError";
}

const RETRY_DELAY_MS = 30_000;

export const fetchPage: FetchPageFunction = async ({ url, fetch, wait, attempts, timeoutMs }) => {
  let failure = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await wait(RETRY_DELAY_MS * (attempt - 1));
    let status: number;
    try {
      const response = await fetch(url, {
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return await response.text();
      status = response.status;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      continue;
    }
    failure = `the server answered ${status}`;
    if (status < 500) break;
  }
  throw new PageFetchError(`${url} could not be fetched: ${failure}`);
};

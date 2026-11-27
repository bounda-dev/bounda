import { describe, expect, it } from "vitest";
import { fetchPage, PageFetchError } from "./fetch.ts";

const url = "https://commission.example/adequacy";

const answering = (...answers: readonly (Response | Error)[]) => {
  const calls: RequestInit[] = [];
  const fetch = async (called: string, init: RequestInit): Promise<Response> => {
    expect(called).toBe(url);
    calls.push(init);
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error("fetched too often");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fetch };
};

const fetching = (fetch: (url: string, init: RequestInit) => Promise<Response>) => {
  const waits: number[] = [];
  const page = fetchPage({
    url,
    fetch,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    attempts: 3,
    timeoutMs: 1_000,
  });
  return { page, waits };
};

describe("fetchPage", () => {
  it("returns the page, asking for HTML within the timeout", async () => {
    const { calls, fetch } = answering(new Response("<p>page</p>"));
    const { page, waits } = fetching(fetch);
    await expect(page).resolves.toBe("<p>page</p>");
    expect(waits).toEqual([]);
    expect(calls[0]?.headers).toEqual({ accept: "text/html" });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for the media type it is given", async () => {
    const { calls, fetch } = answering(new Response("{}"));
    const answer = fetchPage({
      url,
      accept: "application/sparql-results+json",
      fetch,
      wait: async () => {},
      attempts: 1,
      timeoutMs: 1_000,
    });
    await expect(answer).resolves.toBe("{}");
    expect(calls[0]?.headers).toEqual({ accept: "application/sparql-results+json" });
  });

  it("tries again, waiting longer each time, after a network or a server error", async () => {
    const { fetch } = answering(
      new TypeError("fetch failed"),
      new Response("", { status: 503 }),
      new Response("<p>page</p>"),
    );
    const { page, waits } = fetching(fetch);
    await expect(page).resolves.toBe("<p>page</p>");
    expect(waits).toEqual([30_000, 60_000]);
  });

  it("tries again when the page breaks off while it is read", async () => {
    const broken = new Response(
      new ReadableStream({
        start: (controller) => controller.error(new TypeError("terminated")),
      }),
    );
    const { fetch } = answering(broken, new Response("<p>page</p>"));
    const { page, waits } = fetching(fetch);
    await expect(page).resolves.toBe("<p>page</p>");
    expect(waits).toEqual([30_000]);
  });

  it("gives up after its attempts, with the last failure", async () => {
    const { fetch } = answering(
      new Response("", { status: 502 }),
      new Response("", { status: 500 }),
      new TypeError("fetch failed"),
    );
    await expect(fetching(fetch).page).rejects.toThrow(
      new PageFetchError(`${url} could not be fetched: fetch failed`),
    );
  });

  it("does not try again after an answer other than a server error", async () => {
    const { calls, fetch } = answering(new Response("", { status: 404 }));
    const { page, waits } = fetching(fetch);
    await expect(page).rejects.toThrow(
      new PageFetchError(`${url} could not be fetched: the server answered 404`),
    );
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("names a failure that is no error", async () => {
    const fetch = async (): Promise<Response> => {
      throw "refused";
    };
    await expect(
      fetchPage({ url, fetch, wait: async () => {}, attempts: 1, timeoutMs: 1 }),
    ).rejects.toThrow(`${url} could not be fetched: refused`);
  });
});

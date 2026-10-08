import assert from "node:assert/strict";
import test from "node:test";

import worker from "../index.js";

const responses = [];
test.afterEach(async () => {
    for (const response of responses.splice(0)) {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
});

const WORKER_ORIGIN = "https://worker.example";

function proxyUrl(targetUrl, extraQuery = "") {
    return `${WORKER_ORIGIN}/?url=${encodeURIComponent(targetUrl)}${extraQuery}`;
}

function createKv(initialEntries = {}) {
    const store = new Map(Object.entries(initialEntries));
    const kv = {
        gets: [],
        puts: [],
        async get(key) {
            kv.gets.push(key);
            return store.has(key) ? store.get(key) : null;
        },
        async put(key, value) {
            kv.puts.push([key, value]);
            store.set(key, value);
        }
    };
    return kv;
}

function createCtx() {
    const pending = [];
    return {
        pending,
        waitUntil(promise) {
            pending.push(promise);
        },
        async flush() {
            await Promise.all(pending);
        }
    };
}

async function runWorker(request, env, handler) {
    const originalFetch = globalThis.fetch;
    const originalConsole = { log: console.log, warn: console.warn, error: console.error };
    const calls = [];
    const logs = [];
    const ctx = createCtx();

    globalThis.fetch = async upstreamRequest => {
        const body = upstreamRequest.body === null ? null : await upstreamRequest.clone().text();
        calls.push({
            url: upstreamRequest.url,
            method: upstreamRequest.method,
            headers: upstreamRequest.headers,
            body
        });
        return handler(upstreamRequest, calls.length);
    };
    console.log = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push(args.join(" "));
    console.error = (...args) => logs.push(args.join(" "));

    try {
        const response = await worker.fetch(
            request,
            {
                PROXY_RATE_LIMITER: {
                    async limit() {
                        return { success: true };
                    }
                },
                PROXY_GLOBAL_LIMITER: {
                    async limit() {
                        return { success: true };
                    }
                },
                ...env
            },
            ctx
        );
        responses.push(response);
        await ctx.flush();
        return { response, calls, logs };
    } finally {
        globalThis.fetch = originalFetch;
        Object.assign(console, originalConsole);
    }
}

test("proxies a direct request and adds CORS headers", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://direct.example/data"), {
            headers: { Origin: "https://app.example", "x-custom": "1" }
        }),
        {},
        () => new Response("hello", { status: 200, headers: { "x-upstream": "yes" } })
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("access-control-expose-headers"), /x-upstream/);
    assert.equal(JSON.parse(response.headers.get("cors-received-headers"))["x-upstream"], "yes");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://direct.example/data");
    assert.equal(calls[0].headers.get("x-custom"), "1");
    assert.equal(calls[0].headers.get("origin"), null);
});

test("supports the legacy ?{targetUrl} format", async () => {
    const { response, calls } = await runWorker(
        new Request(`${WORKER_ORIGIN}/?https://legacy.example/path`),
        {},
        () => new Response("ok")
    );

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://legacy.example/path");
});

test("info page shows the release version when Cloudflare deployment metadata is present", async () => {
    const { response, calls } = await runWorker(
        new Request(`${WORKER_ORIGIN}/`),
        {
            VERSION: "1.3.8",
            CF_VERSION_METADATA: {
                id: "6379f73b-101a-456f-ae3c-f98a259a87a2",
                tag: "production",
                timestamp: "2026-10-08T17:08:00.448Z"
            }
        },
        () => {
            throw new Error("should not fetch");
        }
    );

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /CLOUDFLARE-CORS-ANYWHERE/);
    assert.match(text, /^Version: 1\.3\.8$/m);
    assert.doesNotMatch(text, /6379f73b|Version ID:|Version Tag:/);
    assert.equal(calls.length, 0);
});

test("blocks origins outside the whitelist", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://blocked.example/"), {
            headers: { Origin: "https://evil.example" }
        }),
        { WHITELIST_ORIGINS: JSON.stringify(["^https://good\\.example$"]) },
        () => new Response("nope")
    );

    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
});

test("blocks blacklisted target URLs", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://bad.example/")),
        { BLACKLIST_URLS: JSON.stringify(["^https://bad\\.example"]) },
        () => new Response("nope")
    );

    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
});

test("answers preflight requests without contacting upstream", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://preflight.example/"), {
            method: "OPTIONS",
            headers: {
                Origin: "https://app.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type"
            }
        }),
        {},
        () => new Response("nope")
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-methods"), "POST");
    assert.equal(response.headers.get("access-control-allow-headers"), "content-type");
    assert.equal(response.headers.get("access-control-max-age"), "86400");
    assert.equal(calls.length, 0);
});

test("streams non-SSE responses instead of buffering them", async () => {
    let releaseUpstream;
    const upstreamDone = new Promise(resolve => {
        releaseUpstream = resolve;
    });
    const upstreamBody = new ReadableStream({
        async start(controller) {
            controller.enqueue(new TextEncoder().encode("first-chunk"));
            await upstreamDone;
            controller.close();
        }
    });

    const resultPromise = runWorker(
        new Request(proxyUrl("https://stream.example/file.bin")),
        {},
        () =>
            new Response(upstreamBody, {
                headers: { "content-type": "application/octet-stream" }
            })
    );

    const result = await Promise.race([
        resultPromise,
        new Promise(resolve => setTimeout(() => resolve("timeout"), 500))
    ]);
    releaseUpstream();

    assert.notEqual(result, "timeout", "worker waited for the full upstream body");
    const reader = result.response.body.getReader();
    const { value } = await reader.read();
    assert.equal(new TextDecoder().decode(value), "first-chunk");
    await reader.cancel();
});

test("does not read KV when the direct attempt succeeds", async () => {
    const kv = createKv();
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://no-kv.example/")),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"]),
            BACKUP_SERVER_CACHE: kv
        },
        () => new Response("ok")
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(kv.gets.length, 0);
});

test("fails over to a backup server and caches it as preferred", async () => {
    const kv = createKv();
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://failover.example/data?x=1")),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify([
                { url: "https://backup-a.example/?url={url}", headers: { "x-key": "k" } }
            ]),
            BACKUP_SERVER_CACHE: kv
        },
        (request, callNumber) =>
            callNumber === 1
                ? new Response("blocked", { status: 403 })
                : new Response("from-backup")
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "from-backup");
    assert.equal(calls.length, 2);
    assert.equal(
        calls[1].url,
        `https://backup-a.example/?url=${encodeURIComponent("https://failover.example/data?x=1")}`
    );
    assert.equal(calls[1].headers.get("x-key"), "k");
    assert.equal(calls[0].headers.get("x-key"), null);
    assert.deepEqual(kv.puts, [
        ["backup-preference:failover.example", "https://backup-a.example/?url={url}"]
    ]);
});

test("tries the KV-preferred backup server first", async () => {
    const kv = createKv({
        "backup-preference:preferred.example": "https://backup-b.example/?url={url}"
    });
    const { calls } = await runWorker(
        new Request(proxyUrl("https://preferred.example/")),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify([
                "https://backup-a.example/?url={url}",
                "https://backup-b.example/?url={url}"
            ]),
            BACKUP_SERVER_CACHE: kv
        },
        (request, callNumber) =>
            callNumber === 1 ? new Response("down", { status: 503 }) : new Response("ok")
    );

    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /^https:\/\/backup-b\.example\//);
});

test("skips backup servers and KV when sensitive headers are present", async () => {
    const kv = createKv();
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://sensitive.example/"), {
            headers: { Authorization: "Bearer secret" }
        }),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"]),
            BACKUP_SERVER_CACHE: kv,
            MAX_RETRY_ATTEMPTS: "0"
        },
        () => new Response("blocked", { status: 403 })
    );

    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
    assert.equal(kv.gets.length, 0);
});

test("uses backup servers with sensitive headers when allowSensitive=true", async () => {
    const { calls } = await runWorker(
        new Request(proxyUrl("https://allow-sensitive.example/", "&allowSensitive=true"), {
            headers: { Authorization: "Bearer secret" }
        }),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"]),
            MAX_RETRY_ATTEMPTS: "0"
        },
        (request, callNumber) =>
            callNumber === 1 ? new Response("blocked", { status: 403 }) : new Response("ok")
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.get("authorization"), "Bearer secret");
});

test("does not repeat a 403 against the same target", async () => {
    const started = Date.now();
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://forbidden.example/")),
        { MAX_RETRY_ATTEMPTS: "3" },
        () => new Response("forbidden", { status: 403 })
    );

    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - started < 400, "403 should return without backoff delays");
});

test("repeats a GET against the same target on 503 with backoff", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://flaky.example/")),
        { MAX_RETRY_ATTEMPTS: "1" },
        (request, callNumber) =>
            callNumber === 1 ? new Response("down", { status: 503 }) : new Response("ok")
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
});

test("does not repeat a POST against the same target", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://post-flaky.example/"), { method: "POST", body: "payload" }),
        { MAX_RETRY_ATTEMPTS: "3" },
        () => new Response("down", { status: 503 })
    );

    assert.equal(response.status, 503);
    assert.equal(calls.length, 1);
});

test("does not replay a POST through a backup server", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://post-failover.example/"), {
            method: "POST",
            body: "payload"
        }),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"]),
            MAX_RETRY_ATTEMPTS: "3"
        },
        (request, callNumber) =>
            callNumber === 1 ? new Response("rate", { status: 429 }) : new Response("ok")
    );

    assert.equal(response.status, 429);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, "payload");
});

test("skips backup servers that point back at this worker", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://self-loop.example/")),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify([`${WORKER_ORIGIN}/?url={url}`]),
            MAX_RETRY_ATTEMPTS: "0"
        },
        () => new Response("blocked", { status: 403 })
    );

    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
});

test("returns 502 when every attempt fails with a network error", async () => {
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://unreachable.example/")),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            ENABLE_BACKUP_KV: "true",
            BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"]),
            MAX_RETRY_ATTEMPTS: "0"
        },
        () => {
            throw new Error("connection refused");
        }
    );

    assert.equal(response.status, 502);
    assert.equal(calls.length, 2);
});

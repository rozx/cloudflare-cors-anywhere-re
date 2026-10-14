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

test("never forwards the client's IP upstream, even via x-cors-headers", async () => {
    const ipHeaders = {
        "x-real-ip": "198.51.100.7",
        "true-client-ip": "198.51.100.7",
        "x-client-ip": "198.51.100.7",
        "x-cluster-client-ip": "198.51.100.7",
        forwarded: "for=198.51.100.7",
        "x-forwarded-for": "198.51.100.7"
    };
    const { response, calls } = await runWorker(
        new Request(proxyUrl("https://direct.example/data"), {
            headers: { ...ipHeaders, "x-cors-headers": JSON.stringify(ipHeaders) }
        }),
        {},
        () => new Response("ok")
    );

    assert.equal(response.status, 200);
    for (const name of Object.keys(ipHeaders)) {
        assert.equal(calls[0].headers.get(name), null, name);
    }
});

test("keeps the browser fingerprint intact when the client sends its own identity", async () => {
    const { calls } = await runWorker(
        new Request(proxyUrl("https://direct.example/data"), {
            headers: {
                "User-Agent": "curl/8.7.1",
                "Sec-Ch-Ua": '"Firefox";v="140"',
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
                Accept: "application/json"
            }
        }),
        {},
        () => new Response("ok")
    );

    const headers = calls[0].headers;
    assert.match(headers.get("user-agent"), /^Mozilla\/5\.0 /);
    assert.notEqual(headers.get("sec-ch-ua"), '"Firefox";v="140"');
    assert.equal(headers.get("sec-fetch-mode"), "navigate");
    assert.equal(headers.get("sec-fetch-dest"), "document");
    // Non-identity headers still come from the client.
    assert.equal(headers.get("accept"), "application/json");
});

test("a User-Agent set via x-cors-headers replaces the whole browser identity", async () => {
    const { calls } = await runWorker(
        new Request(proxyUrl("https://direct.example/data"), {
            headers: { "x-cors-headers": '{"User-Agent":"MyApp/1.0"}' }
        }),
        {},
        () => new Response("ok")
    );

    const headers = calls[0].headers;
    assert.equal(headers.get("user-agent"), "MyApp/1.0");
    for (const name of headers.keys()) {
        assert.doesNotMatch(name, /^(sec-ch-|sec-fetch-|upgrade-insecure-requests$)/, name);
    }
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

test("skips the direct attempt while a target is known to be blocked", async () => {
    const env = {
        ENABLE_BACKUP_FALLBACK: "true",
        BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"])
    };
    const target = "https://known-blocked.example/page";
    const first = await runWorker(new Request(proxyUrl(target)), env, (request, n) =>
        n === 1 ? new Response("blocked", { status: 403 }) : new Response("from-backup")
    );
    assert.equal(first.calls.length, 2);

    const second = await runWorker(new Request(proxyUrl(target)), env, () => new Response("ok"));
    assert.equal(second.response.status, 200);
    assert.equal(second.calls.length, 1);
    assert.match(second.calls[0].url, /^https:\/\/backup-a\.example\//);
});

test("falls back to direct when the preferred backup fails, then tries direct first", async () => {
    const env = {
        ENABLE_BACKUP_FALLBACK: "true",
        BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"])
    };
    const target = "https://unblocked-again.example/page";
    await runWorker(new Request(proxyUrl(target)), env, (request, n) =>
        n === 1 ? new Response("blocked", { status: 403 }) : new Response("from-backup")
    );

    const second = await runWorker(new Request(proxyUrl(target)), env, (request, n) =>
        n === 1 ? new Response("down", { status: 503 }) : new Response("direct-ok")
    );
    assert.equal(second.response.status, 200);
    assert.equal(await second.response.text(), "direct-ok");
    assert.deepEqual(
        second.calls.map(call => new URL(call.url).hostname),
        ["backup-a.example", "unblocked-again.example"]
    );

    const third = await runWorker(new Request(proxyUrl(target)), env, () => new Response("ok"));
    assert.equal(new URL(third.calls[0].url).hostname, "unblocked-again.example");
});

test("never skips direct for requests that cannot use backups", async () => {
    const env = {
        ENABLE_BACKUP_FALLBACK: "true",
        BACKUP_CORS_SERVERS: JSON.stringify(["https://backup-a.example/?url={url}"])
    };
    const target = "https://blocked-post.example/api";
    await runWorker(new Request(proxyUrl(target)), env, (request, n) =>
        n === 1 ? new Response("blocked", { status: 403 }) : new Response("from-backup")
    );

    const post = await runWorker(
        new Request(proxyUrl(target), { method: "POST", body: "x" }),
        env,
        () => new Response("ok")
    );
    assert.equal(post.calls.length, 1);
    assert.equal(new URL(post.calls[0].url).hostname, "blocked-post.example");
});

function withFakeCache() {
    const store = new Map();
    const cache = {
        puts: 0,
        async match(key) {
            const entry = store.get(key.url);
            return entry ? new Response(entry.body, entry.init) : undefined;
        },
        async put(key, response) {
            cache.puts++;
            store.set(key.url, {
                body: await response.text(),
                init: {
                    status: response.status,
                    statusText: response.statusText,
                    headers: [...response.headers]
                }
            });
        }
    };
    const original = globalThis.caches;
    globalThis.caches = { default: cache };
    return { cache, store, restore: () => (globalThis.caches = original) };
}

test("caches anonymous GET 200 responses and serves repeats from cache", async () => {
    const { cache, store, restore } = withFakeCache();
    try {
        const target = "https://cached.example/chapter?token=secret";
        const first = await runWorker(
            new Request(proxyUrl(target), { headers: { Origin: "https://app.example" } }),
            {},
            () =>
                new Response("chapter", {
                    headers: { "Cache-Control": "no-store", "Content-Type": "text/html" }
                })
        );
        assert.equal(first.response.headers.get("x-cors-cache"), "MISS");
        assert.equal(await first.response.text(), "chapter");
        assert.equal(cache.puts, 1);
        const [key] = store.keys();
        assert.match(key, /^https:\/\/worker\.example\/__cors-cache\/[0-9a-f]{64}$/);

        const second = await runWorker(
            new Request(proxyUrl(target), { headers: { Origin: "https://other.example" } }),
            {},
            () => new Response("should not be fetched")
        );
        assert.equal(second.calls.length, 0);
        assert.equal(second.response.headers.get("x-cors-cache"), "HIT");
        assert.equal(await second.response.text(), "chapter");
        assert.equal(
            second.response.headers.get("access-control-allow-origin"),
            "https://other.example"
        );
        assert.equal(second.response.headers.get("cache-control"), "no-store");
        assert.equal(
            JSON.parse(second.response.headers.get("cors-received-headers"))["cache-control"],
            "no-store"
        );
        assert.match(second.response.headers.get("access-control-expose-headers"), /x-cors-cache/);
    } finally {
        restore();
    }
});

test("does not cache errors, writes, or requests that may carry credentials", async () => {
    const { cache, restore } = withFakeCache();
    try {
        await runWorker(
            new Request(proxyUrl("https://cache-error.example/")),
            {},
            () => new Response("blocked", { status: 403 })
        );
        await runWorker(
            new Request(proxyUrl("https://cache-post.example/"), { method: "POST", body: "x" }),
            {},
            () => new Response("ok")
        );
        for (const headers of [
            { Authorization: "Bearer secret" },
            { "x-goog-api-key": "secret" },
            { "x-cors-headers": '{"Cookie":"over18=yes"}' },
            { Range: "bytes=0-10" }
        ]) {
            const { response } = await runWorker(
                new Request(proxyUrl("https://cache-private.example/"), { headers }),
                {},
                () => new Response("private")
            );
            assert.equal(response.headers.get("x-cors-cache"), null);
        }
        assert.equal(cache.puts, 0);
    } finally {
        restore();
    }
});

test("x-cors-headers is part of the cache key", async () => {
    const { restore } = withFakeCache();
    try {
        const target = "https://cache-variant.example/";
        await runWorker(
            new Request(proxyUrl(target), {
                headers: { "x-cors-headers": '{"Accept-Language":"ja"}' }
            }),
            {},
            () => new Response("ja")
        );
        const other = await runWorker(
            new Request(proxyUrl(target)),
            {},
            () => new Response("default")
        );
        assert.equal(other.calls.length, 1);
        assert.equal(await other.response.text(), "default");
    } finally {
        restore();
    }
});

test("Accept and Accept-Language are part of the cache key", async () => {
    const { restore } = withFakeCache();
    try {
        const target = "https://cache-negotiation.example/";
        const fetchWith = async (headers, body) =>
            runWorker(new Request(proxyUrl(target), { headers }), {}, () => new Response(body));

        await fetchWith({ Accept: "*/*" }, "any");
        for (const [headers, body] of [
            [{ Accept: "application/json" }, "json"],
            [{ Accept: "*/*", "Accept-Language": "ja" }, "ja"]
        ]) {
            const other = await fetchWith(headers, body);
            assert.equal(other.calls.length, 1, JSON.stringify(headers));
            assert.equal(other.response.headers.get("x-cors-cache"), "MISS");
            assert.equal(await other.response.text(), body);
        }

        const repeat = await fetchWith({ Accept: "application/json" }, "unused");
        assert.equal(repeat.calls.length, 0);
        assert.equal(repeat.response.headers.get("x-cors-cache"), "HIT");
        assert.equal(await repeat.response.text(), "json");
    } finally {
        restore();
    }
});

test("Chrome fingerprints keep User-Agent and client hints on the same version", async () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
        const { calls } = await runWorker(
            new Request(proxyUrl(`https://fingerprint.example/${i}`)),
            {},
            () => new Response("ok")
        );
        const headers = calls[0].headers;
        const chrome = headers.get("user-agent").match(/ Chrome\/(\d+)\.0\.0\.0 /);
        if (!chrome) continue;
        seen.add(headers.get("sec-ch-ua-platform"));
        assert.match(headers.get("sec-ch-ua"), new RegExp(`"Google Chrome";v="${chrome[1]}"`));
        assert.match(headers.get("sec-ch-ua"), new RegExp(`"Chromium";v="${chrome[1]}"`));
        // High-entropy hints are only sent after the server asks for them via Accept-CH.
        assert.equal(headers.get("sec-ch-ua-platform-version"), null);
    }
    assert.equal(seen.size, 2);
});

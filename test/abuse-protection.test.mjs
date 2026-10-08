import assert from "node:assert/strict";
import test from "node:test";
import worker from "../index.js";

const responses = [];
test.afterEach(async () => {
    for (const response of responses.splice(0)) {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
});

const origin = "https://worker.example";
const allow = {
    async limit() {
        return { success: true };
    }
};
const bindings = { PROXY_RATE_LIMITER: allow, PROXY_GLOBAL_LIMITER: allow };

function request(target = "https://public.example/data", init = {}) {
    return new Request(`${origin}/?url=${encodeURIComponent(target)}`, init);
}

async function run(req, env = {}, handler = () => new Response("ok")) {
    const calls = [];
    const pending = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async upstream => {
        calls.push(upstream);
        return handler(upstream, calls.length);
    };
    try {
        const response = await worker.fetch(
            req,
            { ...bindings, ...env },
            {
                waitUntil(promise) {
                    pending.push(promise);
                }
            }
        );
        responses.push(response);
        await Promise.all(pending);
        return { response, calls };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test("rate limited callers cannot fetch upstream or use KV", async () => {
    let kvCalls = 0;
    const { response, calls } = await run(request(), {
        PROXY_RATE_LIMITER: {
            async limit() {
                return { success: false };
            }
        },
        BACKUP_CORS_SERVERS: '["https://backup.example/?url={url}"]',
        BACKUP_SERVER_CACHE: {
            async get() {
                kvCalls++;
            }
        }
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(calls.length, 0);
    assert.equal(kvCalls, 0);
});

test("missing rate limiter fails closed", async () => {
    const { response, calls } = await run(request(), { PROXY_RATE_LIMITER: undefined });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
});

test("public no-Origin access remains available", async () => {
    const { response, calls } = await run(request());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
});

test("omitting Origin cannot bypass an explicit whitelist", async () => {
    const { response, calls } = await run(request(), {
        WHITELIST_ORIGINS: JSON.stringify(["^https://trusted\\.example$"])
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
});

test("invalid whitelist configuration fails closed", async () => {
    const { response, calls } = await run(request(), { WHITELIST_ORIGINS: "invalid" });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
});

for (const target of [
    origin,
    "http://localhost/",
    "http://127.1/",
    "http://2130706433/",
    "http://169.254.169.254/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "https://user:password@public.example/",
    "https://public.example:8443/"
]) {
    test(`blocks unsafe target ${target}`, async () => {
        const { response, calls } = await run(request(target));
        assert.equal(response.status, 403);
        assert.equal(calls.length, 0);
    });
}

test("configured backups do not consume credits without explicit opt-in", async () => {
    let kvCalls = 0;
    const { response, calls } = await run(
        request(),
        {
            BACKUP_CORS_SERVERS: '["https://paid.example/?url={url}"]',
            BACKUP_SERVER_CACHE: {
                async get() {
                    kvCalls++;
                }
            }
        },
        () => new Response("unavailable", { status: 503 })
    );
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(kvCalls, 0);
});

test("rate limits from upstream are not retried or routed around", async () => {
    const { response, calls } = await run(
        request(),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            BACKUP_CORS_SERVERS: '["https://backup.example/?url={url}"]',
            MAX_RETRY_ATTEMPTS: "3"
        },
        () => new Response("rate limited", { status: 429 })
    );
    assert.equal(response.status, 429);
    assert.equal(calls.length, 1);
});

test("a POST is never replayed through a backup", async () => {
    const { response, calls } = await run(
        request(undefined, { method: "POST", body: "charge" }),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            BACKUP_CORS_SERVERS: '["https://backup.example/?url={url}"]'
        },
        () => new Response("unavailable", { status: 503 })
    );
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1);
});

test("upstream redirects are fetched manually so target checks cannot be bypassed", async () => {
    const { response, calls } = await run(request(), {}, upstream => {
        assert.equal(upstream.redirect, "manual");
        return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } });
    });
    assert.equal(response.status, 502);
    assert.equal(calls.length, 1);
});

test("oversize uploads are rejected before an upstream call", async () => {
    const { response, calls } = await run(
        request(undefined, {
            method: "POST",
            body: "x".repeat(1024 * 1024 + 1)
        })
    );
    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
});

for (const env of [
    { PROXY_GLOBAL_LIMITER: undefined },
    {
        PROXY_GLOBAL_LIMITER: {
            async limit() {
                throw new Error("unavailable");
            }
        }
    },
    {
        PROXY_RATE_LIMITER: {
            async limit() {
                return {};
            }
        }
    }
]) {
    test("rate limiting errors fail closed", async () => {
        const { response, calls } = await run(request(), env);
        assert.equal(response.status, 503);
        assert.equal(calls.length, 0);
    });
}

test("the shared limiter protects against many different IPs", async () => {
    const { response, calls } = await run(request(), {
        PROXY_GLOBAL_LIMITER: {
            async limit({ key }) {
                assert.equal(key, "all-requests");
                return { success: false };
            }
        }
    });
    assert.equal(response.status, 429);
    assert.equal(calls.length, 0);
});

test("IPv6 address rotation shares one /64 key and ignores forwarded headers", async () => {
    const keys = [];
    for (const ip of ["2001:db8:1:2::1", "2001:0db8:0001:0002:ffff::2"]) {
        await run(
            request(undefined, {
                headers: { "CF-Connecting-IP": ip, "X-Forwarded-For": Math.random().toString() }
            }),
            {
                PROXY_RATE_LIMITER: {
                    async limit({ key }) {
                        keys.push(key);
                        return { success: true };
                    }
                }
            }
        );
    }
    assert.deepEqual(keys, ["ip6:2001:db8:1:2", "ip6:2001:db8:1:2"]);
});

test("rate limits also apply to info pages and preflights", async () => {
    for (const req of [new Request(origin), request(undefined, { method: "OPTIONS" })]) {
        const { response, calls } = await run(req, {
            PROXY_RATE_LIMITER: {
                async limit() {
                    return { success: false };
                }
            }
        });
        assert.equal(response.status, 429);
        assert.equal(calls.length, 0);
    }
});

test("redirects and backup attempts share the same three-fetch budget", async () => {
    const { response, calls } = await run(
        request(),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            MAX_RETRY_ATTEMPTS: "99999999",
            BACKUP_CORS_SERVERS: JSON.stringify(
                Array.from({ length: 8 }, (_, i) => `https://backup${i}.example/?url={url}`)
            )
        },
        (_, n) =>
            n < 3
                ? new Response(null, { status: 302, headers: { Location: `/redirect${n}` } })
                : new Response("down", { status: 503 })
    );
    assert.equal(response.status, 503);
    assert.equal(calls.length, 3);
});

test("redirect loops stop after three upstream calls", async () => {
    const { response, calls } = await run(
        request(),
        {},
        () => new Response(null, { status: 302, headers: { Location: "/loop" } })
    );
    assert.equal(response.status, 502);
    assert.equal(calls.length, 3);
});

test("target blacklist and allowlist are both enforced on redirects", async () => {
    for (const env of [
        { BLACKLIST_URLS: JSON.stringify(["^https://blocked\\.example/"]) },
        { ALLOWED_TARGET_HOSTS: '["public.example"]' }
    ]) {
        const { response, calls } = await run(
            request(),
            env,
            () =>
                new Response(null, {
                    status: 302,
                    headers: { Location: "https://blocked.example/" }
                })
        );
        assert.equal(response.status, 502);
        assert.equal(calls.length, 1);
    }
});

test("cross-origin redirects strip credentials and all custom headers", async () => {
    const { response, calls } = await run(
        request(undefined, {
            headers: {
                Authorization: "Bearer private",
                Cookie: "secret=value",
                "X-Custom-Secret": "private",
                "x-cors-headers": '{"X-Api-Key":"secret"}'
            }
        }),
        {},
        (_, n) =>
            n === 1
                ? new Response(null, {
                      status: 302,
                      headers: { Location: "https://other.example/" }
                  })
                : new Response("ok")
    );
    assert.equal(response.status, 200);
    for (const name of ["authorization", "cookie", "x-custom-secret", "x-api-key"]) {
        assert.equal(calls[1].headers.get(name), null);
    }
    assert.equal(calls[1].headers.get("x-cors-proxy-hop"), "1");
});

test("backup redirects cannot leak owner credentials", async () => {
    const { response, calls } = await run(
        request(),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            BACKUP_CORS_SERVERS: JSON.stringify([
                { url: "https://backup.example/?url={url}", headers: { "X-Owner-Key": "secret" } }
            ])
        },
        (_, n) =>
            n === 1
                ? new Response("down", { status: 503 })
                : new Response(null, {
                      status: 302,
                      headers: { Location: "https://attacker.example/" }
                  })
    );
    assert.equal(response.status, 502);
    assert.equal(calls.length, 2);
});

test("KV remains unused without separate explicit opt-in", async () => {
    let kvCalls = 0;
    const { response, calls } = await run(
        request("https://memory-only.example/"),
        {
            ENABLE_BACKUP_FALLBACK: "true",
            BACKUP_CORS_SERVERS: '["https://backup.example/?url={url}"]',
            BACKUP_SERVER_CACHE: {
                async get() {
                    kvCalls++;
                },
                async put() {
                    kvCalls++;
                }
            }
        },
        (_, n) => new Response("result", { status: n === 1 ? 503 : 200 })
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(kvCalls, 0);
});

test("too many retries cannot exceed three fetches", async () => {
    const { calls } = await run(
        request(),
        { MAX_RETRY_ATTEMPTS: "99999999" },
        () => new Response("down", { status: 503 })
    );
    assert.equal(calls.length, 3);
});

test("malformed custom headers return 400 without fetching", async () => {
    for (const value of ["{", '"string"', "[]", '{"x-key":{}}', '{"bad header":"value"}']) {
        const { response, calls } = await run(
            request(undefined, { headers: { "x-cors-headers": value } })
        );
        assert.equal(response.status, 400);
        assert.equal(calls.length, 0);
    }
});

test("custom headers cannot override routing, connection, or proxy loop headers", async () => {
    const { calls } = await run(
        request(undefined, {
            headers: {
                "x-cors-headers": JSON.stringify({
                    Host: "localhost",
                    "CF-Connecting-IP": "1.2.3.4",
                    "X-Forwarded-For": "1.2.3.4",
                    Connection: "Upgrade",
                    "X-Cors-Proxy-Hop": "0",
                    "Proxy-Authorization": "private"
                })
            }
        })
    );
    for (const header of [
        "host",
        "cf-connecting-ip",
        "x-forwarded-for",
        "connection",
        "proxy-authorization"
    ]) {
        assert.equal(calls[0].headers.get(header), null);
    }
    assert.equal(calls[0].headers.get("x-cors-proxy-hop"), "1");
});

test("upstream responses cannot modify the proxy origin or run scripts", async () => {
    const { response } = await run(
        request(),
        {},
        () =>
            new Response("<script>evil()</script>", {
                headers: {
                    "Content-Type": "text/html",
                    "Set-Cookie": "private=stolen",
                    "Clear-Site-Data": '"*"',
                    "Content-Security-Policy": "script-src *",
                    "Cache-Control": "public,max-age=86400"
                }
            })
    );
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("clear-site-data"), null);
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(response.headers.get("cors-received-headers"), /stolen/);
});

test("chunked response size is enforced and the upstream stream is cancelled", async () => {
    let cancelled = false;
    const { response } = await run(
        request(),
        {},
        () =>
            new Response(
                new ReadableStream({
                    pull(controller) {
                        controller.enqueue(new Uint8Array(1024 * 1024));
                    },
                    cancel() {
                        cancelled = true;
                    }
                })
            )
    );
    await assert.rejects(response.arrayBuffer(), /Body size limit exceeded/);
    assert.equal(cancelled, true);
});

test("declared oversized response is rejected before streaming", async () => {
    const { response } = await run(
        request(),
        {},
        () =>
            new Response("too large", {
                headers: { "Content-Length": String(10 * 1024 * 1024 + 1) }
            })
    );
    assert.equal(response.status, 502);
});

test("chunked upload size is enforced even without Content-Length", async () => {
    let cancelled = false;
    const { response, calls } = await run(
        request(undefined, {
            method: "POST",
            duplex: "half",
            body: new ReadableStream({
                pull(controller) {
                    controller.enqueue(new Uint8Array(512 * 1024));
                },
                cancel() {
                    cancelled = true;
                }
            })
        })
    );
    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
    assert.equal(cancelled, true);
});

test("self-proxy loops and WebSocket upgrades are rejected", async () => {
    for (const [headers, status] of [
        [{ "x-cors-proxy-hop": "1" }, 403],
        [{ Upgrade: "websocket" }, 405]
    ]) {
        const { response, calls } = await run(request(undefined, { headers }));
        assert.equal(response.status, status);
        assert.equal(calls.length, 0);
    }
});

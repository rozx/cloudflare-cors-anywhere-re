// Short-lived edge cache for anonymous GET responses (Cache API, per Cloudflare location).
// Cuts repeat upstream fetches, e.g. retries or re-imports, which also lowers the chance
// of tripping a target site's rate limit.

export const RESPONSE_CACHE_TTL_SECONDS = 10 * 60;
const UPSTREAM_CACHE_CONTROL = "x-cors-upstream-cache-control";

// Headers a browser or Cloudflare adds on its own. Any other request header could carry a
// credential (e.g. x-goog-api-key) that the cache key does not see, so it disables caching.
const ANONYMOUS_REQUEST_HEADERS = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "cdn-loop",
    "connection",
    "dnt",
    "host",
    "origin",
    "pragma",
    "priority",
    "referer",
    "true-client-ip",
    "user-agent",
    "x-cors-headers",
    "x-real-ip"
]);
const ANONYMOUS_REQUEST_HEADER_PREFIXES = ["sec-", "cf-", "x-forwarded-"];

function getCache() {
    return typeof caches === "undefined" ? null : caches.default;
}

export function isCacheableRequest(request, sensitiveHeaders) {
    if (request.method !== "GET" || sensitiveHeaders.length || !getCache()) return false;
    for (const [name] of request.headers) {
        if (
            !ANONYMOUS_REQUEST_HEADERS.has(name) &&
            !ANONYMOUS_REQUEST_HEADER_PREFIXES.some(prefix => name.startsWith(prefix))
        )
            return false;
    }
    return true;
}

// The key lives on our own origin and is hashed, so target query secrets are never stored
// in it. x-cors-headers, Accept and Accept-Language are part of the key because they change
// the upstream request and can change the response (content negotiation).
export async function buildCacheKey(originUrl, targetUrl, request) {
    const material = JSON.stringify([
        targetUrl,
        ...["x-cors-headers", "accept", "accept-language"].map(
            name => request.headers.get(name) || ""
        )
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    return new Request(`${originUrl.origin}/__cors-cache/${hex}`);
}

// Returns the cached upstream response with its original Cache-Control restored, or null.
export async function matchCachedResponse(cacheKey) {
    try {
        const cached = await getCache()?.match(cacheKey);
        if (!cached) return null;
        const headers = new Headers(cached.headers);
        const upstreamCacheControl = headers.get(UPSTREAM_CACHE_CONTROL);
        headers.delete(UPSTREAM_CACHE_CONTROL);
        if (upstreamCacheControl) headers.set("cache-control", upstreamCacheControl);
        else headers.delete("cache-control");
        return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers
        });
    } catch {
        return null;
    }
}

// Upstream no-store/private would stop the Cache API from storing it, so the TTL is forced
// and the original value is kept aside for cors-received-headers.
export async function putCachedResponse(cacheKey, response) {
    const headers = new Headers(response.headers);
    const upstreamCacheControl = headers.get("cache-control");
    if (upstreamCacheControl) headers.set(UPSTREAM_CACHE_CONTROL, upstreamCacheControl);
    headers.set("cache-control", `public, max-age=${RESPONSE_CACHE_TTL_SECONDS}`);
    headers.delete("vary");
    try {
        await getCache()?.put(
            cacheKey,
            new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers
            })
        );
    } catch {
        // A truncated, oversized or cancelled body must simply not be cached.
    }
}

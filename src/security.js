import { applyCorsHeaders, matchesPatternList } from "./cors.js";

export const MAX_URL_LENGTH = 8192;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_DURATION_MS = 30_000;
export const MAX_UPSTREAM_FETCHES = 3;
export const ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function errorResponse(request, status, message) {
    const headers = applyCorsHeaders(new Headers(), request);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    if (status === 429) headers.set("Retry-After", "60");
    return new Response(message, { status, headers });
}

function clientKey(request) {
    // Cloudflare supplies this header. Never use client-chosen X-Forwarded-For.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!ip.includes(":")) return `ip:${ip}`;
    // Group IPv6 clients by /64 so address rotation within a subnet is ineffective.
    try {
        const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
        const [left, right = ""] = normalized.split("::");
        const head = left ? left.split(":") : [];
        const tail = right ? right.split(":") : [];
        const groups = normalized.includes("::")
            ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
            : head;
        return `ip6:${groups
            .slice(0, 4)
            .map(group => parseInt(group, 16).toString(16))
            .join(":")}`;
    } catch {
        return "ip:unknown";
    }
}

export async function checkRateLimits(request, env) {
    // Missing/failed bindings must not silently turn this into an unlimited proxy.
    try {
        for (const [binding, key] of [
            [env?.PROXY_RATE_LIMITER, clientKey(request)],
            [env?.PROXY_GLOBAL_LIMITER, "all-requests"]
        ]) {
            if (typeof binding?.limit !== "function") throw new Error("Missing rate limiter");
            const result = await binding.limit({ key });
            if (result?.success === false)
                return errorResponse(request, 429, "Rate limit exceeded");
            if (result?.success !== true) throw new Error("Invalid rate limiter result");
        }
    } catch {
        return errorResponse(request, 503, "Proxy protection unavailable");
    }
    return null;
}

export function isAllowedTarget(targetUrl, originUrl, config) {
    try {
        const target = new URL(targetUrl);
        const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
        const self = originUrl.hostname.toLowerCase().replace(/\.$/, "");
        if (
            target.href.length > MAX_URL_LENGTH ||
            !["https:", "http:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            target.port
        )
            return false;
        // This public proxy accepts DNS names only, on standard HTTP(S) ports.
        // URL normalizes alternate IPv4 spellings (127.1, decimal, octal, hex).
        if (hostname === self || hostname.startsWith("[") || /^[\d.]+$/.test(hostname))
            return false;
        if (
            !hostname.includes(".") ||
            /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(hostname)
        )
            return false;
        if (!/^[a-z0-9.-]+$/.test(hostname)) return false;
        if (config.allowedTargetHosts.length && !config.allowedTargetHosts.includes(hostname))
            return false;
        const canonicalUrl = new URL(target);
        canonicalUrl.hostname = hostname;
        return (
            !matchesPatternList(target.href, config.blacklistPatterns) &&
            !matchesPatternList(canonicalUrl.href, config.blacklistPatterns)
        );
    } catch {
        return false;
    }
}

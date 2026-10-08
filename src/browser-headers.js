// Bot Detection Note:
// Some sites (like Google) use advanced bot detection that may block Cloudflare Workers requests.
// This is due to: IP reputation (data center IPs), TLS fingerprinting, inability to execute
// JavaScript challenges, and no headless browser support. For blocked sites, consider:
// 1. Using external scraping services (ScrapingBee, ScraperAPI, etc.)
// 2. Using official APIs when available
// 3. Deploying on platforms that support headless browsers (Vercel, AWS Lambda, etc.)

// Request headers that must not be forwarded upstream
const EXCLUDED_HEADER_PATTERNS = [
    /^origin$/i,
    /^referer$/i,
    /^cf-/i,
    /^x-forw/i,
    /^x-cors-/i,
    /^(host|connection|content-length|transfer-encoding|upgrade|proxy-authorization|proxy-connection|keep-alive|te|trailer)$/i
];

// Realistic browser fingerprints to rotate through.
// Referer and Sec-Fetch-Site are filled in per request by getBrowserHeaders.
const BROWSER_FINGERPRINTS = [
    {
        // Chrome on Windows
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: null,
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Ch-Ua-Platform-Version": '"15.0.0"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": null,
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0"
    },
    {
        // Chrome on macOS
        "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: null,
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Ch-Ua-Platform-Version": '"15.0.0"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": null,
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0"
    },
    {
        // Firefox on Windows
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: null,
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": null,
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0"
    },
    {
        // Safari on macOS
        "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: null,
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": null,
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0"
    }
];

/**
 * Pick a browser fingerprint for the target URL (stable per URL) and fill in the
 * per-request Referer and Sec-Fetch-Site values.
 */
function getBrowserHeaders(targetUrl, originHeader) {
    let hash = 0;
    for (let i = 0; i < targetUrl.length; i++) {
        hash = (hash << 5) - hash + targetUrl.charCodeAt(i);
    }
    const fingerprint = BROWSER_FINGERPRINTS[Math.abs(hash) % BROWSER_FINGERPRINTS.length];

    return {
        ...fingerprint,
        // Use the origin as referer, or a common search engine when there is none
        Referer: originHeader || "https://www.google.com/",
        "Sec-Fetch-Site": originHeader ? "cross-site" : "none"
    };
}

/**
 * Build the upstream request headers: browser-like defaults, then the original request
 * headers (minus excluded ones), then x-cors-headers overrides.
 */
export function buildUpstreamHeaders(request, targetUrl, customHeaders) {
    const upstreamHeaders = new Headers(
        getBrowserHeaders(targetUrl, request.headers.get("Origin"))
    );
    const add = entries => {
        for (const [key, value] of entries) {
            if (!EXCLUDED_HEADER_PATTERNS.some(pattern => pattern.test(key))) {
                upstreamHeaders.set(key, value);
            }
        }
    };
    add(request.headers);
    if (customHeaders) add(Object.entries(customHeaders));
    upstreamHeaders.delete("connection");
    upstreamHeaders.set("x-cors-proxy-hop", "1");
    return upstreamHeaders;
}

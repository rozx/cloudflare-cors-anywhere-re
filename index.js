/*
CORS Anywhere as a Cloudflare Worker!
(c) 2019 by Zibri (www.zibri.org)
email: zibri AT zibri DOT org
https://github.com/Zibri/cloudflare-cors-anywhere

(c) by rozx
https://github.com/rozx/cloudflare-cors-anywhere

This Cloudflare Worker script acts as a CORS proxy that allows
cross-origin resource sharing for specified origins and URLs.
It handles OPTIONS preflight requests and modifies response headers accordingly to enable CORS.
The script also includes functionality to parse custom headers and provide detailed information
about the CORS proxy service when accessed without specific parameters.
The script is configurable with whitelist and blacklist patterns, although the blacklist feature is currently unused.
The main goal is to facilitate cross-origin requests while enforcing specific security and rate-limiting policies.
*/

// Configuration: Default values (used as fallback if env vars are unavailable)
const DEFAULT_BLACKLIST_URLS = []; // regexp for blacklisted urls
const DEFAULT_WHITELIST_ORIGINS = [".*"]; // regexp for whitelisted origins
const VERSION = "1.2.0"; // Version ID

/**
 * Get configuration from Cloudflare Secrets or environment variables, with fallback to defaults
 *
 * Configuration values should be JSON arrays:
 * - BLACKLIST_URLS: JSON array of regex patterns for blacklisted URLs
 * - WHITELIST_ORIGINS: JSON array of regex patterns for whitelisted origins
 *
 * Setup using Cloudflare Secrets (recommended for security):
 *   wrangler secret put BLACKLIST_URLS
 *   wrangler secret put WHITELIST_ORIGINS
 *
 * Or using wrangler.toml [vars] section (for non-sensitive config):
 *   [vars]
 *   BLACKLIST_URLS = '["^https?://malicious\\.com"]'
 *   WHITELIST_ORIGINS = '["^https://example\\.com$"]'
 *
 * Secrets take precedence over vars if both are set.
 */
function getConfig(env) {
    let blacklistUrls = DEFAULT_BLACKLIST_URLS;
    let whitelistOrigins = DEFAULT_WHITELIST_ORIGINS;

    // Try to read from environment variables
    if (env) {
        // Parse blacklistUrls from env var (JSON array)
        if (env.BLACKLIST_URLS) {
            try {
                blacklistUrls = JSON.parse(env.BLACKLIST_URLS);
                if (!Array.isArray(blacklistUrls)) {
                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  BLACKLIST_URLS must be a JSON array, using default`
                    );
                    blacklistUrls = DEFAULT_BLACKLIST_URLS;
                }
            } catch (e) {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Failed to parse BLACKLIST_URLS from env: ${
                        e.message
                    }, using default`
                );
                blacklistUrls = DEFAULT_BLACKLIST_URLS;
            }
        }

        // Parse whitelistOrigins from env var (JSON array)
        if (env.WHITELIST_ORIGINS) {
            try {
                whitelistOrigins = JSON.parse(env.WHITELIST_ORIGINS);
                if (!Array.isArray(whitelistOrigins)) {
                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  WHITELIST_ORIGINS must be a JSON array, using default`
                    );
                    whitelistOrigins = DEFAULT_WHITELIST_ORIGINS;
                }
            } catch (e) {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Failed to parse WHITELIST_ORIGINS from env: ${
                        e.message
                    }, using default`
                );
                whitelistOrigins = DEFAULT_WHITELIST_ORIGINS;
            }
        }
    }

    return { blacklistUrls, whitelistOrigins };
}

// Bot Detection Note:
// Some sites (like Google) use advanced bot detection that may block Cloudflare Workers requests.
// This is due to: IP reputation (data center IPs), TLS fingerprinting, inability to execute
// JavaScript challenges, and no headless browser support. For blocked sites, consider:
// 1. Using external scraping services (ScrapingBee, ScraperAPI, etc.)
// 2. Using official APIs when available
// 3. Deploying on platforms that support headless browsers (Vercel, AWS Lambda, etc.)

// Function to check if a given URI or origin is listed in the whitelist or blacklist
function isListedInWhitelist(uri, listing) {
    if (typeof uri === "string") {
        return listing.some(pattern => uri.match(pattern) !== null);
    }
    // When URI is null (e.g., when Origin header is missing), accept null origins
    return true;
}

// Event listener for incoming fetch requests
addEventListener("fetch", async event => {
    event.respondWith(
        (async function() {
            const startTime = Date.now();
            const isPreflightRequest = event.request.method === "OPTIONS";

            const originUrl = new URL(event.request.url);

            // Load configuration from environment variables (with fallback to defaults)
            const config = getConfig(event.env);

            // Log incoming request
            const originHeader = event.request.headers.get("Origin");
            const connectingIp = event.request.headers.get("CF-Connecting-IP");
            const country = event.request.cf?.country;
            const colo = event.request.cf?.colo;

            console.log(
                `[${new Date().toISOString()}] ${event.request.method} ${originUrl.pathname}${
                    originUrl.search
                } | Origin: ${originHeader || "none"} | IP: ${connectingIp ||
                    "unknown"} | Country: ${country || "unknown"} | Colo: ${colo || "unknown"}`
            );

            // Function to modify headers to enable CORS
            const setupCORSHeaders = headers => {
                const origin = event.request.headers.get("Origin");
                if (origin) {
                    // Use the specific origin (not *) to allow credentials
                    headers.set("Access-Control-Allow-Origin", origin);
                    // Allow credentials when a specific origin is present
                    // Note: Credentials can only be used with specific origins, not "*"
                    headers.set("Access-Control-Allow-Credentials", "true");
                } else {
                    // No origin header - could be same-origin request or missing header
                    // For same-origin requests, CORS headers aren't strictly necessary,
                    // but we set them anyway for consistency
                    headers.set("Access-Control-Allow-Origin", "*");
                    // Cannot use credentials with wildcard origin per CORS spec
                }

                if (isPreflightRequest) {
                    const requestMethod = event.request.headers.get(
                        "access-control-request-method"
                    );
                    // Support all common HTTP methods
                    const allowedMethods = requestMethod
                        ? requestMethod
                        : "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS";
                    headers.set("Access-Control-Allow-Methods", allowedMethods);

                    const requestedHeaders = event.request.headers.get(
                        "access-control-request-headers"
                    );
                    if (requestedHeaders) {
                        headers.set("Access-Control-Allow-Headers", requestedHeaders);
                    } else {
                        // Allow common headers if none specified
                        headers.set(
                            "Access-Control-Allow-Headers",
                            "Content-Type, Authorization, X-Requested-With, Accept, Origin"
                        );
                    }

                    headers.delete("X-Content-Type-Options"); // Remove X-Content-Type-Options header
                }
                return headers;
            };

            // Extract target URL - support both ?url={targetUrl} and ?{targetUrl} formats
            let targetUrl = originUrl.searchParams.get("url");

            // If no 'url' parameter, fall back to old format (everything after ?)
            if (!targetUrl && originUrl.search.startsWith("?")) {
                const searchString = originUrl.search.substring(1);
                if (searchString) {
                    try {
                        // Old format may be double-encoded, try decoding twice
                        targetUrl = decodeURIComponent(decodeURIComponent(searchString));
                    } catch (e) {
                        // If double decode fails, try single decode
                        try {
                            targetUrl = decodeURIComponent(searchString);
                        } catch (e2) {
                            // If that also fails, use as-is
                            targetUrl = searchString;
                        }
                    }
                }
            }

            // Parse custom headers (used in both proxy and info page)
            let customHeaders = event.request.headers.get("x-cors-headers");
            if (customHeaders !== null) {
                try {
                    customHeaders = JSON.parse(customHeaders);
                } catch (e) {}
            }

            // Handle OPTIONS preflight requests early - don't forward to target URL
            if (isPreflightRequest) {
                // Validate origin and target URL exist
                if (
                    targetUrl &&
                    !isListedInWhitelist(targetUrl, config.blacklistUrls) &&
                    isListedInWhitelist(originHeader, config.whitelistOrigins)
                ) {
                    const preflightHeaders = new Headers();
                    setupCORSHeaders(preflightHeaders);

                    // Add Access-Control-Max-Age for preflight caching (24 hours)
                    // This allows browsers to cache the preflight response and avoid repeated OPTIONS requests
                    preflightHeaders.set("Access-Control-Max-Age", "86400");

                    console.log(
                        `[${new Date().toISOString()}] ✅ Preflight handled: ${targetUrl} | Origin: ${originHeader ||
                            "none"}`
                    );

                    return new Response(null, {
                        status: 200,
                        statusText: "OK",
                        headers: preflightHeaders
                    });
                } else {
                    // Invalid preflight - still return CORS headers but with error status
                    const errorHeaders = new Headers();
                    setupCORSHeaders(errorHeaders);

                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  Preflight blocked: URL not whitelisted or origin not allowed | Target: ${targetUrl ||
                            "none"} | Origin: ${originHeader || "none"}`
                    );

                    return new Response(null, {
                        status: 403,
                        statusText: "Forbidden",
                        headers: errorHeaders
                    });
                }
            }

            if (
                targetUrl &&
                !isListedInWhitelist(targetUrl, config.blacklistUrls) &&
                isListedInWhitelist(originHeader, config.whitelistOrigins)
            ) {
                // Fetch the target URL
                const filteredHeaders = {};
                const excludePatterns = [
                    /^origin/i,
                    /^referer/i,
                    /^cf-/,
                    /^x-forw/i,
                    /^x-cors-headers/i
                ];

                // Determine Sec-Fetch-Site based on origin
                const secFetchSite = originHeader ? "cross-site" : "none";

                // Generate a realistic referer (use a common search engine or the origin)
                const referer = originHeader || "https://www.google.com/";

                // Multiple realistic browser fingerprints to rotate through
                const browserFingerprints = [
                    {
                        // Chrome on Windows
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        Accept:
                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Accept-Encoding": "gzip, deflate, br",
                        Referer: referer,
                        "Sec-Ch-Ua":
                            '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                        "Sec-Ch-Ua-Mobile": "?0",
                        "Sec-Ch-Ua-Platform": '"Windows"',
                        "Sec-Ch-Ua-Platform-Version": '"15.0.0"',
                        "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate",
                        "Sec-Fetch-Site": secFetchSite,
                        "Sec-Fetch-User": "?1",
                        "Upgrade-Insecure-Requests": "1",
                        "Cache-Control": "max-age=0"
                    },
                    {
                        // Chrome on macOS
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        Accept:
                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Accept-Encoding": "gzip, deflate, br",
                        Referer: referer,
                        "Sec-Ch-Ua":
                            '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                        "Sec-Ch-Ua-Mobile": "?0",
                        "Sec-Ch-Ua-Platform": '"macOS"',
                        "Sec-Ch-Ua-Platform-Version": '"15.0.0"',
                        "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate",
                        "Sec-Fetch-Site": secFetchSite,
                        "Sec-Fetch-User": "?1",
                        "Upgrade-Insecure-Requests": "1",
                        "Cache-Control": "max-age=0"
                    },
                    {
                        // Firefox on Windows
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
                        Accept:
                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.5",
                        "Accept-Encoding": "gzip, deflate, br",
                        Referer: referer,
                        DNT: "1",
                        Connection: "keep-alive",
                        "Upgrade-Insecure-Requests": "1",
                        "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate",
                        "Sec-Fetch-Site": secFetchSite,
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
                        Referer: referer,
                        DNT: "1",
                        Connection: "keep-alive",
                        "Upgrade-Insecure-Requests": "1",
                        "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate",
                        "Sec-Fetch-Site": secFetchSite,
                        "Sec-Fetch-User": "?1",
                        "Cache-Control": "max-age=0"
                    }
                ];

                // Randomly select a browser fingerprint (or use hash of target URL for consistency)
                const fingerprintIndex =
                    Math.abs(
                        targetUrl.split("").reduce((hash, char) => {
                            return (hash << 5) - hash + char.charCodeAt(0);
                        }, 0)
                    ) % browserFingerprints.length;

                const defaultBrowserHeaders = browserFingerprints[fingerprintIndex];

                // Start with default browser headers
                Object.assign(filteredHeaders, defaultBrowserHeaders);

                // Override with headers from the original request (except excluded ones)
                for (const [key, value] of event.request.headers.entries()) {
                    if (!excludePatterns.some(pattern => pattern.test(key))) {
                        filteredHeaders[key] = value;
                    }
                }

                // Custom headers override everything
                if (customHeaders !== null && typeof customHeaders === "object") {
                    Object.assign(filteredHeaders, customHeaders);
                }

                // Create new request with explicit method, body, and URL to ensure all HTTP methods work
                // This preserves the original request method (GET, POST, PUT, DELETE, PATCH, etc.)
                // and forwards the body for methods that need it
                const requestMethod = event.request.method;

                // Create a new request copying all properties from the original request
                // but with the target URL and filtered headers
                const newRequest = new Request(targetUrl, {
                    method: requestMethod,
                    headers: filteredHeaders,
                    body: event.request.body, // Request constructor handles body appropriately
                    redirect: "follow"
                });

                try {
                    console.log(
                        `[${new Date().toISOString()}] Fetching target URL: ${targetUrl} | Method: ${requestMethod}`
                    );
                    const response = await fetch(targetUrl, newRequest);
                    const responseHeaders = new Headers(response.headers);
                    const exposedHeaders = Array.from(response.headers.keys());
                    const allResponseHeaders = Object.fromEntries(response.headers.entries());

                    exposedHeaders.push("cors-received-headers");
                    setupCORSHeaders(responseHeaders);

                    responseHeaders.set("Access-Control-Expose-Headers", exposedHeaders.join(","));
                    responseHeaders.set(
                        "cors-received-headers",
                        JSON.stringify(allResponseHeaders)
                    );

                    const responseBody = isPreflightRequest ? null : await response.arrayBuffer();
                    const duration = Date.now() - startTime;

                    console.log(
                        `[${new Date().toISOString()}] ✅ Success: ${targetUrl} | Status: ${
                            response.status
                        } | Duration: ${duration}ms | Method: ${event.request.method}`
                    );

                    return new Response(responseBody, {
                        headers: responseHeaders,
                        status: isPreflightRequest ? 200 : response.status,
                        statusText: isPreflightRequest ? "OK" : response.statusText
                    });
                } catch (error) {
                    const duration = Date.now() - startTime;
                    console.error(
                        `[${new Date().toISOString()}] ❌ Error fetching ${targetUrl}: ${
                            error.message
                        } | Duration: ${duration}ms | Stack: ${error.stack}`
                    );

                    const errorHeaders = new Headers();
                    setupCORSHeaders(errorHeaders);
                    return new Response(`Error fetching target URL: ${error.message}`, {
                        status: 502,
                        statusText: "Bad Gateway",
                        headers: errorHeaders
                    });
                }
            } else if (!targetUrl) {
                // No target URL provided, show info page
                console.log(`[${new Date().toISOString()}] ℹ️  Info page requested`);

                const responseHeaders = new Headers();
                setupCORSHeaders(responseHeaders);

                const infoText = [
                    "CLOUDFLARE-CORS-ANYWHERE",
                    `Version: ${VERSION}`,
                    "",
                    "Source:",
                    "https://github.com/rozx/cloudflare-cors-anywhere",
                    "",
                    "Usage:",
                    `${originUrl.origin}/?url={targetUrl}`,
                    `or: ${originUrl.origin}/?{targetUrl}`,
                    "",
                    "Limits: 100,000 requests/day",
                    "          1,000 requests/10 minutes",
                    "",
                    ...(originHeader ? [`Origin: ${originHeader}`] : []),
                    `IP: ${connectingIp || "unknown"}`,
                    ...(country ? [`Country: ${country}`] : []),
                    ...(colo ? [`Datacenter: ${colo}`] : []),
                    "",
                    ...(customHeaders !== null
                        ? [`x-cors-headers: ${JSON.stringify(customHeaders)}`]
                        : [])
                ].join("\n");

                return new Response(infoText, {
                    status: 200,
                    headers: responseHeaders
                });
            } else {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Request blocked: URL not whitelisted or origin not allowed | Target: ${targetUrl} | Origin: ${originHeader ||
                        "none"}`
                );

                const errorHeaders = new Headers();
                setupCORSHeaders(errorHeaders);
                errorHeaders.set("Content-Type", "text/html");

                return new Response(
                    "Create your own CORS proxy</br>\n" +
                        "<a href='https://github.com/rozx/cloudflare-cors-anywhere'>https://github.com/rozx/cloudflare-cors-anywhere</a></br>\n",
                    {
                        status: 403,
                        statusText: "Forbidden",
                        headers: errorHeaders
                    }
                );
            }
        })()
    );
});

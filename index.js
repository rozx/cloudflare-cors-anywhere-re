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

// Import version from package.json (auto-generated file)
import { VERSION as PACKAGE_VERSION } from "./version.js";

// Configuration: Default values (used as fallback if env vars are unavailable)
const DEFAULT_BLACKLIST_URLS = []; // regexp for blacklisted urls
const DEFAULT_WHITELIST_ORIGINS = [".*"]; // regexp for whitelisted origins
const DEFAULT_VERSION = PACKAGE_VERSION; // Version from package.json (auto-generated)

/**
 * Get version metadata from Cloudflare Version Metadata binding or environment variable or default
 *
 * Priority order:
 * 1. Cloudflare Version Metadata (env.CF_VERSION_METADATA) - automatically provided by Cloudflare
 * 2. Custom VERSION env var (set via wrangler.toml [vars] or wrangler secret put VERSION)
 * 3. DEPLOYMENT_VERSION env var (alternative custom version)
 * 4. Default version (fallback)
 *
 * Version Metadata provides:
 * - id: Unique version identifier
 * - tag: Optional version tag
 * - timestamp: Version creation timestamp
 *
 * Returns an object with { version, versionId, versionTag, versionTimestamp }
 */
function getVersionMetadata(env) {
    // Try Cloudflare's built-in Version Metadata binding first
    // Note: Version Metadata is only populated in certain deployment scenarios
    // and may have empty id/tag if not using Workers Versions API
    if (env?.CF_VERSION_METADATA) {
        try {
            const { id, tag, timestamp } = env.CF_VERSION_METADATA;

            // Only use if id or tag are non-empty strings
            const versionId = id && id.trim() ? id : null;
            const versionTag = tag && tag.trim() ? tag : null;
            const versionTimestamp =
                timestamp && timestamp !== "0001-01-01T00:00:00Z" && timestamp.trim()
                    ? timestamp
                    : null;

            if (versionId || versionTag) {
                return {
                    version: versionTag || versionId,
                    versionId,
                    versionTag,
                    versionTimestamp
                };
            }
        } catch (e) {
            // Silently fall through to environment variables
        }
    }

    // Use environment variables (more reliable and commonly used)
    // Set via wrangler.toml [vars] or wrangler secret put VERSION
    // Or during deployment: wrangler deploy --var VERSION:$(git rev-parse --short HEAD)
    const version = env?.VERSION || env?.DEPLOYMENT_VERSION || DEFAULT_VERSION;
    return {
        version,
        versionId: null,
        versionTag: null,
        versionTimestamp: null
    };
}

/**
 * Get configuration from Cloudflare Secrets or environment variables, with fallback to defaults
 *
 * Configuration values should be JSON arrays:
 * - BLACKLIST_URLS: JSON array of regex patterns for blacklisted URLs
 * - WHITELIST_ORIGINS: JSON array of regex patterns for whitelisted origins
 *
 * Priority order (highest to lowest):
 * 1. Direct secrets (env.BLACKLIST_URLS) - set via wrangler secret put
 * 2. Environment variables (env.BLACKLIST_URLS) - from wrangler.toml [vars]
 * 3. Default values
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

/**
 * Check if a response should be streamed instead of buffered
 * Detects Server-Sent Events (SSE), chunked transfer encoding, and streaming content types
 * Supports AI model streaming APIs (OpenAI, Anthropic, etc.)
 *
 * @param {Response} response - The response to check
 * @param {Request} request - The original request (to check Accept headers and URL)
 * @param {string} targetUrl - The target URL being proxied (to check for streaming parameters)
 * @returns {boolean} - True if the response should be streamed
 */
function shouldStreamResponse(response, request, targetUrl) {
    // Skip streaming for preflight requests
    if (request.method === "OPTIONS") {
        return false;
    }

    const contentType = response.headers.get("content-type") || "";
    const transferEncoding = response.headers.get("transfer-encoding") || "";
    const acceptHeader = request.headers.get("accept") || "";

    // Check for Server-Sent Events (SSE) - common for AI streaming APIs
    if (contentType.includes("text/event-stream")) {
        return true;
    }

    // Check for chunked transfer encoding
    if (transferEncoding.toLowerCase().includes("chunked")) {
        return true;
    }

    // Check if client requested streaming (text/event-stream or streaming indicators)
    if (acceptHeader.includes("text/event-stream")) {
        return true;
    }

    // Check URL for streaming parameters (common in AI APIs)
    if (targetUrl) {
        try {
            const url = new URL(targetUrl);
            const streamParam = url.searchParams.get("stream");
            if (streamParam === "true" || streamParam === "1") {
                return true;
            }
        } catch (e) {
            // If URL parsing fails, continue with other checks
        }
    }

    // Check request body for streaming flags (for POST requests with JSON body)
    // Note: This is a heuristic - we can't read the body without consuming it,
    // so we check common patterns in headers
    const contentEncoding = response.headers.get("content-encoding") || "";
    if (contentEncoding.includes("chunked")) {
        return true;
    }

    // Check for common AI streaming API content types
    // OpenAI streaming: text/plain or text/event-stream
    // Anthropic streaming: text/event-stream or application/x-ndjson
    // Other APIs may use application/json with chunked encoding
    if (contentType.includes("application/x-ndjson")) {
        return true;
    }

    // If content-type is text/plain and we have chunked encoding, likely streaming
    if (contentType.includes("text/plain") && transferEncoding.toLowerCase().includes("chunked")) {
        return true;
    }

    return false;
}

// Module worker export - handles all incoming fetch requests
export default {
    async fetch(request, env, ctx) {
        const startTime = Date.now();
        const isPreflightRequest = request.method === "OPTIONS";

        const originUrl = new URL(request.url);

        // Load configuration from environment variables (with fallback to defaults)
        const config = getConfig(env);
        const versionMeta = getVersionMetadata(env);
        const { version, versionId, versionTag, versionTimestamp } = versionMeta;

        // Log incoming request
        const originHeader = request.headers.get("Origin");
        const connectingIp = request.headers.get("CF-Connecting-IP");
        const country = request.cf?.country;
        const colo = request.cf?.colo;

        // Build version info string for logging
        const versionInfo = versionId
            ? `Version: ${version} (id: ${versionId}${versionTag ? `, tag: ${versionTag}` : ""}${
                  versionTimestamp ? `, ts: ${versionTimestamp}` : ""
              })`
            : `Version: ${version}`;

        console.log(
            `[${new Date().toISOString()}] ${request.method} ${originUrl.pathname}${
                originUrl.search
            } | Origin: ${originHeader || "none"} | IP: ${connectingIp ||
                "unknown"} | Country: ${country || "unknown"} | Colo: ${colo ||
                "unknown"} | ${versionInfo}`
        );

        // Function to modify headers to enable CORS
        const setupCORSHeaders = headers => {
            const origin = request.headers.get("Origin");
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
                const requestMethod = request.headers.get("access-control-request-method");
                // Support all common HTTP methods
                const allowedMethods = requestMethod
                    ? requestMethod
                    : "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS";
                headers.set("Access-Control-Allow-Methods", allowedMethods);

                const requestedHeaders = request.headers.get("access-control-request-headers");
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
                // Check if the query string has been parsed into multiple parameters
                // (happens when URL contains unencoded : or / characters)
                const paramKeys = Array.from(originUrl.searchParams.keys());

                // If we have multiple keys and the first one looks like it might be part of a URL,
                // try to reconstruct the URL from the parsed parameters
                if (
                    paramKeys.length > 1 ||
                    (paramKeys.length === 1 && !searchString.includes("="))
                ) {
                    // Try to reconstruct URL from nested query params (e.g., "https://api": {"moonshot": {"ai/models": ""}})
                    // This is a fallback - ideally URLs should be URL-encoded
                    let reconstructed = "";
                    for (const key of paramKeys) {
                        if (reconstructed) reconstructed += "/";
                        reconstructed += key;
                        const value = originUrl.searchParams.get(key);
                        if (value && value !== "") {
                            reconstructed += "=" + value;
                        }
                    }
                    // If reconstructed looks like a URL, use it
                    if (reconstructed.match(/^https?:\/\//i)) {
                        targetUrl = reconstructed;
                    }
                }

                // If we haven't found a target URL yet, try the standard approach
                if (!targetUrl) {
                    // Handle URL-encoded URLs in the query string
                    // Try decoding - the URL might be single or double encoded
                    let decoded = searchString;
                    try {
                        // First, try single decode
                        decoded = decodeURIComponent(searchString);
                        // If it still looks encoded (contains %), try decoding again
                        if (decoded.includes("%")) {
                            decoded = decodeURIComponent(decoded);
                        }
                        targetUrl = decoded;
                    } catch (e) {
                        // If decode fails, try to use the string as-is if it looks like a URL
                        if (
                            searchString.match(/^https?%3A%2F%2F/i) ||
                            searchString.match(/^https?:\/\//i)
                        ) {
                            // It looks like a URL, try one more time with just single decode
                            try {
                                targetUrl = decodeURIComponent(searchString);
                            } catch (e2) {
                                targetUrl = searchString;
                            }
                        } else {
                            targetUrl = searchString;
                        }
                    }
                }
            }
        }

        // Validate and normalize the target URL
        if (targetUrl) {
            // If targetUrl doesn't start with http:// or https://, automatically prepend https://
            if (!targetUrl.match(/^https?:\/\//i)) {
                // Prepend https:// to URLs without a protocol
                targetUrl = `https://${targetUrl}`;
            }

            // Validate that it's a proper URL by trying to construct a URL object
            try {
                const testUrl = new URL(targetUrl);
                // Preserve the full URL including path, query, and hash
                targetUrl = testUrl.href; // Normalize the URL to ensure it's properly formatted
            } catch (e) {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Invalid target URL format: ${targetUrl}, error: ${
                        e.message
                    }`
                );
                targetUrl = null; // Mark as invalid
            }
        }

        // Parse custom headers (used in both proxy and info page)
        let customHeaders = request.headers.get("x-cors-headers");
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
                    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
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
                    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
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
            for (const [key, value] of request.headers.entries()) {
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
            const requestMethod = request.method;

            // Create a new request copying all properties from the original request
            // but with the target URL and filtered headers
            const newRequest = new Request(targetUrl, {
                method: requestMethod,
                headers: filteredHeaders,
                body: request.body, // Request constructor handles body appropriately
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
                responseHeaders.set("cors-received-headers", JSON.stringify(allResponseHeaders));

                // Check if this is a streaming response (for AI model streaming, SSE, etc.)
                const isStreaming = shouldStreamResponse(response, request, targetUrl);

                // For streaming responses, pass through the stream directly
                // For non-streaming, buffer the response as before for backward compatibility
                let responseBody;
                if (isPreflightRequest) {
                    responseBody = null;
                } else if (isStreaming) {
                    // Pass through the stream directly - don't buffer
                    // This allows Server-Sent Events and chunked streaming to work properly
                    responseBody = response.body;
                    console.log(
                        `[${new Date().toISOString()}] 📡 Streaming response detected: ${targetUrl} | Content-Type: ${responseHeaders.get(
                            "content-type"
                        ) || "unknown"}`
                    );
                } else {
                    // Buffer the response for non-streaming responses
                    responseBody = await response.arrayBuffer();
                }

                const duration = Date.now() - startTime;

                // Log success or error based on status code
                // For streaming responses, log immediately (can't wait for completion)
                if (isStreaming) {
                    if (response.status >= 200 && response.status < 300) {
                        console.log(
                            `[${new Date().toISOString()}] ✅ Streaming started: ${targetUrl} | Status: ${
                                response.status
                            } | Method: ${request.method}`
                        );
                    } else if (response.status >= 400) {
                        console.warn(
                            `[${new Date().toISOString()}] ⚠️  Streaming error: ${targetUrl} | Status: ${
                                response.status
                            } ${response.statusText} | Method: ${request.method}`
                        );
                    }
                } else {
                    // Non-streaming: log after buffering is complete
                    if (response.status >= 200 && response.status < 300) {
                        console.log(
                            `[${new Date().toISOString()}] ✅ Success: ${targetUrl} | Status: ${
                                response.status
                            } | Duration: ${duration}ms | Method: ${request.method}`
                        );
                    } else if (response.status >= 400) {
                        console.warn(
                            `[${new Date().toISOString()}] ⚠️  HTTP Error: ${targetUrl} | Status: ${
                                response.status
                            } ${response.statusText} | Duration: ${duration}ms | Method: ${
                                request.method
                            }`
                        );
                    } else {
                        console.log(
                            `[${new Date().toISOString()}] ℹ️  Response: ${targetUrl} | Status: ${
                                response.status
                            } | Duration: ${duration}ms | Method: ${request.method}`
                        );
                    }
                }

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
            const responseHeaders = new Headers();
            setupCORSHeaders(responseHeaders);

            // Format version timestamp - handle both ISO string and Unix timestamp
            let deployedDate = null;
            if (versionTimestamp) {
                try {
                    // If it's a string (ISO format), parse it directly
                    // If it's a number (Unix timestamp in seconds), multiply by 1000
                    if (typeof versionTimestamp === "string") {
                        deployedDate = new Date(versionTimestamp).toISOString();
                    } else if (typeof versionTimestamp === "number") {
                        deployedDate = new Date(versionTimestamp * 1000).toISOString();
                    }
                } catch (e) {
                    // If date parsing fails, skip the timestamp
                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  Failed to parse version timestamp: ${versionTimestamp}`
                    );
                }
            }

            const versionInfo = [
                `Version: ${version}`,
                ...(versionId ? [`Version ID: ${versionId}`] : []),
                ...(versionTag ? [`Version Tag: ${versionTag}`] : []),
                ...(deployedDate ? [`Deployed: ${deployedDate}`] : [])
            ];

            const infoText = [
                "CLOUDFLARE-CORS-ANYWHERE",
                ...versionInfo,
                "",
                "Author:",
                "rozx (https://github.com/rozx)",
                "Zibri (https://github.com/Zibri)",
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
    }
};

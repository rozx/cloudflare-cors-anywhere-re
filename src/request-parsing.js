import { sanitizeLogValue, sanitizeUrlForLog } from "./log-redaction.js";

// Extract target URL - support both ?url={targetUrl} and ?{targetUrl} formats
export function extractTargetUrl(originUrl) {
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
            const hn = testUrl.hostname;

            // Strict validation to block scanner requests and malformed URLs
            // Must contain a dot (domain/IPv4), or be an IPv6 address, or be localhost
            if (!hn.includes(".") && hn !== "localhost" && !(hn.startsWith("[") && hn.endsWith("]"))) {
                throw new Error("Hostname requires a valid domain or IP");
            }
            if (hn.includes("=") || hn.includes("&") || hn.includes("%")) {
                throw new Error("Hostname contains illegal characters");
            }

            // Preserve the full URL including path, query, and hash
            targetUrl = testUrl.href; // Normalize the URL to ensure it's properly formatted
        } catch (e) {
            console.warn(
                `[${new Date().toISOString()}] ⚠️  Invalid target URL format: ${sanitizeUrlForLog(
                    targetUrl
                )}, error: ${sanitizeLogValue(e.message)}`
            );
            targetUrl = null; // Mark as invalid
        }
    }

    return targetUrl;
}

// Parse custom headers (used in both proxy and info page)
export function parseCustomHeaders(request) {
    let customHeaders = request.headers.get("x-cors-headers");
    if (customHeaders !== null) {
        try {
            customHeaders = JSON.parse(customHeaders);
        } catch (e) {
            console.warn(
                `[${new Date().toISOString()}] ⚠️  Failed to parse x-cors-headers: ${e.message}`
            );
        }
    }

    return customHeaders;
}

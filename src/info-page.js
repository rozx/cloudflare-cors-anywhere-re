// Public usage information shown when no target URL is given.
import { applyCorsHeaders } from "./cors.js";
import { getVersionMetadata } from "./version-metadata.js";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_DURATION_MS } from "./security.js";

export function renderInfoPage({ request, env, originUrl }) {
    const { version } = getVersionMetadata(env);
    const headers = applyCorsHeaders(new Headers(), request);
    headers.set("Content-Type", "text/plain; charset=utf-8");

    const infoText = [
        "CLOUDFLARE-CORS-ANYWHERE",
        `Version: ${version}`,
        "",
        "Usage:",
        `${originUrl.origin}/?url={encodedTargetUrl}`,
        "URL-encode the target URL, including any query parameters.",
        "Use the target API's HTTP method, headers, and request body.",
        "",
        "Example:",
        `${originUrl.origin}/?url=https%3A%2F%2Fexample.com%2F`,
        "",
        "Limits:",
        `Upload: ${MAX_REQUEST_BYTES / (1024 * 1024)} MiB`,
        `Response: ${MAX_RESPONSE_BYTES / (1024 * 1024)} MiB`,
        `Request duration: ${MAX_DURATION_MS / 1000} seconds`,
        "Responses that exceed these limits may end early.",
        "If you receive HTTP 429, wait for the time specified in Retry-After before retrying.",
        "",
        "Documentation and source:",
        "https://github.com/rozx/cloudflare-cors-anywhere-re"
    ].join("\n");

    return new Response(infoText, { status: 200, headers });
}

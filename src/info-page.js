// Plain-text info page shown when no target URL is given
import { applyCorsHeaders } from "./cors.js";
import { getVersionMetadata } from "./version-metadata.js";

export function renderInfoPage({ request, env, originUrl, customHeaders }) {
    const { version, versionId, versionTag, versionTimestamp } = getVersionMetadata(env);
    const originHeader = request.headers.get("Origin");
    const connectingIp = request.headers.get("CF-Connecting-IP");
    const country = request.cf?.country;
    const colo = request.cf?.colo;

    const responseHeaders = new Headers();
    applyCorsHeaders(responseHeaders, request);

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
        `allow sensitive headers for backup: ${originUrl.origin}/?url={targetUrl}&allowSensitive=true`,
        "",
        "Backup:",
        "BACKUP_CORS_SERVERS must contain {url} placeholder",
        'Supports per-backup headers: {"url":"...","headers":{"x-cors-api-key":"..."}}',
        "Retryable statuses: 403 + 429 + 502 + 503",
        "403 and POST/PATCH are never repeated against the same target",
        "Backup servers rotate each request (preferred stays first, others rotate)",
        "Successful backup is cached as preferred for 15 minutes per domain (KV)",
        "Sensitive headers block backup by default (override with allowSensitive=true)",
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
}

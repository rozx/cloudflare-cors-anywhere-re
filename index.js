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
The script is configurable with whitelist and blacklist patterns.
The main goal is to facilitate cross-origin requests while enforcing specific security and rate-limiting policies.

Module layout (src/):
  config.js           env parsing + per-isolate config cache
  request-parsing.js  target URL extraction/validation, x-cors-headers parsing
  cors.js             whitelist/blacklist matching, CORS response headers
  proxy.js            upstream fetch with retries and backup failover
  backup-targets.js   backup server ordering and URL building
  backup-cache.js     preferred backup server cache (memory + KV)
  browser-headers.js  browser fingerprint headers for upstream requests
  info-page.js        info page shown without a target URL
  version-metadata.js deployment version info
  log-redaction.js    secret redaction for logs
*/

import { getConfig } from "./src/config.js";
import { applyCorsHeaders, matchesPatternList } from "./src/cors.js";
import { renderInfoPage } from "./src/info-page.js";
import { sanitizeUrlForLog } from "./src/log-redaction.js";
import { proxyRequest } from "./src/proxy.js";
import { extractTargetUrl, parseCustomHeaders } from "./src/request-parsing.js";
import {
    ALLOWED_METHODS,
    MAX_URL_LENGTH,
    checkRateLimits,
    errorResponse,
    isAllowedTarget
} from "./src/security.js";

// Module worker export - handles all incoming fetch requests
export default {
    async fetch(request, env, ctx) {
        const rateError = await checkRateLimits(request, env);
        if (rateError) return rateError;
        if (request.url.length > MAX_URL_LENGTH) return errorResponse(request, 414, "URL too long");
        if (request.headers.has("x-cors-proxy-hop"))
            return errorResponse(request, 403, "Proxy loop blocked");
        if (request.headers.has("upgrade") || !ALLOWED_METHODS.includes(request.method)) {
            return errorResponse(request, 405, "Unsupported method or protocol");
        }
        const originUrl = new URL(request.url);
        const originHeader = request.headers.get("Origin");

        // Load configuration from environment variables (with fallback to defaults)
        let config;
        try {
            config = getConfig(env);
        } catch {
            return errorResponse(request, 503, "Invalid proxy configuration");
        }
        const targetUrl = extractTargetUrl(originUrl);
        let customHeaders;
        try {
            customHeaders = parseCustomHeaders(request);
        } catch {
            return errorResponse(request, 400, "Invalid custom headers");
        }

        const isAllowedRequest =
            Boolean(targetUrl) &&
            isAllowedTarget(targetUrl, originUrl, config) &&
            matchesPatternList(originHeader, config.whitelistPatterns);

        // Handle OPTIONS preflight requests early - don't forward to target URL
        if (request.method === "OPTIONS") {
            const preflightHeaders = applyCorsHeaders(new Headers(), request);

            if (
                isAllowedRequest &&
                ALLOWED_METHODS.includes(
                    request.headers.get("Access-Control-Request-Method") || "GET"
                )
            ) {
                // Add Access-Control-Max-Age for preflight caching (24 hours)
                // This allows browsers to cache the preflight response and avoid repeated OPTIONS requests
                preflightHeaders.set("Access-Control-Max-Age", "86400");

                return new Response(null, {
                    status: 200,
                    statusText: "OK",
                    headers: preflightHeaders
                });
            }

            // Invalid preflight - still return CORS headers but with error status
            console.warn(
                `[${new Date().toISOString()}] ⚠️  Preflight blocked: URL not whitelisted or origin not allowed | Target: ${
                    targetUrl ? sanitizeUrlForLog(targetUrl) : "none"
                } | Origin: ${originHeader || "none"}`
            );

            return new Response(null, {
                status: 403,
                statusText: "Forbidden",
                headers: preflightHeaders
            });
        }

        if (isAllowedRequest) {
            return proxyRequest({
                request,
                env,
                ctx,
                config,
                originUrl,
                targetUrl,
                customHeaders
            });
        }

        if (!targetUrl) {
            if (originUrl.search) return errorResponse(request, 400, "Invalid target URL");
            return renderInfoPage({ request, env, originUrl, customHeaders });
        }

        console.warn(
            `[${new Date().toISOString()}] ⚠️  Request blocked: URL not whitelisted or origin not allowed | Target: ${sanitizeUrlForLog(
                targetUrl
            )} | Origin: ${originHeader || "none"}`
        );

        const errorHeaders = applyCorsHeaders(new Headers(), request);
        errorHeaders.set("Content-Type", "text/html");

        return new Response(
            "Create your own CORS proxy<br>\n" +
                "<a href='https://github.com/rozx/cloudflare-cors-anywhere'>https://github.com/rozx/cloudflare-cors-anywhere</a><br>\n",
            {
                status: 403,
                statusText: "Forbidden",
                headers: errorHeaders
            }
        );
    }
};

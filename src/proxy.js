// Bounded upstream forwarding: all redirects, retries and backups share one budget.
import { clearPreferredBackupServer, setPreferredBackupServer } from "./backup-cache.js";
import { buildBackupAttemptTargets, getSensitiveHeadersForBackup } from "./backup-targets.js";
import { buildUpstreamHeaders } from "./browser-headers.js";
import { applyCorsHeaders } from "./cors.js";
import { sanitizeLogValue, sanitizeUrlForLog } from "./log-redaction.js";
import {
    createRequestBudget,
    readRequestBody,
    limitResponseBody,
    ProxyLimitError
} from "./request-budget.js";
import { errorResponse, isAllowedTarget } from "./security.js";
import { fetchWithPolicy } from "./upstream-fetch.js";

const RETRYABLE_STATUS_CODES = new Set([403, 502, 503]);

export async function proxyRequest({
    request,
    env,
    ctx,
    config,
    originUrl,
    targetUrl,
    customHeaders
}) {
    const budget = createRequestBudget(request);
    const cacheEnv = config.enableBackupKv ? env : {};
    let streaming = false;
    try {
        const headers = buildUpstreamHeaders(request, targetUrl, customHeaders);
        const body = await readRequestBody(request, budget);
        // Even nominally idempotent writes can trigger billable work. Never replay them.
        const canReplay = ["GET", "HEAD"].includes(request.method);
        const sensitiveHeaders = getSensitiveHeadersForBackup(request, customHeaders);
        const allowSensitive = originUrl.searchParams.get("allowSensitive") === "true";
        const backupServers =
            canReplay && (!sensitiveHeaders.length || allowSensitive)
                ? config.backupCorsServers.filter(server =>
                      isAllowedTarget(server.origin, originUrl, {
                          ...config,
                          allowedTargetHosts: []
                      })
                  )
                : [];
        const targets = [{ url: targetUrl, mode: "direct" }];
        let resolvedBackups = false;
        const resolveBackups = async () => {
            if (resolvedBackups || !budget.remaining) return;
            resolvedBackups = true;
            if (backupServers.length)
                targets.push(
                    ...(await buildBackupAttemptTargets(cacheEnv, ctx, targetUrl, backupServers))
                );
        };
        const canRetry = (attemptIndex, status) =>
            canReplay &&
            budget.remaining > 0 &&
            (attemptIndex + 1 < targets.length ||
                (status !== 403 && attemptIndex < config.maxRetryAttempts));

        for (let attemptIndex = 0; ; attemptIndex++) {
            const target = targets[Math.min(attemptIndex, targets.length - 1)];
            const attemptHeaders = new Headers(headers);
            if (target.backupHeaders) {
                for (const [name, value] of Object.entries(target.backupHeaders))
                    attemptHeaders.set(name, value);
            }
            attemptHeaders.set("x-cors-proxy-hop", "1");
            if (target.mode === "backup")
                console.log(`Using backup server: ${sanitizeUrlForLog(target.backupServer)}`);
            if (attemptIndex >= targets.length)
                await new Promise(resolve => setTimeout(resolve, 500));

            let response;
            try {
                response = await fetchWithPolicy(
                    new Request(target.url, {
                        method: request.method,
                        headers: attemptHeaders,
                        body,
                        redirect: "manual",
                        signal: budget.signal
                    }),
                    { budget, config, originUrl, isBackup: target.mode === "backup" }
                );
            } catch (error) {
                // Policy/time/budget failures are terminal, not a reason to route around protection.
                if (error instanceof ProxyLimitError || budget.signal.aborted) throw error;
                console.warn(
                    `Failed to reach ${target.mode === "direct" ? "target" : "backup"} URL: ${sanitizeUrlForLog(target.url)} | ${sanitizeLogValue(error.message)}`
                );
                if (target.preferred)
                    ctx.waitUntil(clearPreferredBackupServer(cacheEnv, targetUrl));
                await resolveBackups();
                if (canRetry(attemptIndex)) continue;
                throw error;
            }

            if (RETRYABLE_STATUS_CODES.has(response.status)) {
                if (target.preferred)
                    ctx.waitUntil(clearPreferredBackupServer(cacheEnv, targetUrl));
                await resolveBackups();
                if (canRetry(attemptIndex, response.status)) {
                    void response.body?.cancel().catch(() => {});
                    continue;
                }
            } else if (target.mode === "backup" && response.ok) {
                ctx.waitUntil(setPreferredBackupServer(cacheEnv, targetUrl, target.backupServer));
            }

            const responseHeaders = new Headers(response.headers);
            // Untrusted upstream content must not set cookies or execute on the proxy origin.
            for (const name of [
                "set-cookie",
                "set-cookie2",
                "clear-site-data",
                "service-worker-allowed",
                "nel",
                "report-to",
                "reporting-endpoints",
                "refresh",
                "alt-svc"
            ])
                responseHeaders.delete(name);
            const receivedHeaders = Object.fromEntries(responseHeaders.entries());
            applyCorsHeaders(responseHeaders, request);
            responseHeaders.set(
                "Access-Control-Expose-Headers",
                [...Object.keys(receivedHeaders), "cors-received-headers"].join(",")
            );
            responseHeaders.set("cors-received-headers", JSON.stringify(receivedHeaders));
            const responseBody = limitResponseBody(response, budget);
            const result = new Response(responseBody, {
                headers: responseHeaders,
                status: response.status,
                statusText: response.statusText
            });
            streaming = Boolean(responseBody);
            return result;
        }
    } catch (error) {
        if (error instanceof ProxyLimitError)
            return errorResponse(request, error.status, error.message);
        if (budget.signal.aborted) return errorResponse(request, 504, "Proxy request timed out");
        // Upstream exception strings can contain credentials. Do not reflect them to callers.
        return errorResponse(request, 502, "Unable to fetch target URL");
    } finally {
        if (!streaming) budget.close();
    }
}

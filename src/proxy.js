// Forwards an allowed request upstream: direct target first, then backup CORS servers
import { clearPreferredBackupServer, setPreferredBackupServer } from "./backup-cache.js";
import { buildBackupAttemptTargets, getSensitiveHeadersForBackup } from "./backup-targets.js";
import { buildUpstreamHeaders } from "./browser-headers.js";
import { applyCorsHeaders } from "./cors.js";
import { sanitizeLogValue, sanitizeUrlForLog } from "./log-redaction.js";

const RETRYABLE_STATUS_CODES = new Set([403, 429, 502, 503]);
// Methods that are safe to send to the same target more than once (RFC 9110 §9.2.2)
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

function isRetryableStatusCode(statusCode) {
    return RETRYABLE_STATUS_CODES.has(statusCode);
}

export async function proxyRequest({
    request,
    env,
    ctx,
    config,
    originUrl,
    targetUrl,
    customHeaders,
    startTime
}) {
    const allowSensitiveBackup = originUrl.searchParams.get("allowSensitive") === "true";
    const filteredHeaders = buildUpstreamHeaders(request, targetUrl, customHeaders);

    const requestMethod = request.method;
    const normalizedMethod = requestMethod.toUpperCase();

    // Read body once so it can be replayed across retries and backup servers
    const hasRequestBody = !["GET", "HEAD"].includes(normalizedMethod);
    const requestBody = hasRequestBody ? await request.arrayBuffer() : null;

    // Sending the same request to the same target twice is only safe for idempotent methods.
    // Non-idempotent methods (POST, PATCH) still fail over to other targets.
    const canRepeatSameTarget = IDEMPOTENT_METHODS.has(normalizedMethod);

    const candidateBackupServers = config.backupCorsServers.filter(
        server => server.origin !== originUrl.origin
    );
    const sensitiveHeaders =
        candidateBackupServers.length > 0
            ? getSensitiveHeadersForBackup(request, customHeaders)
            : [];

    // The direct target is always tried first. Backup targets (and the KV lookup for the
    // preferred backup) are only resolved once the direct attempt has failed.
    const attemptTargets = [{ url: targetUrl, mode: "direct" }];
    let backupTargetsResolved = false;

    const resolveBackupTargets = async () => {
        if (backupTargetsResolved) {
            return;
        }
        backupTargetsResolved = true;

        if (candidateBackupServers.length === 0) {
            return;
        }

        if (sensitiveHeaders.length > 0) {
            if (!allowSensitiveBackup) {
                console.warn(
                    `[${new Date().toISOString()}] 🚫 Backup servers skipped due to sensitive request headers: ${sensitiveHeaders.join(
                        ", "
                    )} | Target: ${sanitizeUrlForLog(targetUrl)}`
                );
                return;
            }

            console.warn(
                `[${new Date().toISOString()}] ⚠️  Sensitive headers allowed for backup because allowSensitive=true. Headers: ${sensitiveHeaders.join(
                    ", "
                )} | Target: ${sanitizeUrlForLog(targetUrl)}`
            );
        }

        attemptTargets.push(
            ...(await buildBackupAttemptTargets(env, ctx, targetUrl, candidateBackupServers))
        );
    };

    // Decide whether another attempt should follow a failed one
    const canAttemptAgain = (attemptIndex, failedStatus) => {
        const nextAttemptIndex = attemptIndex + 1;
        if (nextAttemptIndex < attemptTargets.length) {
            // An untried target is still available
            return true;
        }

        // Only repeats against the same target remain. A 403 is rarely transient,
        // and non-idempotent methods must not be replayed against the same target.
        if (!canRepeatSameTarget || failedStatus === 403) {
            return false;
        }

        return nextAttemptIndex <= config.maxRetryAttempts;
    };

    const createAttemptRequest = attemptTarget => {
        const attemptHeaders = { ...filteredHeaders };
        if (attemptTarget.mode === "backup" && attemptTarget.backupHeaders) {
            Object.assign(attemptHeaders, attemptTarget.backupHeaders);
        }

        return new Request(attemptTarget.url, {
            method: requestMethod,
            headers: attemptHeaders,
            body: hasRequestBody ? requestBody : null,
            redirect: "follow"
        });
    };

    try {
        for (let attemptIndex = 0; ; attemptIndex++) {
            const targetIndex = Math.min(attemptIndex, attemptTargets.length - 1);
            const currentAttemptTarget = attemptTargets[targetIndex];
            const isPreferredBackup =
                currentAttemptTarget.mode === "backup" && currentAttemptTarget.preferred;

            if (currentAttemptTarget.mode === "backup") {
                console.log(
                    `[${new Date().toISOString()}] ℹ️  Using backup server: ${
                        sanitizeUrlForLog(currentAttemptTarget.backupServer)
                    } | Target: ${sanitizeUrlForLog(targetUrl)}`
                );
            }

            // Apply backoff delay when retrying the same server (exhausted all unique targets)
            if (attemptIndex >= attemptTargets.length) {
                const backoffMs = Math.min(
                    500 * (attemptIndex - attemptTargets.length + 1),
                    2000
                );
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }

            let response;
            try {
                response = await fetch(createAttemptRequest(currentAttemptTarget));
            } catch (error) {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Failed to reach ${
                        currentAttemptTarget.mode === "direct" ? "target" : "backup"
                    } URL: ${sanitizeUrlForLog(currentAttemptTarget.url)} | Error: ${
                        sanitizeLogValue(error.message)
                    } | Attempt: ${attemptIndex + 1}`
                );

                if (isPreferredBackup) {
                    ctx.waitUntil(
                        clearPreferredBackupServer(
                            env,
                            targetUrl,
                            `preferred backup server network failure (${sanitizeLogValue(
                                error.message
                            )})`
                        )
                    );
                }

                await resolveBackupTargets();
                if (canAttemptAgain(attemptIndex)) {
                    continue;
                }

                throw error;
            }

            if (isRetryableStatusCode(response.status)) {
                if (isPreferredBackup) {
                    ctx.waitUntil(
                        clearPreferredBackupServer(
                            env,
                            targetUrl,
                            `preferred backup server returned retryable status ${response.status}`
                        )
                    );
                }

                await resolveBackupTargets();
                if (canAttemptAgain(attemptIndex, response.status)) {
                    // Ensure body stream is closed before retrying
                    if (response.body) {
                        response.body.cancel();
                    }
                    continue;
                }
            } else if (currentAttemptTarget.mode === "backup") {
                ctx.waitUntil(
                    setPreferredBackupServer(
                        env,
                        targetUrl,
                        currentAttemptTarget.backupServer
                    )
                );
            }

            const responseHeaders = new Headers(response.headers);
            const exposedHeaders = Array.from(response.headers.keys());
            const allResponseHeaders = Object.fromEntries(response.headers.entries());

            exposedHeaders.push("cors-received-headers");
            applyCorsHeaders(responseHeaders, request);

            responseHeaders.set("Access-Control-Expose-Headers", exposedHeaders.join(","));
            responseHeaders.set(
                "cors-received-headers",
                JSON.stringify(allResponseHeaders)
            );

            // Keep only essential upstream failure logs.
            if (response.status >= 500) {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Upstream server error: ${sanitizeUrlForLog(
                        targetUrl
                    )} | Status: ${response.status} ${
                        response.statusText
                    } | Duration: ${Date.now() - startTime}ms | Method: ${request.method}`
                );
            }

            // Stream the body through instead of buffering it: lower time-to-first-byte,
            // bounded memory, and SSE / chunked responses keep working.
            return new Response(response.body, {
                headers: responseHeaders,
                status: response.status,
                statusText: response.statusText
            });
        }
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(
            `[${new Date().toISOString()}] ❌ Error fetching ${sanitizeUrlForLog(
                targetUrl
            )}: ${sanitizeLogValue(error.message)} | Duration: ${duration}ms | Stack: ${sanitizeLogValue(
                error.stack
            )}`
        );

        const errorHeaders = new Headers();
        applyCorsHeaders(errorHeaders, request);
        return new Response(
            `Error fetching target URL: ${sanitizeLogValue(error.message)}`,
            {
                status: 502,
                statusText: "Bad Gateway",
                headers: errorHeaders
            }
        );
    }
}

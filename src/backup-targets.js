// Ordering and URL building for backup CORS servers
import { clearPreferredBackupServer, getPreferredBackupServer } from "./backup-cache.js";

let backupServerRotationCursor = 0;

function buildBackupTargetUrl(backupCorsServer, destinationUrl) {
    // Backup format: server URL contains a {url} placeholder.
    // Example: https://backup.server.com/?url={url}
    // URL-encode the destination to prevent query parameter corruption
    // e.g. target "https://api.com/data?key=1&fmt=json" won't break the backup URL structure
    const encodedDestinationUrl = encodeURIComponent(destinationUrl);
    return backupCorsServer
        .replaceAll("{url}", encodedDestinationUrl)
        .replace(/%7Burl%7D/gi, encodedDestinationUrl);
}

function rotateArray(values, startIndex) {
    if (!Array.isArray(values) || values.length === 0) {
        return [];
    }

    const normalizedStartIndex = ((startIndex % values.length) + values.length) % values.length;
    return [...values.slice(normalizedStartIndex), ...values.slice(0, normalizedStartIndex)];
}

function getNextBackupRotationStart(totalServers) {
    if (!Number.isInteger(totalServers) || totalServers <= 0) {
        return 0;
    }

    const startIndex = backupServerRotationCursor % totalServers;
    backupServerRotationCursor = (backupServerRotationCursor + 1) % Number.MAX_SAFE_INTEGER;
    return startIndex;
}

export function getSensitiveHeadersForBackup(request, customHeaders) {
    const sensitiveHeaderNames = new Set([
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "x-auth-token",
        "x-access-token"
    ]);

    const detectedHeaders = [];

    for (const [key] of request.headers.entries()) {
        if (sensitiveHeaderNames.has(key.toLowerCase())) {
            detectedHeaders.push(key);
        }
    }

    if (customHeaders && typeof customHeaders === "object") {
        for (const key of Object.keys(customHeaders)) {
            if (sensitiveHeaderNames.has(String(key).toLowerCase())) {
                detectedHeaders.push(key);
            }
        }
    }

    return detectedHeaders;
}

/**
 * Build the ordered list of backup attempt targets for a target URL.
 * The KV-preferred server (if still configured) goes first; the others rotate per request.
 */
export async function buildBackupAttemptTargets(env, ctx, targetUrl, backupServers) {
    let prioritizedBackupServers = [...backupServers];
    let preferredBackupCacheHit = false;
    let preferredBackupServer = await getPreferredBackupServer(env, targetUrl, ctx);

    if (preferredBackupServer) {
        const preferredIndex = prioritizedBackupServers.findIndex(
            server => server.template === preferredBackupServer
        );
        if (preferredIndex >= 0) {
            const [preferredServerConfig] = prioritizedBackupServers.splice(preferredIndex, 1);
            prioritizedBackupServers.unshift(preferredServerConfig);
            preferredBackupCacheHit = true;
        } else {
            ctx.waitUntil(
                clearPreferredBackupServer(
                    env,
                    targetUrl,
                    "cached server is no longer in BACKUP_CORS_SERVERS"
                )
            );
            preferredBackupServer = null;
        }
    }

    if (prioritizedBackupServers.length > 1) {
        if (preferredBackupCacheHit) {
            const [pinnedPreferredServer, ...nonPreferredServers] = prioritizedBackupServers;

            if (nonPreferredServers.length > 1) {
                const rotationStartIndex = getNextBackupRotationStart(nonPreferredServers.length);
                prioritizedBackupServers = [
                    pinnedPreferredServer,
                    ...rotateArray(nonPreferredServers, rotationStartIndex)
                ];
            }
        } else {
            const rotationStartIndex = getNextBackupRotationStart(prioritizedBackupServers.length);
            prioritizedBackupServers = rotateArray(prioritizedBackupServers, rotationStartIndex);
        }
    }

    return prioritizedBackupServers.map(server => ({
        url: buildBackupTargetUrl(server.template, targetUrl),
        mode: "backup",
        backupServer: server.template,
        backupHeaders: server.headers,
        preferred: preferredBackupCacheHit && server.template === preferredBackupServer
    }));
}

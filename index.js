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
const DEFAULT_BACKUP_CORS_SERVERS = []; // backup CORS proxy servers
const DEFAULT_MAX_RETRY_ATTEMPTS = 3; // number of retries after the initial direct attempt
const DEFAULT_VERSION = PACKAGE_VERSION; // Version from package.json (auto-generated)
const RETRYABLE_STATUS_CODES = new Set([403, 429, 502, 503]);
const PREFERRED_BACKUP_TTL_SECONDS = 15 * 60; // 15 minutes
const PREFERRED_BACKUP_KV_KEY_PREFIX = "backup-preference:";
let backupServerRotationCursor = 0;
const LOG_REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_LOG_QUERY_PARAM_EXACT_NAMES = new Set([
    "key",
    "token",
    "auth",
    "password",
    "passwd",
    "secret",
    "signature",
    "sig",
    "jwt"
]);
const SENSITIVE_LOG_QUERY_PARAM_SUFFIXES = [
    "apikey",
    "accesstoken",
    "refreshtoken",
    "authtoken",
    "clientsecret",
    "clienttoken",
    "bearertoken",
    "sessiontoken",
    "privatekey"
];

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

function parseBackupCorsServers(rawBackupServers) {
    if (Array.isArray(rawBackupServers)) {
        return rawBackupServers;
    }

    if (typeof rawBackupServers !== "string") {
        return [];
    }

    const trimmed = rawBackupServers.trim();
    if (!trimmed) {
        return [];
    }

    // Preferred format: JSON array
    if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
            throw new Error("BACKUP_CORS_SERVERS JSON must be an array");
        }
        return parsed;
    }

    // Compatibility: quoted list without []
    // Example: "https://a?url={url}","https://b?url={url}"
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.includes('","')) {
        const parsed = JSON.parse(`[${trimmed}]`);
        if (!Array.isArray(parsed)) {
            throw new Error("BACKUP_CORS_SERVERS quoted list must be an array");
        }
        return parsed;
    }

    // Compatibility: comma/newline separated plain URLs
    return trimmed
        .split(/\r?\n|,/)
        .map(entry => entry.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
}

function normalizeBackupCorsHeaders(rawHeaders, indexForError) {
    if (rawHeaders === undefined || rawHeaders === null) {
        return {};
    }

    if (typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
        throw new Error(
            `BACKUP_CORS_SERVERS[${indexForError}].headers must be an object of string pairs`
        );
    }

    const normalizedHeaders = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
        const normalizedKey = String(key).trim();
        if (!normalizedKey) {
            continue;
        }

        if (value === undefined || value === null) {
            continue;
        }

        normalizedHeaders[normalizedKey] = String(value);
    }

    return normalizedHeaders;
}

function isSensitiveLogQueryParamName(paramName) {
    const normalizedName = String(paramName)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    return (
        SENSITIVE_LOG_QUERY_PARAM_EXACT_NAMES.has(normalizedName) ||
        SENSITIVE_LOG_QUERY_PARAM_SUFFIXES.some(suffix => normalizedName.endsWith(suffix))
    );
}

function replaceEncodedRedactionPlaceholder(value) {
    return value.replace(/%5BREDACTED%5D/gi, LOG_REDACTED_VALUE);
}

function redactQueryStringForLog(value) {
    return String(value).replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, prefix, name) => {
        if (!isSensitiveLogQueryParamName(name)) {
            return match;
        }

        return `${prefix}${name}=${LOG_REDACTED_VALUE}`;
    });
}

function sanitizeUrlForLog(value, depth = 0) {
    const rawValue = typeof value === "string" ? value : String(value ?? "");

    if (!rawValue) {
        return rawValue;
    }

    try {
        const url = new URL(rawValue);
        let changed = false;

        if (url.username) {
            url.username = LOG_REDACTED_VALUE;
            changed = true;
        }

        if (url.password) {
            url.password = LOG_REDACTED_VALUE;
            changed = true;
        }

        const paramNames = Array.from(new Set(url.searchParams.keys()));

        for (const paramName of paramNames) {
            const values = url.searchParams.getAll(paramName);

            if (isSensitiveLogQueryParamName(paramName)) {
                url.searchParams.delete(paramName);
                values.forEach(() => url.searchParams.append(paramName, LOG_REDACTED_VALUE));
                changed = true;
                continue;
            }

            if (depth >= 2) {
                continue;
            }

            const sanitizedValues = values.map(paramValue =>
                /^https?:\/\//i.test(paramValue)
                    ? sanitizeUrlForLog(paramValue, depth + 1)
                    : paramValue
            );

            if (sanitizedValues.some((paramValue, index) => paramValue !== values[index])) {
                url.searchParams.delete(paramName);
                sanitizedValues.forEach(paramValue =>
                    url.searchParams.append(paramName, paramValue)
                );
                changed = true;
            }
        }

        if (!changed) {
            return rawValue;
        }

        return replaceEncodedRedactionPlaceholder(url.toString());
    } catch (error) {
        return redactQueryStringForLog(rawValue);
    }
}

function sanitizeLogValue(value) {
    return String(value ?? "").replace(/https?:\/\/[^\s"'<>]+/gi, matchedUrl =>
        sanitizeUrlForLog(matchedUrl)
    );
}

function normalizeBackupCorsServerEntries(parsedBackupServers) {
    if (!Array.isArray(parsedBackupServers)) {
        return [];
    }

    const normalizedServers = [];
    const seenTemplates = new Set();

    parsedBackupServers.forEach((serverEntry, index) => {
        let rawTemplate = "";
        let rawHeaders = null;

        if (typeof serverEntry === "string") {
            rawTemplate = serverEntry;
        } else if (serverEntry && typeof serverEntry === "object" && !Array.isArray(serverEntry)) {
            rawTemplate =
                typeof serverEntry.url === "string"
                    ? serverEntry.url
                    : typeof serverEntry.server === "string"
                    ? serverEntry.server
                    : "";
            rawHeaders = serverEntry.headers;
        } else {
            return;
        }

        const trimmedTemplate = rawTemplate.trim();
        if (!trimmedTemplate) {
            return;
        }

        const normalizedTemplate = trimmedTemplate.match(/^https?:\/\//i)
            ? trimmedTemplate
            : `https://${trimmedTemplate}`;
        const validationUrl = normalizedTemplate.replaceAll("{url}", "https://example.com");
        try {
            new URL(validationUrl);
        } catch (e) {
            console.warn(
                `[${new Date().toISOString()}] ⚠️  Skipping invalid backup server URL at index ${index}: ${sanitizeUrlForLog(
                    trimmedTemplate
                )} (${sanitizeLogValue(e.message)})`
            );
            return;
        }

        const templateWithoutTrailingSlash = normalizedTemplate.replace(/\/+$/, "");
        if (seenTemplates.has(templateWithoutTrailingSlash)) {
            return;
        }
        seenTemplates.add(templateWithoutTrailingSlash);

        normalizedServers.push({
            template: templateWithoutTrailingSlash,
            headers: normalizeBackupCorsHeaders(rawHeaders, index)
        });
    });

    return normalizedServers;
}

/**
 * Get configuration from Cloudflare Secrets or environment variables, with fallback to defaults
 *
 * Configuration values should be JSON arrays:
 * - BLACKLIST_URLS: JSON array of regex patterns for blacklisted URLs
 * - WHITELIST_ORIGINS: JSON array of regex patterns for whitelisted origins
 * - BACKUP_CORS_SERVERS: JSON array of backup CORS proxy templates or config objects
 * - MAX_RETRY_ATTEMPTS: non-negative integer retry count after first attempt
 *
 * Priority order (highest to lowest):
 * 1. Direct secrets (env.BLACKLIST_URLS) - set via wrangler secret put
 * 2. Environment variables (env.BLACKLIST_URLS) - from wrangler.toml [vars]
 * 3. Default values
 *
 * Setup using Cloudflare Secrets (recommended for security):
 *   wrangler secret put BLACKLIST_URLS
 *   wrangler secret put WHITELIST_ORIGINS
 *   wrangler secret put BACKUP_CORS_SERVERS
 *   wrangler secret put MAX_RETRY_ATTEMPTS
 *
 * Or using wrangler.toml [vars] section (for non-sensitive config):
 *   [vars]
 *   BLACKLIST_URLS = '["^https?://malicious\\.com"]'
 *   WHITELIST_ORIGINS = '["^https://example\\.com$"]'
 *   BACKUP_CORS_SERVERS = '["https://backup-1.workers.dev/?url={url}", {"url":"https://backup-2.workers.dev/?url={url}","headers":{"x-cors-api-key":"token"}}]'
 *   MAX_RETRY_ATTEMPTS = '3'
 *
 * Secrets take precedence over vars if both are set.
 */
function getConfig(env) {
    let blacklistUrls = DEFAULT_BLACKLIST_URLS;
    let whitelistOrigins = DEFAULT_WHITELIST_ORIGINS;
    const defaultNormalizedBackupCorsServers = normalizeBackupCorsServerEntries(
        DEFAULT_BACKUP_CORS_SERVERS
    );
    let backupCorsServers = defaultNormalizedBackupCorsServers;
    let maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS;

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

        // Parse backup CORS servers from env var (JSON array)
        // Supports both BACKUP_CORS_SERVERS (preferred) and legacy DEFAULT_BACKUP_CORS_SERVERS.
        const rawBackupServers = env.BACKUP_CORS_SERVERS ?? env.DEFAULT_BACKUP_CORS_SERVERS;
        if (
            rawBackupServers !== undefined &&
            rawBackupServers !== null &&
            rawBackupServers !== ""
        ) {
            try {
                if (!env.BACKUP_CORS_SERVERS && env.DEFAULT_BACKUP_CORS_SERVERS) {
                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  Using legacy env key DEFAULT_BACKUP_CORS_SERVERS; prefer BACKUP_CORS_SERVERS`
                    );
                }

                const parsedBackupServers = parseBackupCorsServers(rawBackupServers);

                if (!Array.isArray(parsedBackupServers)) {
                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  BACKUP_CORS_SERVERS must be a JSON array, using default`
                    );
                    backupCorsServers = defaultNormalizedBackupCorsServers;
                } else {
                    backupCorsServers = normalizeBackupCorsServerEntries(parsedBackupServers);
                }
            } catch (e) {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  Failed to parse BACKUP_CORS_SERVERS from env: ${
                        e.message
                    }. Supported formats: JSON array (string URLs or {url,headers} objects), quoted list, comma/newline separated URLs. Using default`
                );
                backupCorsServers = defaultNormalizedBackupCorsServers;
            }
        }

        // Parse max retry attempts from env var (non-negative integer)
        if (env.MAX_RETRY_ATTEMPTS !== undefined) {
            const parsedMaxRetryAttempts = Number.parseInt(env.MAX_RETRY_ATTEMPTS, 10);
            if (Number.isInteger(parsedMaxRetryAttempts) && parsedMaxRetryAttempts >= 0) {
                maxRetryAttempts = parsedMaxRetryAttempts;
            } else {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  MAX_RETRY_ATTEMPTS must be a non-negative integer, using default`
                );
                maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS;
            }
        }
    }

    return { blacklistUrls, whitelistOrigins, backupCorsServers, maxRetryAttempts };
}

function isRetryableStatusCode(statusCode) {
    return RETRYABLE_STATUS_CODES.has(statusCode);
}

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

function getPreferredBackupScope(targetUrl) {
    const normalizedTargetUrl = typeof targetUrl === "string" ? targetUrl.trim() : "";
    if (!normalizedTargetUrl) {
        return "";
    }

    try {
        return new URL(normalizedTargetUrl).hostname.toLowerCase();
    } catch (error) {
        return normalizedTargetUrl.toLowerCase();
    }
}

function buildPreferredBackupCacheKey(targetUrl) {
    const targetDomain = getPreferredBackupScope(targetUrl);
    return `${PREFERRED_BACKUP_KV_KEY_PREFIX}${encodeURIComponent(targetDomain)}`;
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

function getSensitiveHeadersForBackup(request, customHeaders) {
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

const localBackupCache = new Map();
const MAX_LOCAL_CACHE_SIZE = 5000;
const LOCAL_CACHE_PRUNE_THRESHOLD = Math.floor(MAX_LOCAL_CACHE_SIZE * 1.2);
const KV_NEGATIVE_SENTINEL = "__none__";
const NEGATIVE_KV_TTL_SECONDS = 5 * 60; // 5 minutes for negative cache in KV
const STALE_GRACE_MS = 30 * 1000; // serve stale for 30s while revalidating

/**
 * Prune expired entries from local cache when it grows too large.
 * Uses a lazy approach: only prune when exceeding threshold.
 */
function pruneLocalCache() {
    if (localBackupCache.size < LOCAL_CACHE_PRUNE_THRESHOLD) {
        return;
    }
    const now = Date.now();
    for (const [key, item] of localBackupCache) {
        if (now > item.exp) {
            localBackupCache.delete(key);
        }
    }
    // If still over limit after pruning expired entries, evict oldest
    if (localBackupCache.size >= MAX_LOCAL_CACHE_SIZE) {
        const keysIter = localBackupCache.keys();
        const toEvict = localBackupCache.size - Math.floor(MAX_LOCAL_CACHE_SIZE * 0.8);
        for (let i = 0; i < toEvict; i++) {
            const key = keysIter.next().value;
            if (key !== undefined) localBackupCache.delete(key);
        }
    }
}

function setLocalCache(key, value, ttlMillis) {
    pruneLocalCache();
    localBackupCache.set(key, {
        value,
        exp: Date.now() + ttlMillis,
        kvValue: undefined  // tracks last-known KV value to skip redundant writes
    });
}

/**
 * Set local cache with known KV value tracking.
 * This avoids redundant KV writes when the value hasn't changed.
 */
function setLocalCacheWithKvTracking(key, value, ttlMillis, kvValue) {
    pruneLocalCache();
    localBackupCache.set(key, {
        value,
        exp: Date.now() + ttlMillis,
        kvValue  // what we know is stored in KV
    });
}

function getLocalCache(key) {
    const item = localBackupCache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.exp) {
        localBackupCache.delete(key);
        return undefined;
    }
    return item.value;
}

/**
 * Get local cache entry with stale support.
 * Returns { value, isStale } if entry exists (even if expired within grace period).
 * Returns undefined if no entry or expired beyond grace.
 */
function getLocalCacheWithStale(key) {
    const item = localBackupCache.get(key);
    if (!item) return undefined;
    const now = Date.now();
    if (now <= item.exp) {
        return { value: item.value, isStale: false, kvValue: item.kvValue };
    }
    // Within stale grace period — return stale value but flag for revalidation
    if (now <= item.exp + STALE_GRACE_MS) {
        return { value: item.value, isStale: true, kvValue: item.kvValue };
    }
    // Beyond grace period — treat as miss
    localBackupCache.delete(key);
    return undefined;
}

/**
 * Get preferred backup server with stale-while-revalidate pattern.
 * Returns the preferred server template string or null.
 * Uses local cache as primary, KV as secondary.
 * Stale local values are returned immediately while KV is refreshed in background.
 */
async function getPreferredBackupServer(env, targetUrl, ctx) {
    try {
        const cacheKey = buildPreferredBackupCacheKey(targetUrl);

        // Check local cache first (including stale entries)
        const localEntry = getLocalCacheWithStale(cacheKey);
        if (localEntry && !localEntry.isStale) {
            // Fresh local hit — skip KV entirely
            return localEntry.value === "" ? null : localEntry.value;
        }

        const backupServerCache = env?.BACKUP_SERVER_CACHE;
        if (!backupServerCache || typeof backupServerCache.get !== "function") {
            // No KV binding — return stale if available, else null
            return localEntry ? (localEntry.value === "" ? null : localEntry.value) : null;
        }

        // If we have a stale local value, return it immediately and revalidate in background
        if (localEntry && localEntry.isStale) {
            if (ctx) {
                ctx.waitUntil(
                    revalidateFromKV(backupServerCache, cacheKey).catch(() => {})
                );
            }
            return localEntry.value === "" ? null : localEntry.value;
        }

        // Local cache miss — must read from KV (blocking)
        const cachedValue = await backupServerCache.get(cacheKey);
        const trimmedValue = typeof cachedValue === "string" ? cachedValue.trim() : "";

        if (trimmedValue === KV_NEGATIVE_SENTINEL) {
            // KV negative cache hit — store locally and return null
            setLocalCacheWithKvTracking(cacheKey, "", NEGATIVE_KV_TTL_SECONDS * 1000, KV_NEGATIVE_SENTINEL);
            return null;
        }

        if (trimmedValue) {
            setLocalCacheWithKvTracking(cacheKey, trimmedValue, PREFERRED_BACKUP_TTL_SECONDS * 1000, trimmedValue);
            return trimmedValue;
        }

        // No value in KV — negative cache locally for 2 min (shorter since we haven't written to KV yet)
        setLocalCacheWithKvTracking(cacheKey, "", 2 * 60 * 1000, undefined);
        return null;
    } catch (error) {
        const targetDomain = getPreferredBackupScope(targetUrl);
        console.warn(
            `[${new Date().toISOString()}] ⚠️  Failed to read preferred backup cache for ${targetDomain ||
                sanitizeUrlForLog(targetUrl)}: ${sanitizeLogValue(error.message)}`
        );
        return null;
    }
}

/**
 * Background revalidation: reads from KV and updates local cache.
 */
async function revalidateFromKV(backupServerCache, cacheKey) {
    const cachedValue = await backupServerCache.get(cacheKey);
    const trimmedValue = typeof cachedValue === "string" ? cachedValue.trim() : "";

    if (trimmedValue === KV_NEGATIVE_SENTINEL) {
        setLocalCacheWithKvTracking(cacheKey, "", NEGATIVE_KV_TTL_SECONDS * 1000, KV_NEGATIVE_SENTINEL);
    } else if (trimmedValue) {
        setLocalCacheWithKvTracking(cacheKey, trimmedValue, PREFERRED_BACKUP_TTL_SECONDS * 1000, trimmedValue);
    } else {
        setLocalCacheWithKvTracking(cacheKey, "", 2 * 60 * 1000, undefined);
    }
}

/**
 * Set preferred backup server — skips KV write if value hasn't changed.
 * Also stores negative sentinel in KV when clearing, to help other isolates.
 */
async function setPreferredBackupServer(env, targetUrl, backupCorsServer) {
    try {
        const cacheKey = buildPreferredBackupCacheKey(targetUrl);

        // Check if KV already has this value (tracked locally)
        const localEntry = getLocalCacheWithStale(cacheKey);
        const alreadyInKV = localEntry && localEntry.kvValue === backupCorsServer;

        // Always update local cache
        setLocalCacheWithKvTracking(
            cacheKey,
            backupCorsServer,
            PREFERRED_BACKUP_TTL_SECONDS * 1000,
            alreadyInKV ? backupCorsServer : undefined
        );

        // Skip KV write if we know KV already has the same value
        if (alreadyInKV) {
            return;
        }

        const backupServerCache = env?.BACKUP_SERVER_CACHE;
        if (!backupServerCache || typeof backupServerCache.put !== "function") {
            return;
        }

        await backupServerCache.put(cacheKey, backupCorsServer, {
            expirationTtl: PREFERRED_BACKUP_TTL_SECONDS
        });

        // Update kvValue tracking after successful write
        const updatedEntry = localBackupCache.get(cacheKey);
        if (updatedEntry) {
            updatedEntry.kvValue = backupCorsServer;
        }
    } catch (error) {
        const targetDomain = getPreferredBackupScope(targetUrl);
        console.warn(
            `[${new Date().toISOString()}] ⚠️  Failed to write preferred backup cache for ${targetDomain ||
                sanitizeUrlForLog(targetUrl)}: ${sanitizeLogValue(error.message)}`
        );
    }
}

/**
 * Clear preferred backup server.
 * Instead of deleting from KV (which costs a write), we write a negative sentinel.
 * This helps other isolates avoid repeated KV reads for the same domain.
 * The sentinel has a shorter TTL so it auto-expires faster.
 */
async function clearPreferredBackupServer(env, targetUrl, reason = "") {
    try {
        const cacheKey = buildPreferredBackupCacheKey(targetUrl);

        // Check if already cleared locally to skip redundant KV writes
        const localEntry = getLocalCacheWithStale(cacheKey);
        const alreadyCleared = localEntry && localEntry.value === "" &&
            localEntry.kvValue === KV_NEGATIVE_SENTINEL;

        // Set local cache to empty (cleared)
        setLocalCacheWithKvTracking(cacheKey, "", NEGATIVE_KV_TTL_SECONDS * 1000, 
            alreadyCleared ? KV_NEGATIVE_SENTINEL : undefined);

        if (alreadyCleared) {
            // Already cleared in KV — skip the write
            return;
        }

        const backupServerCache = env?.BACKUP_SERVER_CACHE;
        if (!backupServerCache || typeof backupServerCache.put !== "function") {
            return;
        }

        const targetDomain = getPreferredBackupScope(targetUrl);

        // Write negative sentinel instead of delete — saves a read for other isolates
        await backupServerCache.put(cacheKey, KV_NEGATIVE_SENTINEL, {
            expirationTtl: NEGATIVE_KV_TTL_SECONDS
        });

        // Update tracking
        const updatedEntry = localBackupCache.get(cacheKey);
        if (updatedEntry) {
            updatedEntry.kvValue = KV_NEGATIVE_SENTINEL;
        }

        if (reason) {
            console.log(
                `[${new Date().toISOString()}] ℹ️  Cleared preferred backup cache for ${targetDomain ||
                    sanitizeUrlForLog(targetUrl)}: ${sanitizeLogValue(reason)}`
            );
        }
    } catch (error) {
        const targetDomain = getPreferredBackupScope(targetUrl);
        console.warn(
            `[${new Date().toISOString()}] ⚠️  Failed to clear preferred backup cache for ${targetDomain ||
                sanitizeUrlForLog(targetUrl)}: ${sanitizeLogValue(error.message)}`
        );
    }
}

// Bot Detection Note:
// Some sites (like Google) use advanced bot detection that may block Cloudflare Workers requests.
// This is due to: IP reputation (data center IPs), TLS fingerprinting, inability to execute
// JavaScript challenges, and no headless browser support. For blocked sites, consider:
// 1. Using external scraping services (ScrapingBee, ScraperAPI, etc.)
// 2. Using official APIs when available
// 3. Deploying on platforms that support headless browsers (Vercel, AWS Lambda, etc.)

// Function to check if a given URI or origin is listed in the whitelist or blacklist
function matchesPatternList(uri, listing) {
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

    return false;
}

// Module worker export - handles all incoming fetch requests
export default {
    async fetch(request, env, ctx) {
        const startTime = Date.now();
        const isPreflightRequest = request.method === "OPTIONS";

        const originUrl = new URL(request.url);
        const allowSensitiveBackup = originUrl.searchParams.get("allowSensitive") === "true";

        // Load configuration from environment variables (with fallback to defaults)
        const config = getConfig(env);
        const versionMeta = getVersionMetadata(env);
        const { version, versionId, versionTag, versionTimestamp } = versionMeta;

        // Log incoming request
        const originHeader = request.headers.get("Origin");
        const connectingIp = request.headers.get("CF-Connecting-IP");
        const country = request.cf?.country;
        const colo = request.cf?.colo;

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

        // Parse custom headers (used in both proxy and info page)
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

        // Handle OPTIONS preflight requests early - don't forward to target URL
        if (isPreflightRequest) {
            // Validate origin and target URL exist
            if (
                targetUrl &&
                !matchesPatternList(targetUrl, config.blacklistUrls) &&
                matchesPatternList(originHeader, config.whitelistOrigins)
            ) {
                const preflightHeaders = new Headers();
                setupCORSHeaders(preflightHeaders);

                // Add Access-Control-Max-Age for preflight caching (24 hours)
                // This allows browsers to cache the preflight response and avoid repeated OPTIONS requests
                preflightHeaders.set("Access-Control-Max-Age", "86400");

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
                    `[${new Date().toISOString()}] ⚠️  Preflight blocked: URL not whitelisted or origin not allowed | Target: ${
                        targetUrl ? sanitizeUrlForLog(targetUrl) : "none"
                    } | Origin: ${originHeader || "none"}`
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
            !matchesPatternList(targetUrl, config.blacklistUrls) &&
            matchesPatternList(originHeader, config.whitelistOrigins)
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

            const requestMethod = request.method;

            // Read body once so it can be replayed across retries and backup servers
            const hasRequestBody = !["GET", "HEAD"].includes(requestMethod.toUpperCase());
            const requestBody = hasRequestBody ? await request.arrayBuffer() : null;

            // Build attempt sequence: direct target first, then backup CORS servers
            const filteredBackupServers = config.backupCorsServers.filter(server => {
                try {
                    return (
                        new URL(buildBackupTargetUrl(server.template, "https://example.com"))
                            .origin !== originUrl.origin
                    );
                } catch (e) {
                    return false;
                }
            });

            let prioritizedBackupServers = [...filteredBackupServers];
            let preferredBackupCacheHit = false;
            let preferredBackupServer = null;

            // Only read KV when backup servers are configured to avoid wasted I/O
            if (filteredBackupServers.length > 0) {
                preferredBackupServer = await getPreferredBackupServer(env, targetUrl, ctx);
                if (preferredBackupServer) {
                    const preferredIndex = prioritizedBackupServers.findIndex(
                        server => server.template === preferredBackupServer
                    );
                    if (preferredIndex >= 0) {
                        const preferredServerConfig = prioritizedBackupServers[preferredIndex];
                        prioritizedBackupServers.splice(preferredIndex, 1);
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
            }

            if (prioritizedBackupServers.length > 1) {
                if (preferredBackupCacheHit) {
                    const pinnedPreferredServer = prioritizedBackupServers[0];
                    const nonPreferredServers = prioritizedBackupServers.slice(1);

                    if (nonPreferredServers.length > 1) {
                        const rotationStartIndex = getNextBackupRotationStart(
                            nonPreferredServers.length
                        );
                        prioritizedBackupServers = [
                            pinnedPreferredServer,
                            ...rotateArray(nonPreferredServers, rotationStartIndex)
                        ];
                    }
                } else {
                    const rotationStartIndex = getNextBackupRotationStart(
                        prioritizedBackupServers.length
                    );
                    prioritizedBackupServers = rotateArray(
                        prioritizedBackupServers,
                        rotationStartIndex
                    );
                }
            }

            let attemptTargets = [
                { url: targetUrl, mode: "direct" },
                ...prioritizedBackupServers.map(server => ({
                    url: buildBackupTargetUrl(server.template, targetUrl),
                    mode: "backup",
                    backupServer: server.template,
                    backupHeaders: server.headers,
                    preferred:
                        preferredBackupCacheHit &&
                        Boolean(preferredBackupServer) &&
                        server.template === preferredBackupServer
                }))
            ];

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
                let lastNetworkError = null;

                const sensitiveHeaders = getSensitiveHeadersForBackup(request, customHeaders);
                const hasSensitiveHeaders = sensitiveHeaders.length > 0;
                const hasBackupTargets = attemptTargets.some(t => t.mode === "backup");

                // Check sensitive header restrictions once before entering the retry loop
                if (hasBackupTargets && hasSensitiveHeaders && !allowSensitiveBackup) {
                    // Strip all backup targets — only direct attempt is allowed
                    const directOnly = attemptTargets.filter(t => t.mode === "direct");
                    attemptTargets.length = 0;
                    attemptTargets.push(...directOnly);

                    console.warn(
                        `[${new Date().toISOString()}] 🚫 Backup servers removed from attempt list due to sensitive request headers: ${sensitiveHeaders.join(
                            ", "
                        )} | Target: ${sanitizeUrlForLog(targetUrl)}`
                    );
                } else if (hasBackupTargets && hasSensitiveHeaders && allowSensitiveBackup) {
                    console.warn(
                        `[${new Date().toISOString()}] ⚠️  Sensitive headers allowed for backup because allowSensitive=true. Headers: ${sensitiveHeaders.join(
                            ", "
                        )} | Target: ${sanitizeUrlForLog(targetUrl)}`
                    );
                }

                // Recalculate max attempts after potential target list trimming
                const effectiveMaxAttempts = Math.max(
                    Math.max(1, config.maxRetryAttempts + 1),
                    attemptTargets.length
                );

                for (let attemptIndex = 0; attemptIndex < effectiveMaxAttempts; attemptIndex++) {
                    const targetIndex = Math.min(attemptIndex, attemptTargets.length - 1);
                    const currentAttemptTarget = attemptTargets[targetIndex];
                    const isLastAttempt = attemptIndex === effectiveMaxAttempts - 1;

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
                        lastNetworkError = error;

                        console.warn(
                            `[${new Date().toISOString()}] ⚠️  Failed to reach ${
                                currentAttemptTarget.mode === "direct" ? "target" : "backup"
                            } URL: ${sanitizeUrlForLog(currentAttemptTarget.url)} | Error: ${
                                sanitizeLogValue(error.message)
                            } | Attempt: ${attemptIndex + 1}/${effectiveMaxAttempts}`
                        );

                        if (
                            currentAttemptTarget.mode === "backup" &&
                            currentAttemptTarget.preferred
                        ) {
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

                        if (!isLastAttempt) {
                            continue;
                        }

                        throw error;
                    }

                    // Retry on selected upstream status codes
                    if (isRetryableStatusCode(response.status) && !isLastAttempt) {
                        if (
                            currentAttemptTarget.mode === "backup" &&
                            currentAttemptTarget.preferred
                        ) {
                            ctx.waitUntil(
                                clearPreferredBackupServer(
                                    env,
                                    targetUrl,
                                    `preferred backup server returned retryable status ${response.status}`
                                )
                            );
                        }

                        // Ensure body stream is closed before retrying
                        if (response.body) {
                            response.body.cancel();
                        }
                        continue;
                    }

                    if (currentAttemptTarget.mode === "backup") {
                        if (!isRetryableStatusCode(response.status)) {
                            ctx.waitUntil(
                                setPreferredBackupServer(
                                    env,
                                    targetUrl,
                                    currentAttemptTarget.backupServer
                                )
                            );
                        }
                    }

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

                    // Check if this is a streaming response (for AI model streaming, SSE, etc.)
                    const isStreaming = shouldStreamResponse(response, request, targetUrl);

                    // For streaming responses, pass through the stream directly
                    // For non-streaming, buffer the response as before for backward compatibility
                    let responseBody;
                    if (isStreaming) {
                        // Pass through the stream directly - don't buffer
                        // This allows Server-Sent Events and chunked streaming to work properly
                        responseBody = response.body;
                    } else {
                        // Buffer the response for non-streaming responses
                        responseBody = await response.arrayBuffer();
                    }

                    const duration = Date.now() - startTime;

                    // Keep only essential upstream failure logs.
                    if (response.status >= 500) {
                        console.warn(
                            `[${new Date().toISOString()}] ⚠️  Upstream server error: ${sanitizeUrlForLog(
                                targetUrl
                            )} | Status: ${response.status} ${
                                response.statusText
                            } | Duration: ${duration}ms | Method: ${request.method}`
                        );
                    }

                    return new Response(responseBody, {
                        headers: responseHeaders,
                        status: response.status,
                        statusText: response.statusText
                    });
                }

                // Should never happen, but keep a deterministic fallback
                throw lastNetworkError || new Error("All upstream attempts failed");
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
                setupCORSHeaders(errorHeaders);
                return new Response(
                    `Error fetching target URL: ${sanitizeLogValue(error.message)}`,
                    {
                        status: 502,
                        statusText: "Bad Gateway",
                        headers: errorHeaders
                    }
                );
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
                `allow sensitive headers for backup: ${originUrl.origin}/?url={targetUrl}&allowSensitive=true`,
                "",
                "Backup:",
                "BACKUP_CORS_SERVERS must contain {url} placeholder",
                'Supports per-backup headers: {"url":"...","headers":{"x-cors-api-key":"..."}}',
                "Retryable statuses: 403 + 502 + 503",
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
        } else {
            console.warn(
                `[${new Date().toISOString()}] ⚠️  Request blocked: URL not whitelisted or origin not allowed | Target: ${sanitizeUrlForLog(
                    targetUrl
                )} | Origin: ${originHeader || "none"}`
            );

            const errorHeaders = new Headers();
            setupCORSHeaders(errorHeaders);
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
    }
};

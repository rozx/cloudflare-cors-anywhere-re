import { sanitizeLogValue, sanitizeUrlForLog } from "./log-redaction.js";

// Configuration: Default values (used as fallback if env vars are unavailable)
const DEFAULT_BLACKLIST_URLS = []; // regexp for blacklisted urls
const DEFAULT_WHITELIST_ORIGINS = [".*"]; // regexp for whitelisted origins
const DEFAULT_BACKUP_CORS_SERVERS = []; // backup CORS proxy servers
const DEFAULT_MAX_RETRY_ATTEMPTS = 0; // retries are opt-in for public deployments

const CONFIG_ENV_KEYS = [
    "BLACKLIST_URLS",
    "WHITELIST_ORIGINS",
    "BACKUP_CORS_SERVERS",
    "DEFAULT_BACKUP_CORS_SERVERS",
    "MAX_RETRY_ATTEMPTS",
    "ENABLE_BACKUP_FALLBACK",
    "ENABLE_BACKUP_KV",
    "ALLOWED_TARGET_HOSTS"
];
let cachedConfig = null;
let cachedConfigSource = null;

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
        let origin;
        try {
            origin = new URL(validationUrl).origin;
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
            origin,
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
 *   MAX_RETRY_ATTEMPTS = '0'
 *
 * Secrets take precedence over vars if both are set.
 *
 * The parsed config is cached per isolate and reused until one of the raw env values changes,
 * so JSON parsing, regex compilation and backup normalization happen once instead of per request.
 */
export function getConfig(env) {
    const source = CONFIG_ENV_KEYS.map(key => env?.[key]);
    if (cachedConfig && cachedConfigSource.every((rawValue, index) => rawValue === source[index])) {
        return cachedConfig;
    }

    cachedConfig = parseConfig(env);
    cachedConfigSource = source;
    return cachedConfig;
}

function compilePatternList(patterns, listName) {
    const compiledPatterns = [];
    for (const pattern of patterns) {
        if (typeof pattern !== "string" || pattern.length > 256) {
            throw new Error(`Invalid ${listName} pattern`);
        }
        compiledPatterns.push(new RegExp(pattern));
    }
    return compiledPatterns;
}

function parseList(raw, fallback) {
    if (raw === undefined) return fallback;
    const parsed = JSON.parse(raw);
    if (
        !Array.isArray(parsed) ||
        parsed.length > 100 ||
        parsed.some(value => typeof value !== "string")
    ) {
        throw new Error("Expected a configuration array of strings");
    }
    return parsed;
}

function parseConfig(env) {
    let blacklistUrls = DEFAULT_BLACKLIST_URLS;
    let whitelistOrigins = DEFAULT_WHITELIST_ORIGINS;
    const defaultNormalizedBackupCorsServers = normalizeBackupCorsServerEntries(
        DEFAULT_BACKUP_CORS_SERVERS
    );
    let backupCorsServers = defaultNormalizedBackupCorsServers;
    let maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS;

    // Try to read from environment variables
    if (env) {
        // Invalid access rules fail closed; never fall back to public access.
        blacklistUrls = parseList(env.BLACKLIST_URLS, DEFAULT_BLACKLIST_URLS);
        whitelistOrigins = parseList(env.WHITELIST_ORIGINS, DEFAULT_WHITELIST_ORIGINS);

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
            const parsedMaxRetryAttempts = Number(env.MAX_RETRY_ATTEMPTS);
            if (Number.isInteger(parsedMaxRetryAttempts) && parsedMaxRetryAttempts >= 0) {
                maxRetryAttempts = Math.min(parsedMaxRetryAttempts, 2);
            } else {
                console.warn(
                    `[${new Date().toISOString()}] ⚠️  MAX_RETRY_ATTEMPTS must be a non-negative integer, using default`
                );
                maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS;
            }
        }
    }

    return {
        blacklistPatterns: compilePatternList(blacklistUrls, "BLACKLIST_URLS"),
        whitelistPatterns: compilePatternList(whitelistOrigins, "WHITELIST_ORIGINS"),
        backupCorsServers:
            env?.ENABLE_BACKUP_FALLBACK === "true" ? backupCorsServers.slice(0, 2) : [],
        enableBackupKv: env?.ENABLE_BACKUP_KV === "true",
        allowedTargetHosts: parseList(env?.ALLOWED_TARGET_HOSTS, []).map(host => {
            const normalized = host.toLowerCase().replace(/\.$/, "");
            if (!/^[a-z0-9.-]+$/.test(normalized) || !normalized.includes(".")) {
                throw new Error("Invalid ALLOWED_TARGET_HOSTS entry");
            }
            return normalized;
        }),
        maxRetryAttempts
    };
}

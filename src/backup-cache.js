// Preferred backup server per target domain: in-memory cache in front of KV

import { sanitizeLogValue, sanitizeUrlForLog } from "./log-redaction.js";

const PREFERRED_BACKUP_TTL_SECONDS = 15 * 60; // 15 minutes
const PREFERRED_BACKUP_KV_KEY_PREFIX = "backup-preference:";

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
export async function getPreferredBackupServer(env, targetUrl, ctx) {
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
export async function setPreferredBackupServer(env, targetUrl, backupCorsServer) {
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
export async function clearPreferredBackupServer(env, targetUrl, reason = "") {
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

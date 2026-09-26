// Import version from package.json (auto-generated file)
import { VERSION as PACKAGE_VERSION } from "../version.js";

const DEFAULT_VERSION = PACKAGE_VERSION; // Version from package.json (auto-generated)

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
export function getVersionMetadata(env) {
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

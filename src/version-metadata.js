import { VERSION as PACKAGE_VERSION } from "../version.js";

function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The release version and Cloudflare's deployment identity are separate values.
// Deployment IDs or arbitrary tags must never replace the user-facing release version.
export function getVersionMetadata(env) {
    const metadata = env?.CF_VERSION_METADATA;
    return {
        version:
            nonEmptyString(env?.VERSION) ||
            nonEmptyString(env?.DEPLOYMENT_VERSION) ||
            PACKAGE_VERSION,
        versionId: nonEmptyString(metadata?.id),
        versionTag: nonEmptyString(metadata?.tag),
        versionTimestamp: metadata?.timestamp ?? null
    };
}

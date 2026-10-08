// Function to check if a given URI or origin matches one of the precompiled patterns
export function matchesPatternList(uri, patterns) {
    if (typeof uri === "string") {
        return patterns.some(pattern => pattern.test(uri));
    }
    // A missing Origin is allowed only by an explicitly public rule such as ".*".
    return patterns.some(pattern => pattern.test(""));
}

// Function to modify headers to enable CORS
export function applyCorsHeaders(headers, request) {
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
    headers.append("Vary", "Origin");
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
        headers.delete("Access-Control-Allow-Credentials");
    }

    if (request.method === "OPTIONS") {
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
    }
    return headers;
}

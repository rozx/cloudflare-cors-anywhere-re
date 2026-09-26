// Function to check if a given URI or origin matches one of the precompiled patterns
export function matchesPatternList(uri, patterns) {
    if (typeof uri === "string") {
        return patterns.some(pattern => pattern.test(uri));
    }
    // When URI is null (e.g., when Origin header is missing), accept null origins
    return true;
}

// Function to modify headers to enable CORS
export function applyCorsHeaders(headers, request) {
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

        headers.delete("X-Content-Type-Options"); // Remove X-Content-Type-Options header
    }
    return headers;
}

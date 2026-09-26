// Redacts credentials and secret-looking query parameters from URLs before they are logged

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

export function sanitizeUrlForLog(value, depth = 0) {
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

export function sanitizeLogValue(value) {
    return String(value ?? "").replace(/https?:\/\/[^\s"'<>]+/gi, matchedUrl =>
        sanitizeUrlForLog(matchedUrl)
    );
}

import { isAllowedTarget } from "./security.js";
import { ProxyLimitError } from "./request-budget.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchWithPolicy(initialRequest, { budget, config, originUrl, isBackup }) {
    let request = initialRequest;
    for (;;) {
        budget.takeFetch();
        const response = await fetch(request);
        if (!REDIRECT_STATUSES.has(response.status)) return response;
        void response.body?.cancel().catch(() => {});

        // A backup's headers may contain owner credentials. Never follow its redirects.
        if (isBackup) throw new ProxyLimitError("Backup redirect blocked");
        const location = response.headers.get("location");
        if (!location) throw new ProxyLimitError("Invalid upstream redirect");
        let target;
        try {
            target = new URL(location, request.url);
        } catch {
            throw new ProxyLimitError("Invalid upstream redirect");
        }
        if (!isAllowedTarget(target.href, originUrl, config))
            throw new ProxyLimitError("Unsafe upstream redirect");

        let method = request.method;
        if (
            (response.status === 303 && method !== "HEAD") ||
            ([301, 302].includes(response.status) && method === "POST")
        )
            method = "GET";
        if (!["GET", "HEAD"].includes(method)) throw new ProxyLimitError("Request replay blocked");

        let headers = new Headers(request.headers);
        if (target.origin !== new URL(request.url).origin) {
            // Any custom header could be a secret. Carry only these harmless headers
            // across origins; Workers' redirect:follow forwards credentials verbatim.
            headers = new Headers();
            for (const name of ["accept", "accept-language"]) {
                if (request.headers.has(name)) headers.set(name, request.headers.get(name));
            }
        }
        headers.delete("content-length");
        headers.delete("content-type");
        headers.set("x-cors-proxy-hop", "1");
        request = new Request(target, {
            method,
            headers,
            redirect: "manual",
            signal: budget.signal
        });
    }
}

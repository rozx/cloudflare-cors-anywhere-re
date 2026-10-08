import {
    MAX_DURATION_MS,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    MAX_UPSTREAM_FETCHES
} from "./security.js";

export class ProxyLimitError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

export function createRequestBudget(request, durationMs = MAX_DURATION_MS) {
    const controller = new AbortController();
    const abort = () => controller.abort(new ProxyLimitError("Request cancelled", 504));
    const timer = setTimeout(
        () => controller.abort(new ProxyLimitError("Proxy request timed out", 504)),
        durationMs
    );
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    let fetches = 0;
    return {
        signal: controller.signal,
        get remaining() {
            return MAX_UPSTREAM_FETCHES - fetches;
        },
        takeFetch() {
            controller.signal.throwIfAborted();
            if (fetches >= MAX_UPSTREAM_FETCHES)
                throw new ProxyLimitError("Upstream request limit exceeded");
            fetches++;
        },
        close() {
            clearTimeout(timer);
            request.signal.removeEventListener("abort", abort);
        }
    };
}

// Limit actual bytes, including chunked bodies or dishonest Content-Length headers.
// This is pull-driven so the response stays streamed with bounded buffering.
export function boundedStream(body, maxBytes, signal, onDone = () => {}, status = 502) {
    if (!body) {
        onDone();
        return null;
    }
    const reader = body.getReader();
    let size = 0;
    let ended = false;
    let abort;
    const finish = () => {
        if (ended) return;
        ended = true;
        signal.removeEventListener("abort", abort);
        onDone();
    };
    return new ReadableStream(
        {
            start(controller) {
                abort = () => {
                    if (ended) return;
                    const reason = signal.reason;
                    finish();
                    controller.error(reason);
                    void reader.cancel(reason).catch(() => {});
                };
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
            },
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (ended) return;
                    if (done) {
                        finish();
                        controller.close();
                        return;
                    }
                    size += value.byteLength;
                    if (size > maxBytes)
                        throw new ProxyLimitError("Body size limit exceeded", status);
                    controller.enqueue(value);
                } catch (error) {
                    if (ended) return;
                    finish();
                    controller.error(error);
                    void reader.cancel(error).catch(() => {});
                }
            },
            cancel(reason) {
                finish();
                void reader.cancel(reason).catch(() => {});
            }
        },
        { highWaterMark: 0 }
    );
}

export async function readRequestBody(request, budget) {
    if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) {
        void request.body?.cancel().catch(() => {});
        throw new ProxyLimitError("Request body too large", 413);
    }
    if (!request.body) return null;
    return new Response(
        boundedStream(request.body, MAX_REQUEST_BYTES, budget.signal, () => {}, 413)
    ).arrayBuffer();
}

export function limitResponseBody(response, budget) {
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new ProxyLimitError("Response body too large");
    }
    return boundedStream(response.body, MAX_RESPONSE_BYTES, budget.signal, () => budget.close());
}

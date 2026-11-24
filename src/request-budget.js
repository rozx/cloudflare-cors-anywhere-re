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

// Count actual bytes in JS, for bodies whose length is not declared up front.
// This is pull-driven so buffering stays bounded. Every chunk costs CPU, so it is used
// only where nothing else bounds the body (see readRequestBody).
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

// Workers Free allows 10 ms of CPU per request, and every chunk that passes through a JS
// stream costs CPU. Bodies are therefore handed to the runtime to pump natively wherever
// their size can be bounded without reading them.

// With a declared Content-Length the HTTP framing already bounds the body, so the native
// stream is forwarded untouched. Without one the body is buffered and counted in JS.
export async function readRequestBody(request, budget) {
    const declared = request.headers.get("content-length");
    if (Number(declared) > MAX_REQUEST_BYTES) {
        void request.body?.cancel().catch(() => {});
        throw new ProxyLimitError("Request body too large", 413);
    }
    if (!request.body) return null;
    if (declared !== null && /^\d+$/.test(declared)) return request.body;
    return new Response(
        boundedStream(request.body, MAX_REQUEST_BYTES, budget.signal, () => {}, 413)
    ).arrayBuffer();
}

// Workers' IdentityTransformStream is pumped by the runtime without entering JS; the
// standard TransformStream is the equivalent elsewhere (Node tests).
function createPassThrough() {
    return typeof IdentityTransformStream === "function"
        ? new IdentityTransformStream()
        : new TransformStream();
}

// A declared length over the limit is rejected up front. The stream itself is not
// counted: it is piped natively and ends when the upstream ends, the client disconnects
// or the request deadline aborts the budget signal, whichever comes first.
export function limitResponseBody(response, budget) {
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new ProxyLimitError("Response body too large");
    }
    if (!response.body) return null;
    const { readable, writable } = createPassThrough();
    response.body
        .pipeTo(writable, { signal: budget.signal })
        .catch(() => {})
        .finally(() => budget.close());
    return readable;
}

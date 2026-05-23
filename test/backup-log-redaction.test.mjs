import assert from "node:assert/strict";
import test from "node:test";

import worker from "../index.js";

test("redacts backup server query secrets from backup logs", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    const logs = [];
    let fetchCount = 0;
    let responseBody = "";

    globalThis.fetch = async request => {
        fetchCount += 1;

        if (fetchCount === 1) {
            return new Response("retry direct", {
                status: 503,
                statusText: "Service Unavailable"
            });
        }

        throw new Error(`network failed for ${request.url}`);
    };

    console.log = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push(args.join(" "));
    console.error = (...args) => logs.push(args.join(" "));

    try {
        const response = await worker.fetch(
            new Request("https://worker.example/?url=https%3A%2F%2Fapi.example%2Fdata"),
            {
                BACKUP_CORS_SERVERS: JSON.stringify([
                    "http://aaa.com?key=apikey&url={url}"
                ]),
                MAX_RETRY_ATTEMPTS: "0"
            },
            { waitUntil: () => {} }
        );

        assert.equal(response.status, 502);
        responseBody = await response.text();
    } finally {
        globalThis.fetch = originalFetch;
        console.log = originalConsoleLog;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
    }

    const joinedLogs = logs.join("\n");

    assert.match(joinedLogs, /Using backup server:/);
    assert.match(joinedLogs, /Failed to reach backup URL:/);
    assert.match(joinedLogs, /key=\[REDACTED\]/);
    assert.doesNotMatch(joinedLogs, /apikey/);
    assert.match(responseBody, /key=\[REDACTED\]/);
    assert.doesNotMatch(responseBody, /apikey/);
});

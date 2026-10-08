import assert from "node:assert/strict";
import test from "node:test";
import { createRequestBudget, readRequestBody, limitResponseBody } from "../src/request-budget.js";

test("deadline cancels a stalled response even when nobody reads it", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let cancelled = false;
    const budget = createRequestBudget(new Request("https://worker.example/"));
    const stream = limitResponseBody(
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                }
            })
        ),
        budget
    );
    t.mock.timers.tick(30_001);
    await assert.rejects(new Response(stream).text(), /timed out/);
    assert.equal(cancelled, true);
    assert.equal(budget.signal.aborted, true);
});

test("deadline interrupts a stalled upload before fetching", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let cancelled = false;
    const req = new Request("https://worker.example/", {
        method: "POST",
        duplex: "half",
        body: new ReadableStream({
            cancel() {
                cancelled = true;
            }
        })
    });
    const budget = createRequestBudget(req);
    const body = readRequestBody(req, budget);
    t.mock.timers.tick(30_001);
    await assert.rejects(body, /timed out/);
    assert.equal(cancelled, true);
    budget.close();
});

test("client disconnect cancels the upstream response", async () => {
    const aborter = new AbortController();
    const budget = createRequestBudget(
        new Request("https://worker.example/", { signal: aborter.signal })
    );
    let cancelled = false;
    const stream = limitResponseBody(
        new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                }
            })
        ),
        budget
    );
    aborter.abort();
    await assert.rejects(new Response(stream).text(), /cancelled/);
    assert.equal(cancelled, true);
});

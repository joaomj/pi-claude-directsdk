import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AdmissionRelay, parseUpstream } from "../src/admission.js";
import { scriptedExchange } from "./helpers/sse.js";

interface SeenRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startUpstream(
  handler: (seen: SeenRequest, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      const record: SeenRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      };
      seen.push(record);
      handler(record, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function upstreamHandler(body: string, status = 200) {
  return (_seen: SeenRequest, res: import("node:http").ServerResponse) => {
    res.writeHead(status, { "content-type": "text/event-stream" });
    res.end(body);
  };
}

function messagesBody(model = "claude-opus-4-6"): string {
  return JSON.stringify({
    model,
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
}

async function postJson(
  url: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body,
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
});

describe("admission relay", () => {
  it("admits the first Messages request and denies the rest", async () => {
    const upstream = await startUpstream(upstreamHandler(scriptedExchange({})));
    closers.push(upstream.close);
    const relay = await AdmissionRelay.create(upstream.url, 10_000);
    closers.push(() => relay.close());

    const first = await postJson(relay.url, "/v1/messages", messagesBody());
    assert.equal(first.status, 200);
    assert.ok(first.text.includes("message_stop"));
    assert.equal(first.headers.get("x-request-id")?.startsWith("req_"), true);
    assert.equal(relay.used, true);
    assert.equal(relay.denied, 0);
    assert.equal(relay.capture.complete, true);
    assert.equal(relay.capture.message?.content[0]?.type, "text");

    const second = await postJson(relay.url, "/v1/messages", messagesBody());
    assert.equal(second.status, 400);
    assert.match(second.text, /already admitted/);
    assert.equal(relay.denied, 1);
    assert.equal(upstream.seen.length, 1);
  });

  it("forwards identity headers and records the request id", async () => {
    const upstream = await startUpstream(upstreamHandler(scriptedExchange({})));
    closers.push(upstream.close);
    const relay = await AdmissionRelay.create(upstream.url, 10_000);
    closers.push(() => relay.close());

    const res = await postJson(relay.url, "/v1/messages", messagesBody(), {
      authorization: "Bearer test",
      "anthropic-beta": "claude-code-20250219",
      "x-custom": "kept",
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.seen[0]?.headers["authorization"], "Bearer test");
    assert.equal(
      upstream.seen[0]?.headers["anthropic-beta"],
      "claude-code-20250219",
    );
    assert.equal(upstream.seen[0]?.headers["x-custom"], "kept");
    assert.ok(relay.requestId?.startsWith("req_"));
  });

  it("rejects non-Messages traffic without touching upstream", async () => {
    const upstream = await startUpstream(upstreamHandler(scriptedExchange({})));
    closers.push(upstream.close);
    const relay = await AdmissionRelay.create(upstream.url, 10_000);
    closers.push(() => relay.close());

    const count = await postJson(relay.url, "/v1/messages/count_tokens", messagesBody());
    assert.equal(count.status, 404);
    const get = await fetch(`${relay.url}/v1/messages`);
    assert.equal(get.status, 404);
    await get.text();
    assert.equal(upstream.seen.length, 0);
    assert.equal(relay.used, false);
  });

  it("rejects unknown models and beta mismatches", async () => {
    const upstream = await startUpstream(upstreamHandler(scriptedExchange({})));
    closers.push(upstream.close);
    const relay = await AdmissionRelay.create(upstream.url, 10_000);
    closers.push(() => relay.close());

    const badModel = await postJson(relay.url, "/v1/messages", messagesBody("gpt-5"));
    assert.equal(badModel.status, 400);
    assert.match(badModel.text, /unknown model/);
    const badBeta = await postJson(
      relay.url,
      "/v1/messages",
      messagesBody(),
      { "anthropic-beta": "unknown-beta" },
    );
    assert.equal(badBeta.status, 400);
    assert.match(badBeta.text, /unsupported beta/);
    assert.equal(upstream.seen.length, 0);
  });

  it("surfaces upstream errors with the first-attempt detail", async () => {
    const upstream = await startUpstream((_seen, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: "bad key" } }));
    });
    closers.push(upstream.close);
    const relay = await AdmissionRelay.create(upstream.url, 10_000);
    closers.push(() => relay.close());

    const res = await postJson(relay.url, "/v1/messages", messagesBody());
    assert.equal(res.status, 400);
    assert.match(res.text, /bad key/);
    assert.equal(relay.used, true);
    assert.match(relay.errorText(), /bad key/);
    assert.equal(relay.capture.complete, false);
  });

  it("fails pending requests after abort", async () => {
    const upstream = await startUpstream((_seen, res) => {
      // Never respond; the abort must win.
    });
    closers.push(upstream.close);
    const relay = await AdmissionRelay.create(upstream.url, 10_000);
    closers.push(() => relay.close());

    const pending = postJson(relay.url, "/v1/messages", messagesBody());
    await new Promise((done) => setTimeout(done, 200));
    relay.abort();
    const res = await pending;
    assert.equal(res.status, 409);
  });

  it("parses upstream request shapes", () => {
    const headers = {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
    };
    const ok = parseUpstream(
      { method: "POST", url: "/v1/messages?beta=true", headers },
      { model: "claude-opus-4-6", max_tokens: 10, stream: true },
    );
    assert.equal(ok?.kind, "messages");
    assert.ok(ok?.kind === "messages" && ok.requestId.startsWith("req_"));

    const withId = parseUpstream(
      { method: "POST", url: "/v1/messages", headers },
      { model: "claude-opus-4-6", request_id: "req_1", stream: true },
    );
    assert.ok(withId?.kind === "messages" && withId.requestId === "req_1");

    assert.equal(
      parseUpstream({ method: "GET", url: "/v1/messages", headers }, {}),
      null,
    );
    assert.equal(
      parseUpstream(
        { method: "POST", url: "/v1/complete", headers },
        { model: "x" },
      ),
      null,
    );
    assert.equal(
      parseUpstream(
        { method: "POST", url: "/v2/messages", headers },
        { model: "claude-opus-4-6" },
      )?.kind,
      "table",
    );
  });
});

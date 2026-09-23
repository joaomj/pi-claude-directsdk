/**
 * Request-scoped native HTTP admission relay.
 *
 * The relay binds an ephemeral loopback port with a random per-request route.
 * It forwards only the first upstream Messages request and rejects later
 * native recovery or retry attempts locally, so one Pi model call produces at
 * most one upstream request. Native authentication and identity headers pass
 * through memory; they are never logged or persisted.
 *
 * Only HTTP transfer encoding changes. Request identity and payload stay
 * native.
 */

import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Socket } from "node:net";
import { NativeAssistantMessage, NativeUsage, deepClone, isRecord } from "./types.js";

const ERROR_BODY_CAP = 64 * 1024;
const REQUEST_BODY_CAP = 512 * 1024 * 1024;

/** Reconstructed upstream assistant message from the SSE stream. */
export class SseCapture {
  message: NativeAssistantMessage | null = null;
  complete = false;
  private pending = "";
  private decoder = new TextDecoder();
  private arguments: Map<number, string> = new Map();

  feed(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = this.pending.search(/\r?\n\r?\n/)) !== -1) {
      const frame = this.pending.slice(0, index);
      const match = /\r?\n\r?\n/.exec(this.pending);
      this.pending = this.pending.slice(index + (match?.[0].length ?? 2));
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        this.event(JSON.parse(data) as Record<string, unknown>);
      }
    }
  }

  private event(event: Record<string, unknown>): void {
    switch (event["type"]) {
      case "message_start":
        this.onStart(event);
        break;
      case "content_block_start":
        this.onBlockStart(event);
        break;
      case "content_block_delta":
        this.onBlockDelta(event);
        break;
      case "content_block_stop":
        this.onBlockStop(event);
        break;
      case "message_delta":
        this.onDelta(event);
        break;
      case "message_stop":
        this.onStop();
        break;
      default:
        break;
    }
  }

  private onStart(event: Record<string, unknown>): void {
    this.message = deepClone(event["message"] as NativeAssistantMessage);
  }

  private onBlockStart(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    this.message.content.push(
      deepClone(event["content_block"] as NativeAssistantMessage["content"][number]),
    );
  }

  private onBlockDelta(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    const delta = event["delta"] as Record<string, unknown>;
    const index = event["index"] as number;
    const block = this.message.content[index] as Record<string, unknown> | undefined;
    if (!block || !isRecord(delta)) {
      return;
    }
    const field =
      delta["type"] === "text_delta"
        ? "text"
        : delta["type"] === "thinking_delta"
          ? "thinking"
          : delta["type"] === "signature_delta"
            ? "signature"
            : undefined;
    if (field) {
      block[field] = `${block[field] ?? ""}${delta[field] ?? ""}`;
    } else if (delta["type"] === "input_json_delta") {
      const prev = this.arguments.get(index) ?? "";
      this.arguments.set(index, prev + String(delta["partial_json"] ?? ""));
    } else if (delta["type"] === "citations_delta") {
      const citations = Array.isArray(block["citations"])
        ? (block["citations"] as unknown[])
        : [];
      citations.push(deepClone(delta["citation"]));
      block["citations"] = citations;
    }
  }

  private onBlockStop(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    const index = event["index"] as number;
    const raw = this.arguments.get(index);
    if (raw !== undefined) {
      this.arguments.delete(index);
      const block = this.message.content[index] as Record<string, unknown>;
      // A no-argument tool call streams one input_json_delta with empty partial_json.
      block["input"] = raw.trim() ? JSON.parse(raw) : {};
    }
  }

  private onDelta(event: Record<string, unknown>): void {
    if (!this.message) {
      return;
    }
    const delta = event["delta"];
    if (isRecord(delta)) {
      Object.assign(this.message, deepClone(delta));
    }
    const usage = event["usage"];
    if (isRecord(usage) && isRecord(this.message.usage)) {
      Object.assign(this.message.usage, deepClone(usage));
    }
  }

  private onStop(): void {
    this.complete = Boolean(
      this.message?.stop_reason && this.arguments.size === 0,
    );
  }
}

export interface UpstreamTarget {
  scheme: "https:" | "http:";
  host: string;
  port: number;
  path: string;
}

/** Parse and validate the upstream. HTTP is allowed only for loopback fixtures. */
export function parseUpstream(raw: string): UpstreamTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid native upstream URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    !host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Native upstream must be HTTPS or a loopback HTTP fixture",
    );
  }
  return {
    scheme: url.protocol as "https:" | "http:",
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    path: url.pathname.replace(/\/$/, ""),
  };
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

export class AdmissionRelay {
  readonly url: string;
  readonly ready: Promise<void>;
  used = false;
  denied = 0;
  status: number | null = null;
  requestId: string | null = null;
  failure: string | null = null;
  capture = new SseCapture();
  errorBody = Buffer.alloc(0);
  /** Fired when the admitted upstream response headers arrive. */
  onUpstreamResponse: ((status: number, headers: Record<string, string>) => void) | null = null;

  private server: Server;
  private readonly target: UpstreamTarget;
  private readonly timeoutMs: number;
  private readonly route: string;
  private cancelled = false;
  private sockets = new Set<Socket>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  private constructor(target: UpstreamTarget, timeoutMs: number) {
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.route = `/admit/${randomBytes(32).toString("base64url")}`;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("connection", (socket) => {
      this.track(socket);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.server.once("error", (error) => this.rejectReady(error as Error));
    this.server.listen(0, "127.0.0.1", () => {
      const address = this.server.address();
      if (address === null || typeof address === "string") {
        this.rejectReady(new Error("Admission relay failed to bind"));
        return;
      }
      this.resolveReady();
    });
    // The relay must never keep the Pi process alive on its own.
    this.server.unref();
    this.url = "";
  }

  /** Bind the relay and resolve its URL. */
  static async create(
    upstream: string,
    timeoutMs: number,
  ): Promise<AdmissionRelay> {
    const relay = new AdmissionRelay(parseUpstream(upstream), timeoutMs);
    await relay.ready;
    const address = relay.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Admission relay failed to bind");
    }
    (relay as { url: string }).url =
      `http://127.0.0.1:${address.port}${relay.route}`;
    return relay;
  }

  /** The upstream's own message for a non-200 answer, "" when none was captured. */
  errorText(): string {
    const text = this.errorBody.toString("utf-8");
    try {
      const message = (JSON.parse(text) as Record<string, unknown>)["error"] as Record<
        string,
        unknown
      >;
      return typeof message?.["message"] === "string" ? message["message"] : text;
    } catch {
      return text;
    }
  }

  abort(): void {
    this.cancelled = true;
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // Peer may have closed between the read and cancellation.
      }
    }
  }

  close(): Promise<void> {
    this.abort();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }

  private deny(res: ServerResponse): void {
    this.denied += 1;
    const body = Buffer.from(
      '{"type":"error","error":{"type":"invalid_request_error","message":"PI_MODEL_ADMISSION_CONSUMED"}}',
    );
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": body.length,
      Connection: "close",
    });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let path = "";
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(404, { Connection: "close" });
      res.end();
      return;
    }
    // The check-and-set below runs synchronously before any await, so it is
    // atomic on the Node event loop: exactly one request is admitted.
    if (
      req.method !== "POST" ||
      !safeEqualPath(path, `${this.route}/v1/messages`) ||
      req.headers["origin"] !== undefined ||
      this.cancelled ||
      this.used
    ) {
      if (
        req.method === "POST" &&
        safeEqualPath(path, `${this.route}/v1/messages`) &&
        req.headers["origin"] === undefined &&
        (this.cancelled || this.used)
      ) {
        // Drain the body so the child sees a clean denial.
        req.resume();
        this.deny(res);
        return;
      }
      req.resume();
      res.writeHead(404, { Connection: "close" });
      res.end();
      return;
    }
    this.used = true;
    this.track(req.socket);

    let body: Buffer;
    try {
      body = await readBody(req, REQUEST_BODY_CAP);
    } catch (error) {
      this.failure = error instanceof Error ? error.name : String(error);
      res.writeHead(400, { Connection: "close" });
      res.end();
      return;
    }

    try {
      await this.forward(req, res, body);
    } catch (error) {
      this.failure = error instanceof Error ? error.name : String(error);
      if (!res.headersSent) {
        res.writeHead(502, { Connection: "close" });
      }
      try {
        res.end();
      } catch {
        // Child is gone; the failure field carries the diagnosis.
      }
    } finally {
      this.sockets.delete(req.socket);
    }
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) {
          continue;
        }
        headers[key] = value;
      }
      headers["accept-encoding"] = "identity";
      const send =
        this.target.scheme === "https:" ? httpsRequest : httpRequest;
      const upstream = send(
        {
          host: this.target.host,
          port: this.target.port,
          path: `${this.target.path}/v1/messages`,
          method: "POST",
          headers: { ...headers, "content-length": body.length },
          timeout: this.timeoutMs,
        },
        (upstreamRes) => {
          this.status = upstreamRes.statusCode ?? null;
          this.requestId =
            (upstreamRes.headers["request-id"] as string | undefined) ??
            (upstreamRes.headers["x-request-id"] as string | undefined) ??
            null;
          const passthrough: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (
              value === undefined ||
              ["connection", "transfer-encoding", "server", "date"].includes(
                key.toLowerCase(),
              )
            ) {
              continue;
            }
            passthrough[key] = value;
          }
          try {
            if (this.onUpstreamResponse) {
              const flat: Record<string, string> = {};
              for (const [key, value] of Object.entries(passthrough)) {
                flat[key] = Array.isArray(value) ? value.join(", ") : value;
              }
              this.onUpstreamResponse(this.status ?? 502, flat);
            }
            res.writeHead(this.status ?? 502, passthrough);
          } catch (error) {
            upstreamRes.destroy();
            reject(error);
            return;
          }
          upstreamRes.on("data", (chunk: Buffer) => {
            if (this.status === 200) {
              try {
                this.capture.feed(chunk);
              } catch (error) {
                this.failure =
                  error instanceof Error ? error.name : String(error);
              }
            } else if (this.errorBody.length < ERROR_BODY_CAP) {
              // Bounded: keeps the rejection reason, never the whole stream.
              this.errorBody = Buffer.concat([
                this.errorBody,
                chunk.subarray(0, ERROR_BODY_CAP - this.errorBody.length),
              ]);
            }
            if (!res.write(chunk)) {
              upstreamRes.pause();
              res.once("drain", () => upstreamRes.resume());
            }
          });
          upstreamRes.on("end", () => {
            try {
              res.end();
            } catch {
              // Child went away; capture still holds the diagnosis.
            }
            resolve();
          });
          upstreamRes.on("error", reject);
        },
      );
      upstream.on("socket", (socket: Socket) => {
        this.track(socket);
      });
      upstream.on("timeout", () => {
        upstream.destroy(new Error("Upstream request timed out"));
      });
      upstream.on("error", reject);
      req.on("aborted", () => {
        upstream.destroy();
      });
      res.on("close", () => {
        upstream.destroy();
      });
      upstream.end(body);
    });
  }
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("Request body exceeds relay cap"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeEqualPath(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type { NativeUsage };

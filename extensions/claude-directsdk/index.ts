/**
 * Claude DirectSDK extension entry.
 *
 * Registers Claude as a Pi model provider through the unmodified `claude`
 * executable. Pi owns the transcript, tools, approvals, and retries; the CLI
 * supplies subscription authentication as a model transport.
 *
 * The sentinel apiKey marks the provider configured. It is never sent
 * anywhere: this provider performs no Pi-side HTTP. Authentication belongs
 * to the official CLI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODELS, refreshModels, streamSimple } from "../../src/provider.js";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("claude-directsdk", {
    name: "Claude DirectSDK",
    baseUrl: "process://claude-directsdk",
    apiKey: "[REDACTED]",
    api: "claude-directsdk",
    models: MODELS,
    refreshModels,
    streamSimple,
  });
}

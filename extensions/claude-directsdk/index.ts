/** Claude CLI supplies authentication; Pi owns the transcript and tools. */
import { normalizeContext, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectSdkProvider, PROVIDER_ID, streamSimple } from "../../src/provider.js";

export default function (pi: ExtensionAPI) {
  let report = (message: string): void => { console.error(message); };
  pi.on("session_start", (_event, context) => {
    report = context.hasUI
      ? message => context.ui.notify(message, "warning")
      : message => { console.error(message); };
  });
  // Pi can dispatch a selected or overridden model while the live catalog is empty.
  registerApiProvider({
    api: PROVIDER_ID,
    stream: (model, context, options) => streamSimple(model, normalizeContext(context), options as SimpleStreamOptions),
    streamSimple: (model, context, options) => streamSimple(model, normalizeContext(context), options),
  }, PROVIDER_ID);
  pi.on("session_shutdown", () => { unregisterApiProviders(PROVIDER_ID); });
  pi.registerProvider(createDirectSdkProvider(message => report(message)));
}

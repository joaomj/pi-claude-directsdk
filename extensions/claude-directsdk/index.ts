/** Claude CLI supplies authentication; Pi owns the transcript and tools. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectSdkProvider } from "../../src/provider.js";

export default function (pi: ExtensionAPI) {
  let report = (message: string): void => { console.error(message); };
  pi.on("session_start", (_event, context) => {
    report = context.hasUI
      ? message => context.ui.notify(message, "warning")
      : message => { console.error(message); };
  });
  pi.registerProvider(createDirectSdkProvider(message => report(message)));
}

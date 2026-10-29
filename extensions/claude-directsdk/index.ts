/** Claude CLI supplies authentication; Pi owns the transcript and tools. */
import { normalizeContext, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { getDocsPath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectSdkProvider, PROVIDER_ID, streamSimple } from "../../src/provider.js";

/**
 * Pi's default prompt routes the model to Pi's docs by name. Anthropic rejects that
 * prompt as third-party app usage when the child reports a client label other than
 * Claude Code's SDK default, so this provider sends a plain pointer instead.
 */
const DOCS_SECTION =
  `Pi's own documentation is in ${getDocsPath()}. ` +
  "Read the relevant file there only when the user asks about Pi itself, and follow its cross-references.";

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
  // Only this transport reports a custom client label, so other providers keep Pi's prompt.
  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    const options = event.systemPromptOptions;
    // A custom or forced prompt replaces Pi's sections; there is no docs section to swap.
    if (options.customPrompt || options.forceSystemPrompt) return;
    options.sections.docs = DOCS_SECTION;
  });
  pi.on("session_shutdown", () => { unregisterApiProviders(PROVIDER_ID); });
  pi.registerProvider(createDirectSdkProvider(message => report(message)));
}

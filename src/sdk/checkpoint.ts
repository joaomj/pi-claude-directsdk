/**
 * Pi history as a Claude session checkpoint.
 *
 * A live Claude session is reused when Pi's history matches it. When it cannot
 * be reused (resume, branch, edit, compaction, model or tool change), the
 * conversation is rebuilt from this text instead of pretending the Claude
 * session still matches. Tool results are included, so a rebuild never has to
 * re-run a completed operation.
 */

import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai/compat";

export interface CheckpointPrompt {
  /** Earlier conversation, or "" when nothing precedes the request. */
  history: string;
  /** What Claude must answer now. */
  request: string;
}

const CONTINUE_REQUEST =
  "Continue the task from the conversation above. Do not repeat operations that already " +
  "completed; their results are included. Reply with your next step.";

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function serialise(messages: Message[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) sections.push(`User:\n${text}`);
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) =>
          block.type === "toolCall"
            ? `[called ${block.name} with ${JSON.stringify(block.arguments)}]`
            : "",
        )
        .filter(Boolean);
      const body = [text, ...calls].filter(Boolean).join("\n");
      // A failed or aborted response leaves an empty placeholder; it carries no context.
      if (body) sections.push(`Assistant:\n${body}`);
      continue;
    }
    if (message.role === "toolResult") {
      const text = textOf(message.content).trim();
      const label = message.isError ? "failed" : "returned";
      sections.push(
        `Tool ${message.toolName} ${label}:\n${text || "(no output)"}`,
      );
    }
  }
  return sections.join("\n\n");
}

/** Build the prompt that bootstraps a rebuilt Claude session from Pi history. */
export function checkpointPrompt(messages: Message[]): CheckpointPrompt {
  const history = messages.filter((message) => message.role !== "system");
  const last = history[history.length - 1];
  if (last?.role === "user") {
    const request = textOf(last.content).trim();
    const earlier = serialise(history.slice(0, -1));
    return { history: earlier, request: request || CONTINUE_REQUEST };
  }
  return { history: serialise(history), request: CONTINUE_REQUEST };
}

/** One user message carrying a checkpoint, if there is one. */
export function checkpointText(prompt: CheckpointPrompt): string {
  if (!prompt.history) return prompt.request;
  return (
    "The Pi host rebuilt this session from its conversation record. " +
    "Earlier turns, including tool results, follow as plain text.\n\n" +
    `${prompt.history}\n\n---\n\n${prompt.request}`
  );
}

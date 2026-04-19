import type { ContentBlockParam, MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages.js";

type ToolResultContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    };
import type {
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { sanitizeSurrogates } from "./prompt.js";

export type IndexedBlock =
  | (TextContent & { index: number })
  | (ThinkingContent & { index: number; thinkingSignature?: string })
  | (ToolCall & { index: number; partialJson: string });

const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const;
const claudeCodeToolLookup = new Map(claudeCodeTools.map((name) => [name.toLowerCase(), name]));

export function toClaudeCodeToolName(name: string): string {
  return claudeCodeToolLookup.get(name.toLowerCase()) ?? name;
}

export function fromClaudeCodeToolName(name: string, tools?: Tool[]): string {
  const lower = name.toLowerCase();
  return tools?.find((tool) => tool.name.toLowerCase() === lower)?.name ?? name;
}

export function convertPiMessagesToAnthropic(
  messages: Message[],
  isOAuth: boolean,
): MessageParam[] {
  const params: MessageParam[] = [];
  const toolIdMap = new Map<string, string>();
  const usedToolIds = new Set<string>();

  const getAnthropicToolId = (id: string): string => {
    const existing = toolIdMap.get(id);
    if (existing) return existing;

    let base = sanitizeSurrogates(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!base) base = "tool";
    let candidate = base;
    let suffix = 1;
    while (usedToolIds.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    usedToolIds.add(candidate);
    toolIdMap.set(id, candidate);
    return candidate;
  };

  // Anthropic requires every `tool_use` block to be IMMEDIATELY followed by a
  // user message containing a matching `tool_result` for the same id. Aborted
  // / errored assistant turns or partial histories can leave orphan tool_uses
  // behind, which causes the API to reject the next request with:
  //   `tool_use` ids were found without `tool_result` blocks immediately after
  // We track outstanding tool_use ids from the last assistant message and
  // synthesize "No result provided" results for any that aren't satisfied by
  // the time we emit the next user message (or finish the history).
  let pendingToolUseIds: string[] = [];

  const flushPendingToolResults = () => {
    if (pendingToolUseIds.length === 0) return;
    const syntheticBlocks: ContentBlockParam[] = pendingToolUseIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "No result provided",
      is_error: true,
    }));
    params.push({ role: "user", content: syntheticBlocks });
    pendingToolUseIds = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "user") {
      flushPendingToolResults();
      if (typeof message.content === "string") {
        if (message.content.trim()) params.push({ role: "user", content: sanitizeSurrogates(message.content) });
      } else {
        const blocks: ContentBlockParam[] = message.content.map((item) =>
          item.type === "text"
            ? { type: "text", text: sanitizeSurrogates(item.text) }
            : {
                type: "image",
                source: { type: "base64", media_type: item.mimeType as never, data: item.data },
              },
        );
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (message.role === "assistant") {
      // Skip aborted / errored assistant turns entirely. Their content may
      // include partial tool_use blocks that will never get a matching
      // tool_result, which would poison every subsequent request.
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        continue;
      }

      // Defensive: if the previous assistant turn had unresolved tool_uses and
      // the next message is another assistant (shouldn't normally happen),
      // patch them up before emitting the new assistant turn.
      flushPendingToolResults();

      const blocks: ContentBlockParam[] = [];
      const emittedToolUseIds: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
        } else if (block.type === "toolCall") {
          const anthropicId = getAnthropicToolId(block.id);
          blocks.push({
            type: "tool_use",
            id: anthropicId,
            name: isOAuth ? toClaudeCodeToolName(block.name) : block.name,
            input: block.arguments ?? {},
          });
          emittedToolUseIds.push(anthropicId);
        }
      }
      if (blocks.length > 0) {
        params.push({ role: "assistant", content: blocks });
        pendingToolUseIds = emittedToolUseIds;
      }
      continue;
    }

    if (message.role === "toolResult") {
      const toolResults: ContentBlockParam[] = [];
      const satisfiedIds = new Set<string>();

      const firstId = getAnthropicToolId(message.toolCallId);
      toolResults.push({
        type: "tool_result",
        tool_use_id: firstId,
        content: convertToolResultContentToAnthropic(message.content),
        is_error: message.isError,
      });
      satisfiedIds.add(firstId);

      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "toolResult") {
        const nextMessage = messages[j] as ToolResultMessage;
        const nextId = getAnthropicToolId(nextMessage.toolCallId);
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextId,
          content: convertToolResultContentToAnthropic(nextMessage.content),
          is_error: nextMessage.isError,
        });
        satisfiedIds.add(nextId);
        j++;
      }
      i = j - 1;

      // Synthesize "No result provided" for any tool_use from the last
      // assistant message that wasn't covered by the toolResult run. They
      // must live in the SAME user message as the real tool_results so that
      // every tool_use is immediately followed by matching results.
      for (const id of pendingToolUseIds) {
        if (!satisfiedIds.has(id)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: id,
            content: "No result provided",
            is_error: true,
          });
        }
      }
      pendingToolUseIds = [];

      params.push({ role: "user", content: toolResults });
    }
  }

  const last = params.at(-1);
  if (last?.role === "user" && Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1] as { cache_control?: { type: string } };
    lastBlock.cache_control = { type: "ephemeral" };
  }

  return params;
}

export function convertPiToolsToAnthropic(tools: Tool[], isOAuth: boolean): ToolUnion[] {
  return tools.map((tool) => ({
    name: isOAuth ? toClaudeCodeToolName(tool.name) : tool.name,
    description: tool.description,
    input_schema: {
      type: "object" as const,
      properties: (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      required: (tool.parameters as { required?: string[] }).required ?? [],
    },
  }));
}

function convertToolResultContentToAnthropic(
  content: (TextContent | ImageContent)[],
): string | ToolResultContentBlock[] {
  const hasImages = content.some((block) => block.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(
      content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  }

  const blocks = content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: sanitizeSurrogates(block.text) };
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType as ToolResultContentBlock extends { type: "image"; source: infer S }
          ? S extends { media_type: infer M }
            ? M
            : never
          : never,
        data: block.data,
      },
    };
  });

  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }

  return blocks;
}

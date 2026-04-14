import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
} from "@mariozechner/pi-ai";
import { USER_AGENT } from "./auth.js";
import {
  convertPiMessagesToAnthropic,
  convertPiToolsToAnthropic,
  fromClaudeCodeToolName,
  type IndexedBlock,
} from "./convert.js";
import { buildAnthropicSystemPrompt } from "./prompt.js";

const REQUIRED_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

function makeDefaultHeaders(
  isOAuth: boolean,
  options?: SimpleStreamOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
  };

  if (isOAuth) {
    headers["anthropic-beta"] = REQUIRED_BETAS.join(",");
    headers["user-agent"] = USER_AGENT;
    headers["x-app"] = "cli";
  } else {
    headers["anthropic-beta"] = [
      "fine-grained-tool-streaming-2025-05-14",
      "interleaved-thinking-2025-05-14",
    ].join(",");
  }

  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers))
      headers[key] = value;
  }

  return headers;
}

export function streamAnthropicOAuth(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey ?? "";
      const isOAuth = true;
      const defaultHeaders = makeDefaultHeaders(isOAuth, options);

      if (isOAuth) defaultHeaders.authorization = `Bearer ${apiKey}`;

      const client = new Anthropic({
        baseURL: model.baseUrl,
        apiKey: isOAuth ? null : apiKey,
        authToken: isOAuth ? apiKey : null,
        defaultHeaders,
        dangerouslyAllowBrowser: true,
      });

      const maxTokens =
        options?.maxTokens || Math.floor(model.maxTokens / 3);

      const params: MessageCreateParamsStreaming = {
        model: model.id,
        messages: convertPiMessagesToAnthropic(context.messages, isOAuth),
        max_tokens: maxTokens,
        stream: true,
      };

      const system = buildAnthropicSystemPrompt(context.systemPrompt, isOAuth);
      if (system) params.system = system as never;
      if (context.tools?.length)
        params.tools = convertPiToolsToAnthropic(context.tools, isOAuth);

      if (options?.reasoning && model.reasoning && maxTokens > 1) {
        const defaultBudgets: Record<string, number> = {
          minimal: 1024,
          low: 4096,
          medium: 10240,
          high: 20480,
          xhigh: 32000,
        };
        const customBudget =
          options.thinkingBudgets?.[
            options.reasoning as keyof typeof options.thinkingBudgets
          ];
        const requestedBudget =
          customBudget ?? defaultBudgets[options.reasoning] ?? 10240;

        params.thinking = {
          type: "enabled",
          budget_tokens: Math.min(requestedBudget, maxTokens - 1),
        };
      }

      const anthropicStream = client.messages.stream(params, {
        signal: options?.signal,
      });
      stream.push({ type: "start", partial: output });

      const blocks = output.content as IndexedBlock[];

      for await (const event of anthropicStream) {
        if (event.type === "message_start") {
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead =
            (event.message.usage as { cache_read_input_tokens?: number })
              .cache_read_input_tokens || 0;
          output.usage.cacheWrite =
            (event.message.usage as { cache_creation_input_tokens?: number })
              .cache_creation_input_tokens || 0;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model, output.usage);
          continue;
        }

        if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            output.content.push({
              type: "text",
              text: "",
              index: event.index,
            } as IndexedBlock);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "thinking") {
            output.content.push({
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index,
            } as IndexedBlock);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "tool_use") {
            output.content.push({
              type: "toolCall",
              id: event.content_block.id,
              name: isOAuth
                ? fromClaudeCodeToolName(
                    event.content_block.name,
                    context.tools,
                  )
                : event.content_block.name,
              arguments: {},
              partialJson: "",
              index: event.index,
            } as IndexedBlock);
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          continue;
        }

        if (event.type === "content_block_delta") {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          );
          const block = blocks[contentIndex];
          if (!block) continue;

          if (event.delta.type === "text_delta" && block.type === "text") {
            block.text += event.delta.text;
            stream.push({
              type: "text_delta",
              contentIndex,
              delta: event.delta.text,
              partial: output,
            });
          } else if (
            event.delta.type === "thinking_delta" &&
            block.type === "thinking"
          ) {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: event.delta.thinking,
              partial: output,
            });
          } else if (
            event.delta.type === "signature_delta" &&
            block.type === "thinking"
          ) {
            block.thinkingSignature =
              (block.thinkingSignature || "") + event.delta.signature;
          } else if (
            event.delta.type === "input_json_delta" &&
            block.type === "toolCall"
          ) {
            block.partialJson += event.delta.partial_json;
            try {
              block.arguments = JSON.parse(block.partialJson) as Record<
                string,
                unknown
              >;
            } catch {}
            stream.push({
              type: "toolcall_delta",
              contentIndex,
              delta: event.delta.partial_json,
              partial: output,
            });
          }
          continue;
        }

        if (event.type === "content_block_stop") {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          );
          const block = blocks[contentIndex];
          if (!block) continue;

          delete (block as { index?: number }).index;
          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex,
              content: block.text,
              partial: output,
            });
          } else if (block.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex,
              content: block.thinking,
              partial: output,
            });
          } else if (block.type === "toolCall") {
            try {
              block.arguments = JSON.parse(block.partialJson) as Record<
                string,
                unknown
              >;
            } catch {}
            delete (block as { partialJson?: string }).partialJson;
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall: block,
              partial: output,
            });
          }
          continue;
        }

        if (event.type === "message_delta") {
          output.stopReason = mapStopReason(event.delta.stop_reason);
          output.usage.input =
            (event.usage as { input_tokens?: number }).input_tokens ||
            output.usage.input;
          output.usage.output =
            (event.usage as { output_tokens?: number }).output_tokens ||
            output.usage.output;
          output.usage.cacheRead =
            (event.usage as { cache_read_input_tokens?: number })
              .cache_read_input_tokens || 0;
          output.usage.cacheWrite =
            (event.usage as { cache_creation_input_tokens?: number })
              .cache_creation_input_tokens || 0;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      }

      if (options?.signal?.aborted) throw new Error("Request aborted");
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      for (const block of output.content as Array<{
        index?: number;
        partialJson?: string;
      }>) {
        delete block.index;
        delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

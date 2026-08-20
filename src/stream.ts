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
} from "@earendil-works/pi-ai";
import { isClaudeOAuthAccessToken, USER_AGENT } from "./auth.js";
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
  // fine-grained-tool-streaming removed: it ships the model's raw, unvalidated
  // tool-input JSON. For large edits full of quotes/newlines the streamed
  // string escaping breaks, so a field (e.g. edit.oldText) swallows the rest of
  // the structure — surfacing as either a hard JSON.parse crash or a wrong-shape
  // schema-validation failure. Default streaming has the server validate/buffer
  // tool JSON, guaranteeing well-formed, correctly-structured input.
  "interleaved-thinking-2025-05-14",
] as const;

// budget_tokens is removed on every current Anthropic model and returns 400;
// only the pre-4.6 generation still accepts it. Gate on the known-legacy shape
// so unknown ids - future models, and the custom entries ~/.pi/agent/models.json
// is documented to accept - default to adaptive, the path that works.
const LEGACY_THINKING_MODEL =
  /^claude-(?:opus|sonnet|haiku)-4-[0-5](?:-|$)|^claude-[0-3][-.]/;

const MIN_THINKING_BUDGET = 1024;

const EFFORT_BY_REASONING: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function usesAdaptiveThinking(model: Model<Api>): boolean {
  const forced = (
    model.compat as { forceAdaptiveThinking?: boolean } | undefined
  )?.forceAdaptiveThinking;
  if (typeof forced === "boolean") return forced;
  return !LEGACY_THINKING_MODEL.test(model.id.toLowerCase().replace(/\./g, "-"));
}

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

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
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
    headers["anthropic-beta"] = ["interleaved-thinking-2025-05-14"].join(",");
  }

  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      const normalizedKey = key.toLowerCase();
      if (
        isOAuth &&
        (normalizedKey === "x-api-key" || normalizedKey === "authorization")
      ) {
        continue;
      }
      const existingKey = Object.keys(headers).find(
        (header) => header.toLowerCase() === normalizedKey,
      );
      if (existingKey) delete headers[existingKey];
      if (value !== null) headers[key] = value;
    }
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
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(
          "No Anthropic auth available. Run /login and choose Claude Pro/Max.",
        );
      }

      const isOAuth = isClaudeOAuthAccessToken(apiKey);
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
        messages: convertPiMessagesToAnthropic(context.messages, isOAuth, model),
        max_tokens: maxTokens,
        stream: true,
      };

      const system = buildAnthropicSystemPrompt(context.systemPrompt, isOAuth);
      if (system) params.system = system as never;
      if (context.tools?.length)
        params.tools = convertPiToolsToAnthropic(context.tools, isOAuth);

      if (options?.reasoning && model.reasoning && maxTokens > 1) {
        if (usesAdaptiveThinking(model)) {
          const mapped = model.thinkingLevelMap?.[options.reasoning];
          const effort =
            typeof mapped === "string"
              ? mapped
              : (EFFORT_BY_REASONING[options.reasoning] ?? "high");
          // display defaults to "omitted" on every model that takes adaptive
          // thinking, which streams thinking blocks with empty text - Pi renders
          // those as a long silent pause. Ask for the summary explicitly.
          params.thinking = { type: "adaptive", display: "summarized" } as never;
          Object.assign(params, { output_config: { effort } });
        } else {
          const defaultBudgets: Record<string, number> = {
            minimal: MIN_THINKING_BUDGET,
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
          const budget = Math.min(requestedBudget, maxTokens - 1);

          // Anthropic rejects budget_tokens below 1024. A small max_tokens (or an
          // explicit budget of 0) would otherwise produce a request the API is
          // guaranteed to refuse; skipping thinking degrades far better.
          if (budget >= MIN_THINKING_BUDGET) {
            params.thinking = { type: "enabled", budget_tokens: budget };
          }
        }
      }

      // Raw stream instead of the MessageStream helper: MessageStream
      // accumulates tool_use input and JSON.parses it on content_block_stop,
      // which throws under fine-grained-tool-streaming (input may be invalid
      // mid-flight) and aborts the turn. The raw stream yields the same
      // RawMessageStreamEvents; tool args are already parsed leniently below.
      const { data: anthropicStream, response: httpResponse } =
        await client.messages
          .create(params, {
            signal: options?.signal,
          })
          .withResponse();

      if (options?.onResponse) {
        try {
          await options.onResponse(
            {
              status: httpResponse.status,
              headers: headersToRecord(httpResponse.headers),
            },
            model,
          );
        } catch {
          // Response hooks are best-effort and should not break streaming.
        }
      }

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
          } else if (event.content_block.type === "redacted_thinking") {
            output.content.push({
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
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
          // stop_reason is `StopReason | null`; mapping null lands in
          // mapStopReason's default and yields "error", which convert.ts then
          // treats as a poisoned turn and drops from the history entirely - so a
          // fully streamed answer would silently vanish on the next request.
          if (event.delta.stop_reason) {
            output.stopReason = mapStopReason(event.delta.stop_reason);
          }

          // Every usage field is nullable, and third-party gateways (baseUrl is
          // caller-configurable) may omit the object outright. Only overwrite
          // what is actually present - the values captured at message_start are
          // the better fallback than zero, especially for the cache counters,
          // which feed both cost and pricing-tier selection.
          const usage = event.usage as
            | {
                input_tokens?: number | null;
                output_tokens?: number | null;
                cache_read_input_tokens?: number | null;
                cache_creation_input_tokens?: number | null;
                output_tokens_details?: { thinking_tokens?: number | null };
              }
            | undefined;

          if (usage) {
            if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
            if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
            if (usage.cache_read_input_tokens != null) {
              output.usage.cacheRead = usage.cache_read_input_tokens;
            }
            if (usage.cache_creation_input_tokens != null) {
              output.usage.cacheWrite = usage.cache_creation_input_tokens;
            }
            const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
            if (thinkingTokens != null) {
              output.usage.reasoning = thinkingTokens;
            }
          }

          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      }

      if (options?.signal?.aborted) throw new Error("Request aborted");
      if (output.stopReason === "error") {
        // Only reachable now via an unrecognized stop_reason string, which is a
        // genuine error rather than a normal completion - don't dress it up as
        // a "done" event whose declared reason it does not satisfy.
        output.errorMessage ??= "Unrecognized stop reason from the API.";
        stream.push({ type: "error", reason: "error", error: output });
      } else {
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
      }
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

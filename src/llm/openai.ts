import OpenAI from "openai";
import type { LLMAdapter, LLMResponse, Message, ToolDefinition } from "./adapter.ts";

export class OpenAIAdapter implements LLMAdapter {
  readonly provider = "openai";
  readonly model: string;
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY no está configurada");
    this.model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.client = new OpenAI({ apiKey });
  }

  async send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    const openaiMessages = messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool" as const, content: m.content, tool_call_id: m.tool_call_id! };
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        return {
          role: "assistant" as const,
          content: m.content ?? null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: tc.function,
          })),
        };
      }
      return { role: m.role as "system" | "user" | "assistant", content: m.content };
    });

    const openaiTools = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools.length ? openaiTools : undefined,
      max_tokens: 4096,
    });

    const choice = response.choices[0];
    return {
      content: choice.message.content,
      tool_calls: (choice.message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: tc.function,
      })),
      usage: response.usage
        ? { prompt_tokens: response.usage.prompt_tokens, completion_tokens: response.usage.completion_tokens }
        : undefined,
    };
  }
}

import { GoogleGenerativeAI, FunctionDeclaration, Tool, SchemaType } from "@google/generative-ai";
import type { LLMAdapter, LLMResponse, Message, ToolDefinition } from "./adapter.ts";

export class GeminiAdapter implements LLMAdapter {
  readonly provider = "google";
  readonly model: string;
  private client: GoogleGenerativeAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY no está configurada");
    this.model = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";
    this.client = new GoogleGenerativeAI(apiKey);
  }

  private async retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = (e as Error).message ?? "";
        const is503 = msg.includes("503") || msg.includes("Service Unavailable") || msg.includes("high demand");
        const is429 = msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("quota");
        if ((is503 || is429) && i < attempts - 1) {
          // Extract retryDelay from error message if present (e.g. "24.729s")
          const match = msg.match(/retry(?:Delay)?[":\s]+"?(\d+(?:\.\d+)?)s/i);
          const wait = match ? Math.ceil(parseFloat(match[1])) * 1000 : 2000 * (i + 1);
          console.warn(`Gemini límite alcanzado, reintentando en ${wait / 1000}s… (intento ${i + 1}/${attempts})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw new Error("Sin respuesta tras reintentos");
  }

  async send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    return this.retry(() => this._send(messages, tools));
  }

  private async _send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      tools: tools.length ? [this.buildTools(tools)] : undefined,
    });

    // Separate system prompt from conversation
    const systemMsg = messages.find((m) => m.role === "system");
    const history = messages.filter((m) => m.role !== "system");

    const chat = model.startChat({
      systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
      history: this.buildHistory(history.slice(0, -1)),
    });

    const lastMessage = history[history.length - 1];
    const lastContent = this.buildLastContent(lastMessage, history);

    const result = await chat.sendMessage(lastContent);
    const response = result.response;

    // Check for function calls
    const fnCalls = response.functionCalls() ?? [];
    if (fnCalls.length) {
      return {
        content: null,
        tool_calls: fnCalls.map((fc, i) => ({
          id: `call_${i}_${fc.name}`,
          type: "function" as const,
          function: { name: fc.name, arguments: JSON.stringify(fc.args) },
        })),
      };
    }

    return { content: response.text(), tool_calls: [] };
  }

  private buildTools(tools: ToolDefinition[]): Tool {
    const declarations: FunctionDeclaration[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: this.convertProperties(
          (t.parameters as { properties: Record<string, { type: string; description: string }> }).properties
        ),
        required: (t.parameters as { required: string[] }).required ?? [],
      },
    }));
    return { functionDeclarations: declarations };
  }

  private convertProperties(
    props: Record<string, { type: string; description: string }>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      const schemaType = this.toSchemaType(val.type);
      result[key] = schemaType === SchemaType.ARRAY
        ? { type: schemaType, description: val.description ?? key, items: { type: SchemaType.STRING } }
        : { type: schemaType, description: val.description ?? key };
    }
    return result;
  }

  private toSchemaType(t: string): SchemaType {
    const map: Record<string, SchemaType> = {
      string: SchemaType.STRING,
      boolean: SchemaType.BOOLEAN,
      number: SchemaType.NUMBER,
      array: SchemaType.ARRAY,
      object: SchemaType.OBJECT,
    };
    return map[t] ?? SchemaType.STRING;
  }

  private buildHistory(msgs: Message[]) {
    const history: { role: "user" | "model"; parts: { text: string }[] }[] = [];
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (m.role === "user") {
        history.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        history.push({ role: "model", parts: [{ text: m.content ?? "" }] });
      } else if (m.role === "tool") {
        // Gemini expects tool results as user messages
        history.push({ role: "user", parts: [{ text: `Tool result: ${m.content}` }] });
      }
      i++;
    }
    return history;
  }

  private buildLastContent(last: Message, history: Message[]): string {
    if (!last) return "";
    if (last.role === "user") return last.content;
    // If last is a tool result, bundle all pending tool results
    const toolResults = history
      .filter((m) => m.role === "tool")
      .map((m) => `Tool result: ${m.content}`)
      .join("\n");
    return toolResults || last.content;
  }
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LLMAdapter {
  send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
  readonly provider: string;
  readonly model: string;
}

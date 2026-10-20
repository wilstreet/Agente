import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { GeminiAdapter } from "./llm/gemini.ts";
import type { LLMAdapter, Message, ToolDefinition } from "./llm/adapter.ts";
import * as tools from "./tools/proveedor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT ?? 3000);
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? 25);

// ─── session store ───────────────────────────────────────────────────────────

const sessions = new Map<string, Message[]>();

function getSession(id: string): Message[] {
  if (!sessions.has(id)) {
    const systemPrompt = fs.readFileSync(path.join(ROOT, "agent", "prompt.md"), "utf-8");
    sessions.set(id, [{ role: "system", content: systemPrompt }]);
  }
  return sessions.get(id)!;
}

// ─── tool registry ───────────────────────────────────────────────────────────

type ToolEntry = {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  execute: (args: Record<string, unknown>, ctx: { directory: string; sessionId: string }) => Promise<string>;
};

function buildToolDefinition(entry: ToolEntry): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(entry.schema)) {
    const def = schema._def as { description?: string; typeName: string };
    properties[key] = {
      type: zodTypeToJsonSchema(schema),
      description: def.description ?? key,
    };
    required.push(key);
  }
  return {
    name: entry.name,
    description: entry.description,
    parameters: { type: "object", properties, required },
  };
}

function zodTypeToJsonSchema(schema: z.ZodTypeAny): string {
  const typeName = (schema._def as { typeName: string }).typeName;
  if (typeName === "ZodString") return "string";
  if (typeName === "ZodBoolean") return "boolean";
  if (typeName === "ZodNumber") return "number";
  if (typeName === "ZodArray") return "array";
  if (typeName === "ZodObject") return "object";
  if (typeName === "ZodEnum") return "string";
  return "string";
}

const toolRegistry: ToolEntry[] = [
  { name: "proveedor_leer_solicitud", description: tools.leer_solicitud.description, schema: tools.leer_solicitud.args, execute: tools.leer_solicitud.execute as ToolEntry["execute"] },
  { name: "proveedor_mapear_campos", description: tools.mapear_campos.description, schema: tools.mapear_campos.args, execute: tools.mapear_campos.execute as ToolEntry["execute"] },
  { name: "proveedor_generar_formulario", description: tools.generar_formulario.description, schema: tools.generar_formulario.args, execute: tools.generar_formulario.execute as ToolEntry["execute"] },
  { name: "proveedor_armar_paquete", description: tools.armar_paquete.description, schema: tools.armar_paquete.args, execute: tools.armar_paquete.execute as ToolEntry["execute"] },
  { name: "proveedor_simular_envio", description: tools.simular_envio.description, schema: tools.simular_envio.args, execute: tools.simular_envio.execute as ToolEntry["execute"] },
];

const toolDefs = toolRegistry.map(buildToolDefinition);
const toolMap = new Map(toolRegistry.map((t) => [t.name, t]));

// ─── agent loop ──────────────────────────────────────────────────────────────

interface ToolCallRecord { name: string; args: Record<string, unknown>; result: string }

async function runAgentLoop(
  llm: LLMAdapter,
  messages: Message[],
  sessionId: string
): Promise<{ reply: string; toolCalls: ToolCallRecord[]; needsConfirmation: boolean }> {
  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await llm.send(messages, toolDefs);

    if (!response.tool_calls.length) {
      const reply = response.content ?? "(sin respuesta)";
      messages.push({ role: "assistant", content: reply });
      const needsConfirmation = /\?/.test(reply) && /(confirma|enviar|proceder|deseas|quieres)/i.test(reply);
      return { reply, toolCalls, needsConfirmation };
    }

    // Assistant message with tool calls
    messages.push({ role: "assistant", content: response.content ?? "", tool_calls: response.tool_calls });

    for (const tc of response.tool_calls) {
      const tool = toolMap.get(tc.function.name);
      let result: string;

      if (!tool) {
        result = JSON.stringify({ ok: false, error: `Herramienta '${tc.function.name}' no existe` });
      } else {
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          result = JSON.stringify({ ok: false, error: "Argumentos inválidos (JSON malformado)" });
          parsedArgs = {};
        }

        // Validate with zod
        const schemaObj = z.object(tool.schema);
        const validation = schemaObj.safeParse(parsedArgs);
        if (!validation.success) {
          result = JSON.stringify({ ok: false, error: `Argumentos inválidos: ${validation.error.message}` });
        } else {
          result = await tool.execute(validation.data as Record<string, unknown>, { directory: ROOT, sessionId });
        }
      }

      toolCalls.push({ name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>, result });
      messages.push({ role: "tool", content: result, tool_call_id: tc.id });
    }
  }

  const reply = "Se alcanzó el límite de iteraciones. Aquí está lo procesado hasta ahora.";
  messages.push({ role: "assistant", content: reply });
  return { reply, toolCalls, needsConfirmation: false };
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

let llm: LLMAdapter;
try {
  llm = new GeminiAdapter();
} catch (e) {
  console.error("Error inicializando LLM:", (e as Error).message);
  process.exit(1);
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error("JSON inválido")); }
    });
  });
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST" });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Serve frontend
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true, provider: llm.provider, model: llm.model });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop() ?? "";
    const msgs = sessions.get(id);
    if (!msgs) { send(res, 404, { error: "Sesión no encontrada" }); return; }
    send(res, 200, { messages: msgs.filter((m) => m.role !== "system") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await parseBody(req) as { sessionId?: string; message?: string };
      if (!body.sessionId || !body.message) {
        send(res, 400, { error: "Se requieren sessionId y message" });
        return;
      }
      const messages = getSession(body.sessionId);
      messages.push({ role: "user", content: body.message });
      const result = await runAgentLoop(llm, messages, body.sessionId);
      send(res, 200, result);
    } catch (e) {
      const msg = (e as Error).message ?? "Error interno";
      // Never expose API keys in errors
      const safe = msg.replace(/sk-[a-zA-Z0-9]+/g, "<clave>");
      send(res, 500, { error: safe });
    }
    return;
  }

  send(res, 404, { error: "Ruta no encontrada" });
});

server.listen(PORT, () => {
  console.log(`Agente listo en http://localhost:${PORT}`);
  console.log(`Proveedor: ${llm.provider} | Modelo: ${llm.model}`);
});

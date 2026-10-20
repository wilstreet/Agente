import { z } from "zod";
import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

// ─── helpers ────────────────────────────────────────────────────────────────

interface Ctx { directory: string; sessionId: string }

function fixturesDir(ctx: Ctx) {
  return path.join(ctx.directory, "fixtures", "reto-01");
}

function outDir(ctx: Ctx, caso: string) {
  return path.join(ctx.directory, "out", caso);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLog(ctx: Ctx, caso: string, entry: Record<string, unknown>) {
  const dir = outDir(ctx, caso);
  ensureDir(dir);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(path.join(dir, "log.jsonl"), line + "\n");
}

/** Resolve a dot-path like "representante_legal.nombre" against an object */
function resolvePath(obj: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

const FOREIGN_ID_MAP: Record<string, string> = { EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" };
const FOREIGN_ID_LABELS = new Set(["RUC", "RTN", "Identificación tributaria", "Número de identificación fiscal"]);

// ─── tool 1: leer_solicitud ──────────────────────────────────────────────────

export const leer_solicitud = {
  description: "Lee el correo de solicitud y la plantilla del caso para obtener campos, formato y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    try {
      const base = path.join(fixturesDir(ctx), "casos", args.caso);
      if (!fs.existsSync(base)) {
        return JSON.stringify({ ok: false, error: `Caso '${args.caso}' no encontrado en fixtures` });
      }

      const solicitud = readJson<{
        id: string; pais: string; cliente: string; formato: string; adjuntos: string[];
      }>(path.join(base, "solicitud.json"));

      let campos: string[] = [];
      const formato = solicitud.formato as "xlsx" | "pdf" | "portal";

      if (formato === "xlsx") {
        const plantilla = readJson<{ etiqueta: string }[]>(path.join(base, "plantilla-celdas.json"));
        campos = plantilla.map((c) => c.etiqueta);
      } else if (formato === "pdf") {
        const plantilla = readJson<{ etiqueta: string; obligatorio: boolean }[]>(
          path.join(base, "plantilla-campos.json")
        );
        campos = plantilla.map((c) => c.etiqueta);
      }

      const soportes = readJson<string[]>(path.join(base, "soportes-exigidos.json"));

      const data = { pais: solicitud.pais, cliente: solicitud.cliente, formato, campos, soportes };
      appendLog(ctx, args.caso, { herramienta: "leer_solicitud", ok: true, resumen: `${campos.length} campos, ${soportes.length} soportes` });
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: `Error leyendo solicitud: ${(e as Error).message}` });
    }
  },
};

// ─── tool 2: mapear_campos ───────────────────────────────────────────────────

export const mapear_campos = {
  description: "Cruza los campos solicitados con el repositorio maestro usando el glosario de sinónimos.",
  args: {
    caso: z.string().describe("Nombre del caso"),
    campos: z.array(z.string()).describe("Lista de etiquetas de campos a mapear"),
    pais: z.string().describe("Código de país del cliente (CO, EC, PE, PA, HN)"),
  },
  async execute(args: { caso: string; campos: string[]; pais: string }, ctx: Ctx): Promise<string> {
    try {
      const maestro = readJson<Record<string, unknown>>(
        path.join(fixturesDir(ctx), "repositorio", "maestro.json")
      );
      const glosario = readJson<Record<string, string>>(
        path.join(fixturesDir(ctx), "glosario-campos.json")
      );

      const llenos: { etiqueta: string; clave: string; valor: unknown }[] = [];
      const faltantes: string[] = [];
      const requiere_confirmacion: { etiqueta: string; clave: string; valor: unknown; nota: string }[] = [];

      for (const etiqueta of args.campos) {
        const clave = glosario[etiqueta];
        if (!clave) {
          faltantes.push(etiqueta);
          continue;
        }

        const valor = resolvePath(maestro, clave);
        if (valor === undefined || valor === null) {
          faltantes.push(etiqueta);
          continue;
        }

        // Regla RN1: identificador tributario extranjero
        const isForeignId = FOREIGN_ID_LABELS.has(etiqueta) || FOREIGN_ID_MAP[args.pais] === etiqueta;
        if (isForeignId && args.pais !== "CO") {
          const expectedLabel = FOREIGN_ID_MAP[args.pais] ?? etiqueta;
          requiere_confirmacion.push({
            etiqueta,
            clave,
            valor,
            nota: `identificador extranjero — se usa NIT colombiano como ${expectedLabel}`,
          });
          continue;
        }

        llenos.push({ etiqueta, clave, valor });
      }

      const data = { llenos, faltantes, requiere_confirmacion };
      appendLog(ctx, args.caso, {
        herramienta: "mapear_campos",
        ok: true,
        resumen: `llenos:${llenos.length} faltantes:${faltantes.length} confirmacion:${requiere_confirmacion.length}`,
      });
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: `Error mapeando campos: ${(e as Error).message}` });
    }
  },
};

// ─── tool 3: generar_formulario ──────────────────────────────────────────────

interface CampoMapeado { etiqueta: string; clave: string; valor: unknown }
interface MapeoCompleto {
  llenos: CampoMapeado[];
  faltantes: string[];
  requiere_confirmacion: (CampoMapeado & { nota: string })[];
}

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato pedido (xlsx, pdf o portal).",
  args: {
    caso: z.string().describe("Nombre del caso"),
    mapeo: z.object({
      llenos: z.array(z.object({ etiqueta: z.string(), clave: z.string(), valor: z.unknown() })),
      faltantes: z.array(z.string()),
      requiere_confirmacion: z.array(z.object({ etiqueta: z.string(), clave: z.string(), valor: z.unknown(), nota: z.string() })),
    }).describe("Resultado de mapear_campos"),
    formato: z.enum(["xlsx", "pdf", "portal"]).describe("Formato de salida"),
  },
  async execute(args: { caso: string; mapeo: MapeoCompleto; formato: "xlsx" | "pdf" | "portal" }, ctx: Ctx): Promise<string> {
    try {
      const dir = outDir(ctx, args.caso);
      ensureDir(dir);

      if (args.formato === "portal") {
        const lines = ["# Valores para portal web\n"];
        const allFields = [
          ...args.mapeo.llenos.map((f) => ({ etiqueta: f.etiqueta, valor: String(f.valor) })),
          ...args.mapeo.requiere_confirmacion.map((f) => ({ etiqueta: f.etiqueta, valor: `${String(f.valor)} ⚠️ ${f.nota}` })),
          ...args.mapeo.faltantes.map((e) => ({ etiqueta: e, valor: "[FALTANTE]" })),
        ];
        for (const f of allFields) lines.push(`**${f.etiqueta}**: ${f.valor}`);
        const ruta = path.join(dir, "valores-portal.md");
        fs.writeFileSync(ruta, lines.join("\n"));
        appendLog(ctx, args.caso, { herramienta: "generar_formulario", ok: true, resumen: "portal — valores-portal.md generado" });
        return JSON.stringify({ ok: true, data: { ruta, formato: "portal", mensaje: "formato no soportado — se generó valores-portal.md" } });
      }

      const base = path.join(fixturesDir(ctx), "casos", args.caso);
      const valorMap = new Map<string, string>();
      for (const f of args.mapeo.llenos) valorMap.set(f.etiqueta, String(f.valor));
      for (const f of args.mapeo.requiere_confirmacion) valorMap.set(f.etiqueta, String(f.valor));

      if (args.formato === "xlsx") {
        const plantilla = readJson<{ hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }[]>(
          path.join(base, "plantilla-celdas.json")
        );
        const wb = new ExcelJS.Workbook();
        const sheets = new Map<string, ExcelJS.Worksheet>();
        for (const row of plantilla) {
          if (!sheets.has(row.hoja)) sheets.set(row.hoja, wb.addWorksheet(row.hoja));
          const ws = sheets.get(row.hoja)!;
          ws.getCell(row.celda_etiqueta).value = row.etiqueta;
          ws.getCell(row.celda_valor).value = valorMap.get(row.etiqueta) ?? "";
        }
        const ruta = path.join(dir, "formulario.xlsx");
        await wb.xlsx.writeFile(ruta);
        appendLog(ctx, args.caso, { herramienta: "generar_formulario", ok: true, resumen: `xlsx generado: ${ruta}` });
        return JSON.stringify({ ok: true, data: { ruta, formato: "xlsx" } });
      }

      if (args.formato === "pdf") {
        const plantilla = readJson<{ etiqueta: string; obligatorio: boolean }[]>(
          path.join(base, "plantilla-campos.json")
        );
        const ruta = path.join(dir, "formulario.pdf");
        await new Promise<void>((resolve, reject) => {
          const doc = new PDFDocument({ margin: 50 });
          const stream = fs.createWriteStream(ruta);
          doc.pipe(stream);
          doc.fontSize(16).text("Formulario de Registro como Proveedor", { align: "center" });
          doc.moveDown();
          for (const campo of plantilla) {
            const valor = valorMap.get(campo.etiqueta) ?? (campo.obligatorio ? "[FALTANTE]" : "");
            doc.fontSize(11).text(`${campo.etiqueta}:`, { continued: false });
            doc.fontSize(11).fillColor(valor === "[FALTANTE]" ? "red" : "black").text(`  ${valor}`).fillColor("black");
            doc.moveDown(0.5);
          }
          doc.end();
          stream.on("finish", resolve);
          stream.on("error", reject);
        });
        appendLog(ctx, args.caso, { herramienta: "generar_formulario", ok: true, resumen: `pdf generado: ${ruta}` });
        return JSON.stringify({ ok: true, data: { ruta, formato: "pdf" } });
      }

      return JSON.stringify({ ok: false, error: `Formato desconocido: ${args.formato}` });
    } catch (e) {
      return JSON.stringify({ ok: false, error: `Error generando formulario: ${(e as Error).message}` });
    }
  },
};

// ─── tool 4: armar_paquete ───────────────────────────────────────────────────

export const armar_paquete = {
  description: "Arma el paquete para firma: copia soportes, genera checklist y borrador de correo.",
  args: {
    caso: z.string().describe("Nombre del caso"),
  },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    try {
      const base = path.join(fixturesDir(ctx), "casos", args.caso);
      const soportesDir = path.join(fixturesDir(ctx), "repositorio", "soportes");
      const paqueteDir = path.join(outDir(ctx, args.caso), "paquete");
      ensureDir(paqueteDir);

      const solicitud = readJson<{ cliente: string; pais: string; formato: string }>(
        path.join(base, "solicitud.json")
      );
      const soportesExigidos = readJson<string[]>(path.join(base, "soportes-exigidos.json"));
      const soportesIndex = readJson<{ tipo: string; archivo: string; vigencia_hasta: string | null }[]>(
        path.join(soportesDir, "index.json")
      );

      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);

      const checklist: string[] = ["# Checklist de soportes\n"];
      let listoParaFirma = true;
      const bloqueos: string[] = [];

      for (const tipo of soportesExigidos) {
        const soporte = soportesIndex.find((s) => s.tipo === tipo);
        if (!soporte) {
          checklist.push(`- [ ] **${tipo}** — ❌ AUSENTE (bloquea firma)`);
          listoParaFirma = false;
          bloqueos.push(`soporte ausente: ${tipo}`);
          continue;
        }

        const archivoSrc = path.join(soportesDir, soporte.archivo);
        const archivoDst = path.join(paqueteDir, soporte.archivo);

        if (fs.existsSync(archivoSrc)) {
          fs.copyFileSync(archivoSrc, archivoDst);
        }

        if (soporte.vigencia_hasta) {
          const vigencia = new Date(soporte.vigencia_hasta);
          if (vigencia < hoy) {
            checklist.push(`- [ ] **${tipo}** — ⚠️ VENCIDO (${soporte.vigencia_hasta}) — bloquea firma`);
            listoParaFirma = false;
            bloqueos.push(`soporte vencido: ${tipo} (${soporte.vigencia_hasta})`);
            continue;
          }
        }
        checklist.push(`- [x] **${tipo}** — ✅ presente${soporte.vigencia_hasta ? ` (vigente hasta ${soporte.vigencia_hasta})` : ""}`);
      }

      // Copiar formulario al paquete
      const outCasoDir = outDir(ctx, args.caso);
      const exts = ["xlsx", "pdf"];
      for (const ext of exts) {
        const src = path.join(outCasoDir, `formulario.${ext}`);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(paqueteDir, `formulario.${ext}`));
        }
      }

      fs.writeFileSync(path.join(paqueteDir, "checklist.md"), checklist.join("\n"));

      const borrador = [
        `# Borrador de correo\n`,
        `**Para:** ${solicitud.cliente}`,
        `**Asunto:** Registro como proveedor — Periferia IT Group S.A.S.\n`,
        `Estimados,\n`,
        `Adjuntamos el formulario de registro como proveedor debidamente diligenciado, junto con los soportes solicitados.\n`,
        `Quedamos atentos a cualquier consulta.\n`,
        `Atentamente,\n**Periferia IT Group S.A.S.**`,
      ].join("\n");
      fs.writeFileSync(path.join(paqueteDir, "borrador-correo.md"), borrador);

      const data = {
        ruta: paqueteDir,
        listo_para_firma: listoParaFirma,
        bloqueos,
        checklist: checklist.join("\n"),
      };
      appendLog(ctx, args.caso, {
        herramienta: "armar_paquete",
        ok: true,
        resumen: `listo_para_firma:${listoParaFirma} bloqueos:${bloqueos.length}`,
      });
      return JSON.stringify({ ok: true, data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: `Error armando paquete: ${(e as Error).message}` });
    }
  },
};

// ─── tool 5: simular_envio ───────────────────────────────────────────────────

export const simular_envio = {
  description: "Simula el envío del paquete. Solo procede si el usuario confirmó explícitamente.",
  args: {
    caso: z.string().describe("Nombre del caso"),
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente en el turno anterior"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Ctx): Promise<string> {
    if (!args.confirmado) {
      return JSON.stringify({ ok: false, error: "requiere confirmación explícita del usuario" });
    }
    try {
      const dir = outDir(ctx, args.caso);
      ensureDir(dir);
      const ruta = path.join(dir, "ENVIO-SIMULADO.md");
      const contenido = [
        `# Envío simulado`,
        `**Caso:** ${args.caso}`,
        `**Fecha:** ${new Date().toISOString()}`,
        ``,
        `El paquete fue preparado y marcado como enviado (simulación).`,
        `En producción, aquí se adjuntaría el paquete y se enviaría al cliente.`,
      ].join("\n");
      fs.writeFileSync(ruta, contenido);
      appendLog(ctx, args.caso, { herramienta: "simular_envio", ok: true, resumen: `ENVIO-SIMULADO.md generado` });
      return JSON.stringify({ ok: true, data: { ruta } });
    } catch (e) {
      return JSON.stringify({ ok: false, error: `Error simulando envío: ${(e as Error).message}` });
    }
  },
};

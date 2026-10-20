/**
 * demo.ts — Ejecuta todas las herramientas directamente sin modelo LLM.
 * Corre con: node --env-file=.env demo.ts
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import * as tools from "./src/tools/proveedor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CASOS_DIR = path.join(ROOT, "fixtures", "reto-01", "casos");

// Limpiar out/ al inicio para determinismo
const outDir = path.join(ROOT, "out");
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true });
fs.mkdirSync(outDir);

const casos = fs.readdirSync(CASOS_DIR).filter((d) =>
  fs.statSync(path.join(CASOS_DIR, d)).isDirectory()
);

console.log(`\n${"=".repeat(60)}`);
console.log("DEMO — Agente Registro como Proveedor");
console.log(`Casos encontrados: ${casos.join(", ")}`);
console.log("=".repeat(60));

for (const caso of casos) {
  const ctx = { directory: ROOT, sessionId: `demo-${caso}` };
  console.log(`\n--- CASO: ${caso} ---`);

  // 1. Leer solicitud
  const r1 = JSON.parse(await tools.leer_solicitud.execute({ caso }, ctx)) as {
    ok: boolean; data?: { pais: string; cliente: string; formato: string; campos: string[]; soportes: string[] }; error?: string;
  };
  if (!r1.ok) { console.log(`  ❌ leer_solicitud: ${r1.error}`); continue; }
  console.log(`  ✅ leer_solicitud: ${r1.data!.cliente} (${r1.data!.pais}) — formato: ${r1.data!.formato}`);
  console.log(`     campos: ${r1.data!.campos.length} | soportes: ${r1.data!.soportes.length}`);

  // 2. Mapear campos
  const r2 = JSON.parse(
    await tools.mapear_campos.execute({ caso, campos: r1.data!.campos, pais: r1.data!.pais }, ctx)
  ) as {
    ok: boolean;
    data?: { llenos: unknown[]; faltantes: string[]; requiere_confirmacion: { etiqueta: string; nota: string }[] };
    error?: string;
  };
  if (!r2.ok) { console.log(`  ❌ mapear_campos: ${r2.error}`); continue; }
  console.log(`  ✅ mapear_campos: llenos:${r2.data!.llenos.length} faltantes:${r2.data!.faltantes.length} confirmacion:${r2.data!.requiere_confirmacion.length}`);
  if (r2.data!.faltantes.length) console.log(`     faltantes: ${r2.data!.faltantes.join(", ")}`);
  if (r2.data!.requiere_confirmacion.length) {
    for (const c of r2.data!.requiere_confirmacion) console.log(`     ⚠️  ${c.etiqueta}: ${c.nota}`);
  }

  // 3. Generar formulario
  const r3 = JSON.parse(
    await tools.generar_formulario.execute({ caso, mapeo: r2.data!, formato: r1.data!.formato as "xlsx" | "pdf" | "portal" }, ctx)
  ) as { ok: boolean; data?: { ruta: string; formato: string; mensaje?: string }; error?: string };
  if (!r3.ok) { console.log(`  ❌ generar_formulario: ${r3.error}`); continue; }
  console.log(`  ✅ generar_formulario: ${r3.data!.ruta}`);
  if (r3.data!.mensaje) console.log(`     ℹ️  ${r3.data!.mensaje}`);

  // 4. Armar paquete
  const r4 = JSON.parse(await tools.armar_paquete.execute({ caso }, ctx)) as {
    ok: boolean;
    data?: { ruta: string; listo_para_firma: boolean; bloqueos: string[] };
    error?: string;
  };
  if (!r4.ok) { console.log(`  ❌ armar_paquete: ${r4.error}`); continue; }
  const estado = r4.data!.listo_para_firma ? "✅ LISTO PARA FIRMA" : "🔒 BLOQUEADO";
  console.log(`  ✅ armar_paquete: ${estado}`);
  if (r4.data!.bloqueos.length) console.log(`     bloqueos: ${r4.data!.bloqueos.join(" | ")}`);

  // 5. Simular envío sin confirmación (debe fallar)
  const r5a = JSON.parse(await tools.simular_envio.execute({ caso, confirmado: false }, ctx)) as { ok: boolean; error?: string };
  console.log(`  ✅ simular_envio(sin confirmar): ok=${r5a.ok} — ${r5a.error ?? ""}`);

  // 5b. Simular envío con confirmación
  const r5b = JSON.parse(await tools.simular_envio.execute({ caso, confirmado: true }, ctx)) as { ok: boolean; data?: { ruta: string } };
  console.log(`  ✅ simular_envio(confirmado): ${r5b.data?.ruta ?? "error"}`);
}

console.log(`\n${"=".repeat(60)}`);
console.log("Demo completado. Revisa out/ para los archivos generados.");
console.log("=".repeat(60) + "\n");

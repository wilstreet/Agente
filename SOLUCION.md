# SOLUCION.md — Agente Registro como Proveedor

## 1. Problema

El área administrativa de Periferia transcribe manualmente los mismos datos en formularios de registro como proveedor para cada cliente, con riesgo de error y demoras que retrasan la facturación.

---

## 2. Arquitectura

```
web/index.html  →  src/server.ts  →  src/tools/proveedor.ts  →  fixtures/ (lectura)
                                                               →  out/<caso>/  (escritura)
                        ↓
                 src/llm/gemini.ts  →  Gemini API
```

- `agent/prompt.md` — comportamiento del agente
- `src/knowledge/registro-proveedor.md` — reglas de negocio
- `src/tools/proveedor.ts` — única fuente de valores (nunca el modelo)

---

## 3. Ciclo del agente

1. Mensaje del usuario → se agrega al historial de sesión
2. Se llama a Gemini con historial + definiciones de herramientas
3. Si el modelo devuelve tool calls → se validan con zod, se ejecutan, resultado al historial
4. Se repite hasta que el modelo responde en texto o se alcanza `MAX_ITERATIONS`
5. Si la respuesta contiene confirmación pendiente → `needsConfirmation: true` y el front lo resalta
6. `proveedor_simular_envio` requiere `confirmado: true` en los args — el modelo solo lo pasa si el usuario confirmó explícitamente

---

## 4. Modelo

- **Proveedor**: Google Gemini — capa gratuita (5 req/min)
- **Modelo**: `gemini-2.5-flash`
- **Costo por caso**: $0 en capa gratuita
- **Rate limit**: retry automático extrayendo el `retryDelay` del error 429, hasta 4 intentos. También maneja 503 con backoff.

---

## 5. Diseño portal web (P2)

No implementado. El agente genera `valores-portal.md` con los valores listos para copiar.

Para producción: automatización con Playwright como herramienta adicional `proveedor_llenar_portal`. Ante CAPTCHA o MFA la herramienta pausa y devuelve `requiere_intervencion_humana`. El clic en "Enviar" siempre es humano. Credenciales en variables de entorno del servidor, nunca en el repo ni en logs.

---

## 6. Decisiones

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| HTTP nativo de Node | Express / Fastify | Sin dependencias extra, suficiente para el reto |
| Sesiones en `Map` en memoria | SQLite / Redis | PRD no requiere persistencia entre reinicios |
| PDFKit (PDF generado) | pdf-lib AcroForm | PRD lo permite; más simple sin el PDF original del cliente |
| Gemini capa gratuita | OpenAI gpt-4o-mini | Sin costo, sin tarjeta de crédito requerida |

---

## 7. Supuestos

- Los fixtures representan la variabilidad real de los clientes
- El repositorio maestro está actualizado
- "Confirmación explícita" = el usuario escribe sí / confirmo / procede en el turno anterior
- `parafiscales` con `vigencia_hasta: 2026-08-31` se considera vencido si la ejecución es posterior

---

## 8. Cobertura

| Historia | Estado |
|---|---|
| HU-1 Leer solicitud | ✅ |
| HU-2 Mapear campos | ✅ |
| HU-3 Generar formulario (xlsx, pdf, portal) | ✅ |
| HU-4 Armar paquete | ✅ |
| HU-5 Manejo de errores | ✅ |

Pendiente para producción: pruebas unitarias, sesiones persistentes, autenticación del endpoint.

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Modelo inventa un valor faltante | Las herramientas son la única fuente; el prompt lo prohíbe |
| Rate limit 5 req/min en capa gratuita | Retry automático con `retryDelay` del error 429; en producción usar plan de pago |
| Sesiones se pierden al reiniciar | En producción: Redis o archivos JSONL por sesión |
| Soportes vencen sin aviso | Alertas de vencimiento próximo (30 días antes) |

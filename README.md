# Agente Registro como Proveedor — Periferia IT Group

## Levantar en local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env y agrega tu GEMINI_API_KEY

# 3. Levantar el servidor (front + backend en un comando)
npm run dev
# → http://localhost:3000
```

## Variables de entorno requeridas

| Variable | Descripción | Ejemplo |
|---|---|---|
| `GEMINI_API_KEY` | Clave de Google AI Studio | `AIza...` |
| `GEMINI_MODEL` | Modelo a usar | `gemini-2.5-flash` |
| `MAX_ITERATIONS` | Tope de iteraciones por turno | `25` |
| `MAX_TOKENS_PER_SESSION` | Tope de tokens por sesión | `50000` |
| `PORT` | Puerto del servidor | `3000` |

## Correr demo sin modelo

```bash
npx tsx demo.ts
```

Ejecuta todas las herramientas directamente sobre los 4 casos de fixtures e imprime un resumen. No requiere clave de API.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model }` |

## Prompt de demo

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

## Link de prueba

Ver `SOLUCION.md` sección de despliegue.

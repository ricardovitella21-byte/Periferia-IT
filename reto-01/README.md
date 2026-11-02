# Reto 01 · Agente "Registro como Proveedor"

Agente conversacional que lee una solicitud de registro como proveedor, llena el formulario del cliente (Excel o PDF) con el repositorio maestro, arma el paquete de soportes para la firma del representante legal y pide confirmación antes de cualquier envío.

- Enunciado: [`PRD.md`](PRD.md)
- Planteamiento de la solución: [`SOLUCION.md`](SOLUCION.md)
- **Link de prueba:** _pendiente de despliegue_

## Requisitos

- [Bun](https://bun.sh) 1.1 o superior (probado con 1.4.4)
- Una API key de Anthropic para el chat con modelo. `demo.ts`, las pruebas y el modo sin modelo no la necesitan.

## Levantar en local (un comando)

```bash
bun install
cp .env.example .env    # y pon tu ANTHROPIC_API_KEY
bun run dev
```

Abre <http://localhost:3000>. El mismo proceso sirve el chat y la API.

Para probar el chat **sin clave**, con un proveedor determinista que sigue el flujo estándar:

```bash
bun run dev:sin-modelo
```

## Verificación sin modelo

```bash
bun install && bun run demo.ts
```

Procesa los 4 casos de `fixtures/reto-01/casos/` llamando directamente a las herramientas, con fecha de referencia fija `2026-09-03`. También muestra el bloqueo del envío sin confirmación y el manejo de errores (caso inexistente y plantilla dañada). Limpia `out/` al empezar.

Resultado esperado:

| Caso | Formato | Campos | Paquete |
|---|---|---|---|
| `co-industrias-delta` | xlsx | 17 llenos | ✅ listo para firma |
| `ec-corp-andina` | pdf | 13 llenos · RUC por confirmar · 1 faltante | ⛔ falta certificado de cumplimiento tributario |
| `hn-agroexport-sula` | xlsx | 9 llenos · RTN por confirmar · 1 faltante | ⛔ parafiscales vencidos |
| `pa-logistica-istmo` | portal | 8 llenos · RUC por confirmar | ✅ (valores para copiar en el portal) |

Otros comandos:

```bash
bun test            # 31 pruebas: reglas de negocio, ciclo del agente, confirmación, tope, errores, módulo
bun run typecheck   # TypeScript estricto, sin any
bun run modulo      # regenera modulo/ desde las fuentes de la app (--check para verificar)
```

## Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clave del modelo. Solo en el backend; nunca llega al front, a los logs ni a las respuestas. |
| `LLM_PROVIDER` | `anthropic` | `anthropic` o `guion` (sin IA, para pruebas). |
| `LLM_MODEL` | `claude-sonnet-5-5` | Modelo de Claude. |
| `LLM_EFFORT` | `medium` | Esfuerzo de razonamiento (`low` a `max`). |
| `LLM_MAX_TOKENS` | `16000` | Tope de tokens de salida por llamada. |
| `LLM_TIMEOUT_MS` | `90000` | Timeout por llamada al modelo. |
| `LLM_FALLBACK` | `default` | Reintento del servidor de Anthropic en otro modelo si este declina por política. |
| `MAX_ITERACIONES` | `25` | Tope de llamadas modelo → herramienta por turno. |
| `MAX_TOKENS_SESION` | `400000` | Tope de tokens por sesión. |
| `MAX_TOKENS_DIA` | `5000000` | Tope global diario del servidor. |
| `PORT` | `3000` | Puerto HTTP. |
| `ACCESS_KEY` | — | Si se define, la API exige el encabezado `x-clave-acceso` y el chat la pide una vez. |
| `FECHA_REFERENCIA` | — | Fecha fija (YYYY-MM-DD) para evaluar vigencias. Vacío = fecha de ejecución. |
| `ZONA_HORARIA` | `America/Bogota` | Zona horaria para la fecha de ejecución. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error, iteraciones, tokens, tokensSesion }`. Sin `sessionId` crea una sesión. |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (mensajes, llamadas a herramientas, tokens). |
| `GET` | `/api/health` | `{ ok: true, provider, model, requiereClave, maxIteraciones }`, sin claves. |
| `GET` | `/api/casos` | Casos disponibles (atajo del chat). |
| `GET` | `/api/archivos/<ruta en out/>` | Descarga de archivos generados (confinada a `out/`). |

Cada elemento de `toolCalls` es `{ id, nombre, argumentos, ok, resumen, duracionMs, archivos[] }`.

Errores: `{ ok: false, error }` con estado 400 (cuerpo inválido), 401 (clave de acceso), 404 (sesión inexistente) o 409 (la sesión ya procesa un mensaje).

## Prompt de ejemplo

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

Luego responde `envía` (o usa el botón "Sí, confirmo"): solo entonces se escribe `out/ec-corp-andina/ENVIO-SIMULADO.md`.

Para evaluar las vigencias como en la fecha del PRD, agrega "con fecha 2026-09-03" al mensaje.

## Estructura

```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/                      conocimiento: proceso (.md) y reglas como datos (.json)
src/tools/proveedor.ts              herramientas del proceso → proveedor_<export>
src/tools/agente.ts                 herramienta de confirmación → agente_pedir_confirmacion
src/tools/lib/                      lógica de las herramientas (mapeo, formularios, paquete, logs)
src/agent/                          ciclo del agente, registro de herramientas, sesiones, confirmación
src/llm/                            adaptador propio + Anthropic + proveedor de prueba sin IA
src/server.ts                       API HTTP (Bun.serve) y front
web/                                chat (HTML + TypeScript, sin framework)
demo.ts                             herramientas sin modelo
modulo/                             bonus: agente empaquetado para otras plataformas
tests/                              pruebas (bun test)
fixtures/                           entregados por Periferia (no se modifican)
out/                                generado en ejecución (no se versiona)
```

## Despliegue

El `Dockerfile` levanta el servidor en el puerto `PORT`. En Render, Railway o Fly.io: crear un servicio desde el repositorio con raíz `reto-01/`, definir `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`) como variables secretas del servicio.

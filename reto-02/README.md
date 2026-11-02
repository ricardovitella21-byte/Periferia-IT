# Reto 02 · Agente "Registro de Contratos Vigentes"

Agente conversacional que actúa como **punto único de recepción** de contratos. Lee el buzón, extrae los datos de cada contrato con su nivel de confianza, detecta duplicados y actualizaciones (otrosíes), archiva el documento en una estructura tipo SharePoint y alimenta el maestro con historial. Antes de registrar algo dudoso, pregunta. Al final genera alertas de vencimientos y pólizas.

- Enunciado: [`PRD.md`](PRD.md)
- Planteamiento de la solución y **regla de gobierno**: [`SOLUCION.md`](SOLUCION.md)
- **Link de prueba:** <https://periferia-reto-02-contratos-kn54.onrender.com> (público, sin clave de acceso; si lleva 15 minutos sin uso tarda alrededor de un minuto en despertar)

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

Para probar el chat **sin clave**, con un proveedor determinista que recorre el buzón mensaje por mensaje:

```bash
bun run dev:sin-modelo
```

## Verificación sin modelo

```bash
bun install && bun run demo.ts
```

Procesa los 6 mensajes en orden llamando directamente a las herramientas, con fecha de referencia fija `2026-09-03`. Limpia `out/` al empezar. Después hace una segunda llamada con `confirmado: true` para `msg-006`, genera las alertas y muestra el manejo de errores.

Resultado esperado:

| Mensaje | Qué prueba | Clasificación | Acción |
|---|---|---|---|
| `msg-001` | Contrato nuevo con póliza | `nuevo` | Insertado `CT-2026-015`, póliza `pendiente` |
| `msg-002` | Contrato nuevo sin póliza | `nuevo` | Insertado `CT-2026-016`, `no_aplica` |
| `msg-003` | Otrosí del `CT-2026-011` | `actualizacion` | Valor 350.000 → 520.000 PEN, fin 2027-05-01 → 2027-11-01, póliza → `pendiente`; historial |
| `msg-004` | Reenvío del `CT-2026-012` | `duplicado` | Sin escritura |
| `msg-005` | Cotización | `rechazado` | Sin escritura, con motivo |
| `msg-006` | Contrato marco por demanda, remitente no registrado | `nuevo` con revisión (valor, fecha_inicio, fecha_fin) | No se registra; en la segunda pasada, con `confirmado: true`, se inserta `CM-2026-03` con valor 0 y fin 2027-08-31 |

Alertas al 2026-09-03: vencen `CT-2026-009` y `CT-2026-004`; pólizas pendientes `CT-2026-004`, `CT-2026-011`, `CT-2026-015` y `CM-2026-03`; registrados desde el corte `CT-2026-015`, `CT-2026-016` y `CM-2026-03`.

Otros comandos:

```bash
bun test            # 28 pruebas: extracción, clasificación, registro, alertas, errores, ciclo, confirmación, módulo
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
| `MAX_ITERACIONES` | `25` | Tope de llamadas al modelo por turno. |
| `MAX_TOKENS_SESION` | `400000` | Tope de tokens por sesión. |
| `MAX_TOKENS_DIA` | `5000000` | Tope global diario del servidor. |
| `PORT` | `3000` | Puerto HTTP. |
| `ACCESS_KEY` | — | Si se define, la API exige el encabezado `x-clave-acceso` y el chat la pide una vez. |
| `FECHA_REFERENCIA` | — | Fecha fija (YYYY-MM-DD) para `fecha_registro` y el `hoy` que informa el buzón. |
| `ZONA_HORARIA` | `America/Bogota` | Zona horaria para la fecha de ejecución. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error, iteraciones, tokens, tokensSesion }`. Sin `sessionId` crea una sesión. |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión. |
| `GET` | `/api/health` | `{ ok: true, provider, model, requiereClave, maxIteraciones }`, sin claves. |
| `GET` | `/api/buzon` | Mensajes pendientes del buzón (atajo del chat). |
| `GET` | `/api/archivos/<ruta en out/>` | Descarga de archivos generados (confinada a `out/`). |

Cada elemento de `toolCalls` es `{ id, nombre, argumentos, ok, resumen, duracionMs, archivos[] }`. Errores: `{ ok: false, error }` con estado 400, 401, 404 o 409.

## Herramientas

| Herramienta | Entrada | Salida (`data`) |
|---|---|---|
| `contratos_leer_buzon` | `{}` | `{ hoy, mensajes[], pendientes, procesados }` |
| `contratos_extraer` | `{ mensaje_id }` | `{ contrato, confianza, notas, tipo_documento, campos_baja_confianza, advertencias }` |
| `contratos_validar` | `{ mensaje_id, contrato }` | `{ clasificacion, id_contrato_existente, requiere_revision[], revision[], diferencias[], motivo, contrato_a_registrar }` |
| `contratos_registrar` | `{ mensaje_id, contrato, confirmado? }` | `{ id_contrato, accion, ruta_archivo }` o `{ ok: false, error: "requiere revisión: ..." }` |
| `contratos_alertas` | `{ hoy }` | `{ ruta, vencen[], polizas_pendientes[], registrados_desde_corte[], ... }` |
| `contratos_leer_pdf` (P1) | `{ ruta }` | `{ texto }` |

## Prompt de ejemplo

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Luego responde `confirmo el valor 0 y la fecha fin 2027-08-31`: solo entonces se registra `msg-006`.

## Salidas

```
out/sharepoint/maestro-contratos.csv     copia viva del maestro (el fixture no se toca)
out/sharepoint/Contratos/<año>/<cliente>/ documentos archivados (otrosíes como <id>-otrosi-<n>)
out/sharepoint/historial.jsonl           { ts, id_contrato, accion, cambios, mensaje_id }
out/procesados.json                      mensajes ya procesados
out/alertas.md                           reporte de alertas
out/log.jsonl                            { ts, herramienta, mensaje_id, ok, resumen } por llamada
```

## Estructura

```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/                      conocimiento: proceso (.md) y reglas como datos (.json)
src/tools/contratos.ts              herramientas → contratos_<export>
src/tools/agente.ts                 herramienta de confirmación → agente_pedir_confirmacion
src/tools/lib/                      extracción, validación, maestro CSV, alertas, logs
src/agent/                          ciclo del agente, registro de herramientas, sesiones, confirmación
src/llm/                            adaptador propio + Anthropic + proveedor de prueba sin IA
src/server.ts                       API HTTP (Bun.serve) y front
web/                                chat (HTML + TypeScript, sin framework)
demo.ts · modulo/ · tests/          verificación sin modelo · bonus · pruebas
fixtures/                           entregados por Periferia (no se modifican)
```

## Despliegue

Desplegado en Render (plan gratis) con el Blueprint [`render.yaml`](../render.yaml) de la raíz del repositorio. Es un servicio web Docker con raíz `reto-02/`, en la región Virginia, con health check en `/api/health`. Cada push a `main` que toque esta carpeta lo redespliega.

- `ANTHROPIC_API_KEY` es una variable secreta del servicio en el panel de Render. Nunca va en el repositorio.
- El link es público, sin clave de acceso. El gasto lo limitan `MAX_ITERACIONES`, `MAX_TOKENS_SESION` y `MAX_TOKENS_DIA` (2.000.000 en el despliegue). El tope diario vive en memoria y se reinicia cuando el servicio se duerme, así que conviene fijar además un límite de gasto en la consola de Anthropic.
- En el plan gratis el servicio se duerme tras 15 minutos sin tráfico y tarda alrededor de un minuto en despertar. Al dormirse se borran `out/` (incluida la copia del maestro y su historial) y las sesiones, y el chat abre una sesión nueva solo.

El mismo `Dockerfile` sirve en Railway, Fly.io o Azure: basta definir `ANTHROPIC_API_KEY` como variable secreta.

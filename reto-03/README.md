# Reto 03 · Agente "Órdenes de Compra SAP"

Agente conversacional que lee el paquete de cada solicitud de compra (solicitud, cotización, aprobación y, si llegó, factura), aplica los controles RC1–RC10 contra los maestros, muestra la orden de compra exactamente como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un SAP simulado. Las excepciones no se resuelven a la fuerza: se bloquean o se le preguntan a la analista. Además mide las OC retroactivas.

- Enunciado: [`PRD.md`](PRD.md)
- Planteamiento de la solución, diseño del adaptador SAP real y lectura del proceso: [`SOLUCION.md`](SOLUCION.md)
- **Link de prueba:** <https://periferia-reto-03-ordenes-compra-hkje.onrender.com> (público, sin clave de acceso; si lleva 15 minutos sin uso tarda alrededor de un minuto en despertar)

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

Procesa los 6 casos llamando directamente a las herramientas, con fecha fija `2026-09-03`. Limpia `out/` al empezar. Luego crea `sol-001` por segunda vez para mostrar la idempotencia y confirma explícitamente `sol-004` y `sol-005`.

| Caso | Qué prueba | Resultado |
|---|---|---|
| `sol-001` | Flujo normal | Apta, sin excepciones → **OC 4500000001**; al repetirla devuelve el mismo número (`idempotente: true`) |
| `sol-002` | Proveedor inexistente | **Bloqueo RC1** con acción sugerida; no crea OC |
| `sol-003` | Aprobador sin autoridad | **Bloqueo RC2**: aprobó Comercial (CC-3030) para Administración (CC-2020), y ningún aprobador de CC-2020 tiene tope para COP 74 M |
| `sol-004` | Cotización ≠ solicitud | **Confirmación RC5**: COP 25.000.000 vs COP 26.500.000 (6 %) → tras confirmar, **OC 4500000002** |
| `sol-005` | Factura anterior a la solicitud | **Confirmación RC8**, `retroactiva = true` → tras confirmar, **OC 4500000003**, marcada en `control.csv` |
| `sol-006` | IVA y condiciones no informados | **RC6** derivado C1 + confirmación; **RC7** derivado Z030 (informativo) |

Otros comandos:

```bash
bun test            # 32 pruebas: paquete, RC1–RC10, payload, trazabilidad, evidencia, SAP, idempotencia, errores, ciclo, módulo
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
| `FECHA_REFERENCIA` | — | Fecha fija (YYYY-MM-DD) para la fecha de las OC creadas. |
| `ZONA_HORARIA` | `America/Bogota` | Zona horaria para la fecha de ejecución. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error, iteraciones, tokens, tokensSesion }`. Sin `sessionId` crea una sesión. |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión. |
| `GET` | `/api/health` | `{ ok: true, provider, model, requiereClave, maxIteraciones }`, sin claves. |
| `GET` | `/api/solicitudes` | Solicitudes disponibles (atajo del chat). |
| `GET` | `/api/archivos/<ruta en out/>` | Descarga de archivos generados (confinada a `out/`). |

Cada elemento de `toolCalls` es `{ id, nombre, argumentos, ok, resumen, duracionMs, archivos[] }`. Errores: `{ ok: false, error }` con estado 400, 401, 404 o 409.

## Herramientas

| Herramienta | Entrada | Salida (`data`) |
|---|---|---|
| `oc_leer_paquete` | `{ caso }` | Paquete normalizado (PRD 7.2) + `faltantes` |
| `oc_validar` | `{ caso, paquete }` | `{ apta, bloqueos[], confirmaciones[], derivados, retroactiva, advertencias }` |
| `oc_construir_payload` | `{ caso, paquete, derivados }` | `{ orden (OrdenCompra), ruta_trazabilidad }` |
| `oc_generar_evidencia` | `{ caso }` | `{ ruta, ruta_pdf, sha256 }` |
| `oc_crear` | `{ caso, payload, confirmado? }` | `{ numero_oc, fecha, idempotente, excepciones }` (con `confirmado_por` completado) o `{ ok: false, error }` |
| `oc_leer_excel` (P1) | `{ ruta, hoja? }` | `{ filas[] }` |
| `oc_listar_solicitudes` | `{}` | Solicitudes disponibles |

El adaptador SAP vive en `src/sap/adapter.ts` (interfaz `SapAdapter`) y `src/sap/mock.ts` (implementación sobre `out/sap/`).

## Prompt de ejemplo

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Luego responde `confirmo` (o usa el botón "Sí, confirmo"): se crea la OC y se muestra su número y la ruta de la evidencia.

## Salidas

```
out/<caso>/payload.json          OC como quedaría en SAP
out/<caso>/trazabilidad.json     fuente de cada valor del payload
out/<caso>/aprobacion.txt|.pdf   evidencia del correo de aprobación con sha256
out/sap/ordenes.jsonl            SAP simulado (OC desde 4500000001)
out/control.csv                  solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts
out/log.jsonl                    cada llamada a herramienta
```

## Estructura

```
agent/prompt.md                comportamiento (system prompt)
src/knowledge/                 conocimiento: proceso (.md) y reglas como datos (.json)
src/tools/oc.ts                herramientas → oc_<export>
src/tools/agente.ts            herramienta de confirmación → agente_pedir_confirmacion
src/tools/lib/                 paquete, maestros, controles, payload, evidencia, control.csv, logs
src/sap/adapter.ts · mock.ts   interfaz SapAdapter y SAP simulado
src/agent/                     ciclo del agente, registro de herramientas, sesiones, confirmación
src/llm/                       adaptador propio + Anthropic + proveedor de prueba sin IA
src/server.ts · web/           API HTTP (Bun.serve) y chat
demo.ts · modulo/ · tests/     verificación sin modelo · bonus · pruebas
fixtures/                      entregados por Periferia (no se modifican)
```

## Despliegue

Desplegado en Render (plan gratis) con el Blueprint [`render.yaml`](../render.yaml) de la raíz del repositorio. Es un servicio web Docker con raíz `reto-03/`, en la región Virginia, con health check en `/api/health`. Cada push a `main` que toque esta carpeta lo redespliega.

- `ANTHROPIC_API_KEY` es una variable secreta del servicio en el panel de Render. Nunca va en el repositorio.
- El link es público, sin clave de acceso. El gasto lo limitan `MAX_ITERACIONES`, `MAX_TOKENS_SESION` y `MAX_TOKENS_DIA` (2.000.000 en el despliegue). El tope diario vive en memoria y se reinicia cuando el servicio se duerme, así que conviene fijar además un límite de gasto en la consola de Anthropic.
- En el plan gratis el servicio se duerme tras 15 minutos sin tráfico y tarda alrededor de un minuto en despertar. Al dormirse se borran `out/` (incluidos el SAP simulado y `control.csv`, así que la numeración vuelve a 4500000001) y las sesiones, y el chat abre una sesión nueva solo.

El mismo `Dockerfile` sirve en Railway, Fly.io o Azure: basta definir `ANTHROPIC_API_KEY` como variable secreta.

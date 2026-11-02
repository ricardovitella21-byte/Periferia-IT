# SOLUCIÓN · Reto 02 · Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase

El maestro de contratos está congelado desde el 30 de mayo de 2026 porque dependía de una persona y solo recibía los contratos con póliza. A **gerencia** le impide saber qué contratos están vigentes o por vencer; a la **analista administrativa** la deja sin control de pólizas; y a la **compañía** la expone a garantías vencidas o nunca constituidas.

## 2. Arquitectura

```
┌────────────────────────┐   POST /api/chat      ┌──────────────────────────────────────────────┐
│ web/ (chat)            │ ───────────────────▶  │ src/server.ts (Bun.serve)                    │
│ · historial            │                       │  · valida entrada (zod), clave de acceso     │
│ · tarjeta por llamada  │ ◀───────────────────  │  · sesiones: memoria + out/sesiones/*.json   │
│ · aviso de confirmación│  { reply, toolCalls,  │ src/agent/ciclo.ts  ← ciclo del agente       │
│ · atajos del buzón     │    needsConfirmation }│  · tope de iteraciones y de tokens           │
└────────────────────────┘                       │  · verificación de la confirmación humana    │
                                                 │ src/llm/adapter.ts → anthropic.ts | guion.ts │
                                                 │ src/agent/registro.ts (zod, <archivo>_<exp>) │
                                                 │ src/tools/contratos.ts · src/tools/agente.ts │
                                                 │ src/tools/lib: buzon, extraccion, validacion,│
                                                 │   maestro (CSV), alertas, ejecucion (logs)   │
                                                 └───────────────┬─────────────────┬────────────┘
                                                                 │                 │
                                    fixtures/reto-02 (solo lectura)       out/ (escritura)
                                    buzon/, maestro-contratos.csv,        sharepoint/ (maestro, Contratos/,
                                    comerciales.json                      historial.jsonl), procesados.json,
                                                                          alertas.md, log.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, regla de "valores solo de herramientas", flujo por mensaje, confirmación, formato de respuesta. |
| **Conocimiento** | `src/knowledge/registro-contratos.md` y `src/knowledge/reglas.json` | El proceso en prosa (RN1–RN7, esquema del maestro, casos típicos) y las reglas como datos: umbral de confianza (0,8), similitud de objeto (0,9), fecha de corte, días de alerta, monedas, países por lugar o identificador, tipos de póliza, sufijos societarios, palabras de confirmación. |
| **Ejecución** | `src/tools/` | Herramientas tipadas con zod. Cambiar un umbral o agregar una moneda no toca el servidor ni el código. |

## 3. Ciclo del agente

Es el mismo diseño del reto 01, implementado a mano en `src/agent/ciclo.ts`:

1. **Entrada y topes**: se verifican el tope de tokens de la sesión y el diario. Se agrega el mensaje.
2. **Bucle**: `llm.enviar(mensajes, herramientas)`. Cada `tool_use` se valida con zod en el registro (un error vuelve al modelo como `tool_result` con `is_error`), se ejecuta **en orden** (el maestro es un archivo: dos registros en paralelo podrían pisarse) y su `{ ok, data } | { ok: false, error }` vuelve al modelo. Cada llamada queda en `toolCalls` (visible en el chat) y en `out/log.jsonl`.
3. **Tope (CA1)**: al llegar a `MAX_ITERACIONES` (25 llamadas al modelo por turno), la última respuesta se pide con `tool_choice: none` y una nota del sistema. Un lote de 6 mensajes cabe de sobra porque el modelo puede pedir varias herramientas en una sola respuesta.
4. **Confirmación humana (CA3, RN5)**, en dos capas:
   - **Herramienta**: `contratos_registrar` rechaza con `requiere revisión: …` si hay campos dudosos y no viene `confirmado: true`.
   - **Servidor**: el servidor solo deja pasar `confirmado: true` si el turno anterior terminó pidiendo confirmación (`agente_pedir_confirmacion` o una pregunta final) **y** el mensaje actual de la analista es afirmativo. Si no, reescribe `confirmado: false`. El modelo no puede autoconfirmarse.
5. **Errores (CA5)**: los errores del modelo (timeout, clave, límite de uso) se muestran claros y la sesión sigue. Un mensaje malo devuelve `{ ok: false }` y el agente sigue con el siguiente.

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5`, esfuerzo `medium` (configurable).
- **Por qué:** el modelo orquesta unas 20 llamadas a herramientas por lote, respeta reglas de no registrar lo dudoso y redacta un resumen claro en español. La extracción y la clasificación son deterministas, así que el modelo no necesita razonamiento profundo. Sonnet 5.5 es fuerte en uso de herramientas en varios pasos y cuesta la mitad que Opus 5.5 ($2 / $10 por millón de tokens de entrada / salida). La integración incluye razonamiento adaptativo con los bloques devueltos intactos, caché del prompt (`cache_control`), fallback del servidor (`fallbacks: "default"`), timeout de 90 s y reintentos.
- **Costo** (medido el 2026-11-02 en el link desplegado, con el prompt de la sección 11 del PRD):
  - El lote de 6 mensajes hizo 6 llamadas al modelo, que pidió las 20 herramientas en paralelo por grupos, con 81.419 tokens de entrada y 5.239 de salida. La confirmación de msg-006 sumó 43.892 y 1.479.
  - Total: 125.311 tokens de entrada y 6.718 de salida. A precio completo son 125k × $2/M + 6,7k × $10/M ≈ **US$0,32 como máximo**, unos US$0,05 por mensaje. La parte de la entrada que se lee de la caché de prefijo cuesta menos, así que el costo real es menor.
  - Quedó por debajo de la estimación previa (unos 200.000 tokens de entrada, hasta US$0,48 por lote) gracias a las llamadas en paralelo.
  - Con un volumen típico de decenas de contratos al mes, el costo mensual es de pocos dólares. El chat muestra los tokens de la sesión para medirlo.

## 5. Estrategia de extracción

La extracción es **determinista** (`src/tools/lib/extraccion.ts`): expresiones regulares y heurísticas sobre el texto del adjunto. El modelo no extrae valores. Cada campo sale con `{ valor, confianza, nota }`.

| Campo | Cómo se encuentra | Confianza |
|---|---|---|
| Tipo de documento | Título (primera línea): contrato, contrato marco, otrosí, o no contractual (cotización, propuesta, factura…). | — |
| `id_contrato` | `No. XX-AAAA-NNN` en el título (0,98) o en el texto (0,85). Sin número → `AUTO-<año>-<secuencia>`. | 0,98 / 0,85 |
| `cliente`, `nit_cliente` | Párrafo "Entre…": primera parte con `NIT/RUC/RTN` que no sea Periferia. El nombre se toma del bloque de firmas (mayúsculas y minúsculas correctas); si no aparece, se convierte desde mayúsculas. NIT sin puntos ni dígito de verificación. | 0,95 (0,85 si se convirtió) |
| `pais` | Domicilio de la contraparte (Bogotá, Quito, Lima…) y tipo y longitud del identificador (NIT → CO, RUC de 13 dígitos → EC, de 11 → PE, RTN → HN). Si coinciden, 0,95; una sola fuente, 0,85; si se contradicen, 0,6. | 0,6–0,95 |
| `objeto` | Cláusula OBJETO, sin la fórmula "EL CONTRATISTA se obliga a…". Recortado a 200 caracteres en una palabra completa. | 0,9 (0,85 si se recortó) |
| `valor`, `moneda` | Cláusula VALOR: código ISO junto al monto (`COP $265.000.000`, `USD 120,000.00`). Se distingue el separador decimal del de miles. Una moneda desconocida devuelve error. "No tiene un valor determinado" o "por demanda" → `0` con `valor_indeterminado` (0,7: la analista lo confirma). | 0,95 / 0,7 |
| `fecha_inicio`, `fecha_fin` | Cláusula PLAZO: fechas en español ("primero (1) de agosto de 2026") con "desde… hasta…" (0,95). "Hasta" sola (otrosí) → fin (0,9). Plazo en meses "a partir de la firma" → inicio = fecha de firma; fin = inicio + N meses − 1 día (0,7 o menos). Si la firma no trae día ("en el mes de agosto de 2026"), se propone la fecha del correo (0,5). Se valida la coherencia entre plazo y fechas. | 0,5–0,95 |
| `requiere_poliza`, `tipo_poliza` | Párrafos con "póliza" o "garantía". Los tipos se normalizan (cumplimiento, calidad, responsabilidad_civil…). Una póliza condicionada ("para cada orden de servicio que supere…") baja a 0,85. Se contrasta con el correo ("no pide póliza" o "requiere póliza"): si se contradicen, 0,6. | 0,6–0,95 |
| `estado_poliza` | Nuevo con póliza → `pendiente`; sin póliza → `no_aplica`. Un otrosí que exige "ampliar" las garantías → `pendiente` (0,85). | — |
| `comercial` | Remitente contra `comerciales.json`. Desconocido → se reporta en `advertencias`, no bloquea. | 1 |

**Dónde entra el modelo y dónde no:**
- **El modelo sí:** decide el orden de las herramientas, explica los resultados, pregunta lo dudoso y traslada las correcciones de la analista.
- **El modelo no:** no lee el contrato para sacar valores, no clasifica y no decide qué se escribe.
- **Validación con el documento:** `contratos_validar` y `contratos_registrar` **vuelven a extraer del documento**. Si un valor enviado contradice el documento con confianza alta, se vuelve un conflicto en `requiere_revision`, y solo la confirmación explícita de la analista lo acepta. Así se cumple "el valor final que se registra debe pasar por `contratos_validar`" sin depender de que el modelo lo llame.

## 6. Regla de gobierno: "Todo contrato pasa por el buzón"

**Propósito.** Que el maestro de contratos sea completo y sobreviva a la rotación de personas. Aplica a todos los contratos, órdenes de servicio, otrosíes y actas, con o sin póliza.

1. **Canal único.**
   - Buzón compartido `contratos@periferia-ficticia.com` (Exchange). Ningún contrato se envía a personas.
   - Lo administra el **área administrativa**: la analista administrativa es la responsable y su jefe directo el suplente.
   - El **dueño del maestro** es la Dirección Administrativa y Financiera. Esto resuelve la pregunta abierta: no hay área legal, así que el dueño es quien responde por la facturación y las pólizas.
2. **Obligación del comercial.** En máximo **3 días hábiles desde la firma**, enviar al buzón:
   - el **PDF firmado por ambas partes**;
   - todo **otrosí, adición, prórroga, suspensión o acta de terminación o liquidación**;
   - el asunto con el formato `[CONTRATO|OTROSI|ACTA] <Cliente> - <No. contrato> - <objeto corto>`;
   - en el cuerpo, si requiere póliza y quién es el contacto del cliente.
3. **Acuse automático.**
   - En menos de **1 hora hábil**, el agente responde al comercial con el número asignado y la clasificación (nuevo, actualización, duplicado), o con lo que falta.
   - Si hay campos en revisión, el acuse dice cuáles, y la analista los resuelve en máximo **2 días hábiles**.
4. **Excepciones y escalamiento.**
   - **Contrato sin firma** → se rechaza con motivo y se pide la versión firmada. Si a los 5 días hábiles no llega, se escala al gerente comercial.
   - **Contrato sin valor** (marco o por demanda) → se registra con valor 0 y `valor_indeterminado` tras la confirmación de la analista. Cada orden de servicio que lo concrete se envía también al buzón.
   - **Póliza exigida** → queda `pendiente` y entra a las alertas. Si a los 10 días hábiles no está constituida, se escala a la Dirección Administrativa y al gerente comercial.
   - **Remitente que no es comercial registrado** → se procesa, pero se pide al gerente comercial que confirme quién es el responsable.
5. **Cierre del gap (junio a agosto de 2026), en una sola campaña.**
   - **Semana 1:** finanzas extrae la facturación de junio a agosto por cliente. Cada contrato facturado que no esté en el maestro queda en una lista.
   - **Semana 2:** cada comercial recibe su lista y reenvía al buzón los contratos y otrosíes que faltan, con el asunto `[MIGRACION]`. El agente los registra con `fuente = migracion`.
   - **Semana 3:** conciliación. Lo que siga faltando se escala a gerencia comercial. Se cierra con un acta firmada por la Dirección Administrativa.
6. **Indicador mensual.**
   - **Cobertura del maestro** = contratos con facturación del mes que existen en el maestro ÷ contratos con facturación del mes. Meta ≥ 98 %.
   - Indicadores de apoyo: % de contratos registrados dentro de los 3 días de la firma, y pólizas exigidas sin constituir a más de 10 días (meta 0).
   - Gerencia los revisa en el comité mensual.

**Qué pasa si no se cumple:** sin contrato en el maestro no se habilita la primera factura del proyecto (control en facturación), y el incumplimiento entra al indicador del comercial.

## 7. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Extracción determinista** con confianza por campo calculada por reglas. | Que el modelo extraiga los campos (o un modelo de extracción estructurada). | El PRD pide extracción determinista como P0 y que nada se invente. Las reglas son reproducibles (la demo da siempre lo mismo), explican su confianza en una nota y no cuestan tokens. Trade-off: menos tolerancia a redacciones muy distintas; las cubre la revisión humana (confianza baja → revisión). |
| 2 | **`registrar` vuelve a extraer y validar** en vez de confiar en el `contrato` que trae el modelo. | Registrar lo que llega del modelo si pasó por `validar` antes. | El modelo podría alterar un valor entre una llamada y otra. Re-extraer garantiza que lo registrado sale del documento o de una corrección confirmada por la analista. Trade-off: unos milisegundos de más por registro. |
| 3 | **Duplicado por número, valor y fechas (RN1)** aunque el objeto esté redactado distinto. | Exigir igualdad de todos los campos. | msg-004 reenvía un contrato cuyo objeto en el maestro está abreviado ("Mesa de servicio TI nivel 1 y 2"). Comparar todo lo habría tomado como actualización y ensuciado el maestro. Se reporta como advertencia. |
| 4 | **Un otrosí que exige ampliar garantías deja la póliza en `pendiente`**. | Mantener `vigente` hasta que alguien la cambie. | El objetivo O4 es anticipar riesgos: si el plazo se extiende, la póliza vigente ya no cubre el nuevo plazo. Queda en historial y en alertas. |
| 5 | **Maestro como CSV y herramientas ejecutadas en serie**. | Base de datos. | El PRD descarta la base de datos. Ejecutar en serie evita condiciones de carrera. En producción se reemplaza por la lista de SharePoint (sección 11). |
| 6 | **Proveedor sin IA (`guion`)** y ciclo propio. | Solo `demo.ts`; tool runner del SDK. | Permite probar el chat y la confirmación sin clave, y demuestra que el ciclo no depende del proveedor. |

**Dependencias:**

| Paquete | Para qué |
|---|---|
| `zod` | Argumentos de herramientas (obligatorio), fixtures, reglas, entorno y API. |
| `@anthropic-ai/sdk` | Cliente oficial de Claude. |
| `unpdf` | P1: texto de PDF nativos (`contratos_leer_pdf` y adjuntos `.pdf`). |
| `marked` + `dompurify` | Mostrar en el chat el Markdown del modelo, sanitizado. |
| `pdf-lib` (solo desarrollo) | Generar un PDF de prueba para verificar `contratos_leer_pdf`. |

## 8. Supuestos

1. **Fecha de firma sin día** (msg-006, "en el mes de agosto de 2026"): se propone la fecha del correo (2026-08-31) como inicio, con confianza 0,5. Por eso `fecha_inicio` también queda en revisión, además de `valor` y `fecha_fin` que pide el PRD. Es más estricto, no menos. Al confirmar "valor 0 y fecha fin 2027-08-31", la analista acepta el inicio propuesto.
2. **Fecha fin derivada** = inicio + N meses − 1 día, la misma convención de los contratos con fechas explícitas (15-ago-2026 + 12 meses → 14-ago-2027).
3. **Rechazados y duplicados también pasan por `contratos_registrar`**, que no escribe en el maestro pero los marca en `procesados.json` y en el historial. Así los 6 mensajes quedan clasificados y no reaparecen en el buzón.
4. **Otrosí:** solo cambian los campos que el otrosí menciona (valor, fecha fin y estado de póliza). La fila conserva la ruta del contrato original. El otrosí se archiva como `<id>-otrosi-<n>.<ext>` y su ruta va en el historial. Un otrosí de un contrato que no existe en el maestro se rechaza con la indicación de registrar primero el original.
5. **`fecha_registro`** = fecha de ejecución en Colombia (o `FECHA_REFERENCIA`). "Registrados desde el corte" = `fecha_registro` ≥ 2026-05-30. Las actualizaciones se listan aparte, desde el historial.
6. **Comercial no registrado:** se guarda `"<correo> (no registrado)"` en la columna `comercial` para que sea trazable, y se reporta.
7. **Alertas:** "vencen en ≤ 60 días" incluye desde hoy hasta hoy + 60 (inclusive). Los ya vencidos van en una sección informativa aparte, porque requieren otra acción (liquidar o prorrogar).
8. **Archivos:** los adjuntos de los fixtures son `.txt`, así que se archivan con su extensión real. Un `.pdf` se archivaría como `.pdf`.

## 9. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el buzón | Hecho | `contratos_leer_buzon`: excluye procesados y marca `tiene_contrato: false` y `rechazado` con motivo. | Conexión a Exchange (Graph API) con lectura de adjuntos reales. |
| HU-2 Extraer | Hecho | Extracción determinista con confianza por campo; ausentes en `null` con confianza 0; pruebas por mensaje. | Más patrones de redacción a medida que lleguen contratos reales; OCR para escaneados. |
| HU-3 Validar y clasificar | Hecho | RN1–RN4, `requiere_revision` con motivo por campo, conflictos con el documento y el maestro, comercial desconocido reportado. | Desempatar por similitud del nombre del cliente cuando cambie el NIT. |
| HU-4 Registrar y archivar | Hecho | Copia del maestro en `out/sharepoint`, inserción o actualización sin duplicados, historial con antes y después, archivo por año y cliente, `procesados.json`, exige `confirmado` con revisión. | Lista de SharePoint y biblioteca de documentos reales; bloqueo por concurrencia. |
| HU-5 Alertas | Hecho | `out/alertas.md` con las tres secciones; `hoy` como argumento. | Envío programado semanal a gerencia y a los comerciales. |
| HU-6 Errores | Hecho | Texto vacío, fecha inválida, moneda desconocida, mensaje inexistente, adjunto ilegible; el lote no se aborta. | Monitoreo y cola de reintentos. |
| P1 leer PDF | Hecho | `contratos_leer_pdf` y adjuntos `.pdf` con texto nativo (prueba con un PDF generado). | OCR para escaneados. |
| Regla de gobierno | Hecho | Sección 6. | Aprobación por la dirección. |
| Bonus `modulo/` | Hecho | Generado desde las mismas fuentes; una prueba verifica que no diverja. | — |
| Link público | Hecho | <https://periferia-reto-02-contratos-kn54.onrender.com> en Render, probado con Claude Sonnet 5.5 y el prompt de la sección 11. | Servicio siempre encendido y autenticación corporativa. |

Verificación: `bun run demo.ts` (sin clave), `bun test` (28 pruebas), `bun run typecheck` (sin `any`) y el flujo de la sección 11 con el modelo real en el link (sección 4).

## 10. Uso de IA

- **Asistente usado:** Claude Code (modelo Claude Opus 5.5), como par de programación.
- **Para qué:**
  - Leer el PRD y los fixtures, y fijar el resultado esperado de cada mensaje antes de programar.
  - Diseñar la extracción y escribir el código y las pruebas.
  - Probar el chat en un navegador y redactar esta documentación y la regla de gobierno.
- **Decisiones humanas:** el candidato eligió el modelo, el runtime, la independencia de cada reto y la forma de trabajo con Git. Todo se verificó con la demo, las pruebas y el chat antes de cada commit.
- **Qué se descartó y por qué:**
  - **Que el modelo extrajera los campos del contrato:** el PRD pide extracción determinista y el riesgo de "redondear" valores es justo lo que se quiere evitar.
  - **Comparar todos los campos para detectar duplicados:** habría convertido el reenvío de msg-004 en una actualización falsa.
  - **Registrar el `contrato` tal como lo manda el modelo:** se cambió por re-extraer y validar dentro de `registrar`.
  - **Resolver la fecha de firma sin día con el primer día del mes:** se prefirió la fecha del correo con confianza baja y revisión humana.
- **Prueba con el modelo real:** el flujo de la sección 11 (lote completo y "confirmo el valor 0 y la fecha fin 2027-08-31") dio el resultado esperado sin ajustes.

## 11. Riesgos de llevar esto a producción y mitigación

| Riesgo | Mitigación |
|---|---|
| Contratos escaneados o con redacción muy distinta. | OCR (Azure Document Intelligence) antes de la extracción; los campos dudosos caen en revisión en vez de registrarse mal; se amplían los patrones con casos reales. |
| El modelo "redondea" un valor o infiere una fecha. | El valor registrado sale de la herramienta (re-extracción); un cambio del modelo se vuelve conflicto en revisión; la confirmación la verifica el servidor. |
| Falsos duplicados o falsas actualizaciones por variaciones de nombre. | Duplicado por número, valor y fechas; actualización por número o por NIT + objeto con similitud ≥ 0,9; las diferencias quedan en el historial con antes y después. |
| Comerciales que no envían los contratos (el problema de fondo). | Regla de gobierno con control en facturación e indicador de cobertura mensual. |
| Concurrencia sobre el maestro (dos lotes a la vez). | Ejecución en serie por turno; en producción, lista de SharePoint con control de versiones y bloqueo optimista. |
| Datos confidenciales de contratos en el modelo. | En el flujo normal solo se envían al modelo los datos extraídos, no el texto del contrato (solo `contratos_leer_pdf` devuelve texto completo, y se usa a pedido); proveedor con retención limitada; acceso a la app con autenticación corporativa (Entra ID). La API admite `ACCESS_KEY`; en esta entrega el link es abierto, como permite el PRD, porque los datos son ficticios. |
| Costo o abuso del link público. | Topes de iteraciones y de tokens por sesión y por día (2.000.000 en el despliegue), límite de gasto configurable en la consola de Anthropic, `ACCESS_KEY` disponible y mensajes de hasta 4.000 caracteres. |
| Dependencia de una persona otra vez. | Proceso documentado (regla de gobierno y conocimiento en `src/knowledge`), agente reutilizable (`modulo/`), alertas automáticas y dueño del maestro definido. |

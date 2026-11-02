# SOLUCIÓN · Reto 01 · Agente "Registro como Proveedor"

## 1. Problema en una frase

El área administrativa transcribe a mano, en cada solicitud de un cliente, los mismos datos de Periferia y busca los mismos soportes para registrarse como proveedor. A la **analista administrativa** le cuesta horas y errores en datos sensibles (NIT, cuenta bancaria), y a la **compañía** le retrasa la facturación y la deja dependiendo de una sola persona.

## 2. Arquitectura

```
┌────────────────────────┐   POST /api/chat      ┌──────────────────────────────────────────────┐
│ web/ (chat)            │ ───────────────────▶  │ src/server.ts (Bun.serve)                    │
│ · historial            │                       │  · valida entrada (zod), clave de acceso     │
│ · tarjeta por llamada  │ ◀───────────────────  │  · sesiones: memoria + out/sesiones/*.json   │
│   a herramienta        │  { reply, toolCalls,  │                                              │
│ · aviso de confirmación│    needsConfirmation }│ src/agent/ciclo.ts  ← ciclo del agente       │
└────────────────────────┘                       │  prompt → modelo → herramientas → respuesta  │
                                                 │  · tope de iteraciones y de tokens           │
                                                 │  · verificación de la confirmación humana    │
                                                 │        │                       │             │
                                                 │ src/llm/adapter.ts      src/agent/registro.ts│
                                                 │  enviar(mensajes,        valida args con zod │
                                                 │   herramientas)          <archivo>_<export>  │
                                                 │  ├ anthropic.ts (Claude) │                   │
                                                 │  └ guion.ts (sin IA)     ▼                   │
                                                 │                 src/tools/proveedor.ts       │
                                                 │                 src/tools/agente.ts          │
                                                 │                 src/tools/lib/*              │
                                                 └───────────────┬─────────────────┬────────────┘
                                                                 │                 │
                                                  fixtures/reto-01 (solo lectura)  out/ (escritura)
                                                  maestro, glosario, casos,        formulario, paquete/,
                                                  soportes                         log.jsonl, ENVIO-SIMULADO.md
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, regla de "valores solo de herramientas", flujo, confirmación, formato de respuesta. |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` y `src/knowledge/reglas.json` | El proceso en prosa (para el modelo) y las reglas como datos: identificador por país, umbrales de confianza, claves bancarias, nombres de soportes, palabras de confirmación. |
| **Ejecución** | `src/tools/` | Herramientas tipadas con zod. Leen las reglas de `reglas.json`; cambiar un país o un umbral no toca el servidor ni el código. |

El prompt de sistema que recibe el modelo es `prompt.md` + `registro-proveedor.md`, concatenados al arrancar (`src/agent/prompt.ts`).

## 3. Ciclo del agente

Implementado a mano en `src/agent/ciclo.ts` (sin el tool runner del SDK), porque el PRD pide un adaptador propio y que cambiar de proveedor no toque el ciclo.

1. **Entrada**: se agrega el mensaje de la analista a la sesión. Antes se verifican el tope de tokens de la sesión y el tope diario del servidor.
2. **Bucle**: `llm.enviar(mensajes, herramientas, { sistema })`. Si la respuesta trae llamadas a herramientas, cada una pasa por el registro, que valida los argumentos con zod (un error vuelve al modelo como `tool_result` con `is_error`, no se lanza), se ejecuta y su resultado `{ ok, data } | { ok: false, error }` vuelve al modelo. Cada llamada queda en el historial visible (`toolCalls`) y en `out/log.jsonl`. Las de negocio quedan además en `out/<caso>/log.jsonl`.
3. **Tope de iteraciones (CA1)**: cuando se llega a `MAX_ITERACIONES` (25), el último bloque de resultados lleva una nota del sistema y se hace una llamada final con `tool_choice: none`. El modelo responde con lo que tiene y lo que faltó. Nunca queda un `tool_use` sin resultado.
4. **Confirmación humana (CA3, RN4)**, en dos capas:
   - **Modelo**: el prompt le pide llamar `agente_pedir_confirmacion` y cerrar el turno con una pregunta. El turno queda con `needsConfirmation: true` (también si el texto termina en "?") y el chat lo resalta con botones "Sí, confirmo" y "No, todavía no".
   - **Servidor**: `proveedor_simular_envio` con `confirmado: true` solo se respeta si el turno anterior terminó pidiendo confirmación **y** el mensaje actual es afirmativo (`src/agent/confirmacion.ts`; cualquier negación gana). Si no, el servidor reescribe `confirmado: false` y la herramienta responde `requiere confirmación explícita`. El modelo no puede saltarse la confirmación aunque lo intente.
5. **Errores (CA5)**: los errores del SDK se traducen a mensajes claros (timeout, clave inválida, límite de uso, proveedor saturado). La sesión no muere: el siguiente mensaje continúa la conversación.

**CA2: el modelo no puede afirmar valores que no salieron de una herramienta.** Además de la regla del prompt, el diseño lo hace innecesario. `generar_formulario` recibe el mapeo, pero **relee cada valor del maestro**. Si el modelo envía un mapeo alterado (por ejemplo, una ruta distinta para un campo faltante), la herramienta lo ignora, usa su mapeo determinista y lo reporta en `advertencias`. Hay una prueba para este caso.

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5`, con esfuerzo `medium` (configurable con `LLM_MODEL` y `LLM_EFFORT`).
- **Por qué:** el trabajo del modelo aquí es orquestar 5–6 herramientas en orden, respetar reglas (no inventar, pedir confirmación) y redactar un resumen en español. No hay razonamiento profundo: los valores y las reglas los calculan las herramientas. Sonnet 5.5 es fuerte en uso de herramientas en varios pasos, cuesta la mitad que Opus 5.5 ($2 / $10 por millón de tokens de entrada / salida, frente a $4 / $20) y responde más rápido. `medium` es el punto de partida recomendado para tareas de varias herramientas.
- **Detalles de integración:** razonamiento adaptativo por defecto; los bloques de razonamiento se devuelven intactos en cada turno (el adaptador guarda el contenido nativo). Caché de prompt automática (`cache_control`) porque el prompt de sistema y las herramientas no cambian. Fallback del servidor (`fallbacks: "default"`) para que un rechazo por política se reintente en otro modelo. Timeout de 90 s y 2 reintentos del SDK.
- **Costo por caso procesado** (medido el 2026-11-02 en el link desplegado, con el prompt de la sección 11 del PRD):
  - `ec-corp-andina`: el turno de procesamiento hizo 5 llamadas al modelo (leer, mapear, generar, armar y pedir confirmación), con 40.721 tokens de entrada y 1.731 de salida. El "envía" que confirma sumó 21.869 y 325.
  - Total del caso: 62.590 tokens de entrada y 2.056 de salida. A precio completo son 62,6k × $2/M + 2,1k × $10/M ≈ **US$0,15 como máximo**. La parte de la entrada que se lee de la caché de prefijo cuesta menos, así que el costo real es menor.
  - La estimación previa (unos 50.000 tokens de entrada, US$0,05–0,15 por caso) quedó confirmada.
  - El chat muestra los tokens acumulados de la sesión para seguir midiéndolo.
  - Con 8–12 solicitudes al mes, el costo mensual es de centavos a un par de dólares.

## 5. Diseño del formato "portal web con usuario y contraseña"

**Qué hace hoy el agente:** responde "formato no soportado" y genera `out/<caso>/valores-portal.md`. Ese archivo trae la tabla de valores para copiar (con su estado lleno / por confirmar / faltante), la URL del portal mencionada en el correo, los soportes que hay que cargar y los pasos humanos.

**Cómo lo automatizaría en una fase siguiente:**

| Opción | Ventaja | Límite | Decisión |
|---|---|---|---|
| Navegador controlado por el agente (Playwright o "computer use" con sesión supervisada) | Funciona con cualquier portal sin integración. | Frágil ante cambios de layout; CAPTCHA y MFA lo detienen; requiere supervisión. | **Elegida como fase 2**, en modo asistido. |
| RPA tradicional (UiPath, Power Automate) | Robusto para un portal fijo y repetitivo. | Un script por portal; mantenimiento alto con 8–12 clientes distintos al mes. | Solo para un portal de altísimo volumen. |
| Extensión de navegador que rellena el formulario con los valores del agente | El humano ya está autenticado; no se manejan credenciales. | Mapear los campos del DOM por portal; instalar la extensión. | **Alternativa recomendada si hay MFA**: el más seguro. |

**Diseño propuesto (fase 2, modo asistido):**
1. La analista abre el portal e **ingresa ella misma** usuario, contraseña y MFA. El agente nunca ve credenciales.
2. Con la sesión ya abierta, el agente (extensión o navegador supervisado) lee los campos del formulario y los empareja con `valores-portal.md` usando el mismo mapeo y glosario. Lo que no empareje queda resaltado para la analista.
3. El agente rellena los campos y adjunta los soportes del `paquete/`.
4. **El clic en "Enviar" siempre es humano.** El agente se detiene antes y muestra un resumen de lo que llenó.
5. Si aparece un CAPTCHA, un MFA o un cambio de pantalla inesperado, el agente se detiene y devuelve el control.

**Credenciales:** nunca en el repositorio, en el prompt, en los logs ni en el chat. Si alguna vez se automatiza el ingreso, deben vivir en un gestor de secretos (Azure Key Vault o el gestor corporativo de contraseñas), referenciadas por un identificador. Las rota y administra el dueño de la cuenta (hoy llegan al correo del representante legal). Solo las recupera, en el momento del uso, el componente que opera el navegador, nunca el modelo. El agente actual ya está instruido para no pedir ni aceptar contraseñas en el chat.

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Mapeo determinista** (glosario → clave del maestro → similitud por tokens) dentro de la herramienta, con umbrales en `reglas.json`. | Pedirle al modelo que empareje campos y valores. | El PRD exige trazabilidad y "nunca inventar". Un mapeo determinista es reproducible (la demo da siempre lo mismo), explica su confianza y su ruta, y no cuesta tokens. El modelo orquesta, no decide valores. |
| 2 | **`generar_formulario` relee los valores del maestro** e ignora los que mande el modelo. | Escribir el `mapeo` tal como llega del modelo. | El contrato pasa el mapeo por el modelo, y el modelo podría "redondear" o alterar un valor. Releer del maestro cierra ese riesgo (CA2) sin romper el contrato. |
| 3 | **Confirmación verificada por el servidor**, no solo por el prompt. | Confiar en que el modelo pase `confirmado: true` solo cuando corresponde. | Un prompt se puede ignorar o manipular. El servidor sabe si el turno anterior pidió confirmación y si la respuesta fue afirmativa; es la única forma de garantizar RN4. Trade-off: la detección de "sí" es por palabras clave; ante una negación se asume que no. |
| 4 | **PDF generado con pdf-lib** (tabla etiqueta / valor en orden, marcas de "por confirmar" y "faltante", línea de firma). | Rellenar un AcroForm. | El PRD lo acepta y no tenemos el PDF original del cliente, solo la lista de campos. |
| 5 | **Ciclo propio y adaptador propio** sobre el SDK de Anthropic (`messages.create`). | Tool runner del SDK. | El PRD pide la interfaz `enviar(mensajes, herramientas)` y que el ciclo no dependa del proveedor. Prueba de ello: existe un segundo proveedor (`guion`, sin IA) que el ciclo usa sin cambios. |
| 6 | **Front sin framework** (HTML + TypeScript, empaquetado por Bun). | React o Vue. | Un solo comando y un solo proceso; arranque en segundos; menos dependencias. El chat es simple. |
| 7 | **Proveedor de prueba sin IA (`LLM_PROVIDER=guion`)**. | Solo `demo.ts`. | Permite probar el chat completo (llamadas visibles, confirmación, descargas) sin clave ni costo, y en pruebas automáticas. |

**Dependencias** (todas justificadas):

| Paquete | Para qué |
|---|---|
| `zod` | Argumentos de herramientas (obligatorio), validación de fixtures, variables de entorno y cuerpo de la API. JSON Schema para el modelo con `z.toJSONSchema`. |
| `@anthropic-ai/sdk` | Cliente oficial de Claude: tipos, reintentos, timeouts, errores tipados. |
| `exceljs` | Escribir el `.xlsx` en las celdas exactas, con colores y notas para campos por confirmar o faltantes. |
| `pdf-lib` | Generar el PDF sin binarios externos. |
| `marked` + `dompurify` | Mostrar en el chat el Markdown del modelo de forma segura (sanitizado). |

## 7. Supuestos

1. **Fecha de ejecución** = fecha del día en Colombia (`America/Bogota`). Se puede fijar con `FECHA_REFERENCIA` o con `fecha_referencia` en la herramienta. La demo usa `2026-09-03` (fecha del PRD) para ser determinista. Con la fecha real (noviembre de 2026), la Cámara de Comercio (vigente hasta 2026-09-30) aparece vencida en todos los casos. Es el comportamiento correcto: hay que renovarla.
2. **Vencido** = `vigencia_hasta` estrictamente anterior a la fecha de referencia; el mismo día sigue vigente. `vigencia_hasta: null` = no vence (RUT).
3. **`soportes-exigidos.json` es la fuente de verdad** de los soportes pedidos, aunque el correo los nombre de otra forma ("constancia de existencia", "registro tributario de su país").
4. **Campos por confirmar se escriben en el formulario** con el valor propuesto, resaltados (Excel: color y nota; PDF: marca "POR CONFIRMAR"). Así lo pide RN1 para el identificador extranjero; la analista los revisa antes de firmar.
5. **Portal web:** `listo_para_firma` se calcula solo con los soportes, porque no hay formulario que firmar; el paquete incluye `valores-portal.md` en lugar del formulario.
6. **Enviar con bloqueos:** si la analista confirma el envío de un paquete no listo para firma, se permite (la decisión es humana), pero `ENVIO-SIMULADO.md` y el borrador dejan constancia de los bloqueos.
7. **Copias de soportes:** se copian a `paquete/soportes/` todos los exigidos que existen, incluso los vencidos (marcados en el checklist), para que la analista vea qué hay que reemplazar.
8. Los valores del maestro se escriben tal cual (por ejemplo, País = `CO`, ingresos anuales en COP sin formato). Traducirlos sería transformar el dato sin fuente.
9. **Datos bancarios:** se llenan solo si la etiqueta coincide exactamente en el glosario o en el maestro. Un parecido por similitud a una clave bancaria se deja faltante (RN2: "explícitamente").

## 8. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer la solicitud | Hecho | `proveedor_leer_solicitud`; pruebas de país, formato, campos y soportes, y de identificador ambiguo o extranjero. | Leer el correo real (Exchange/Graph) y los adjuntos `.xlsx`/`.pdf` del cliente en lugar de los JSON normalizados. |
| HU-2 Mapear campos | Hecho | `proveedor_mapear_campos`: tres estados con ruta y confianza, glosario, RN1, RN2. | Un dueño del glosario y del maestro; aprender sinónimos nuevos con aprobación humana. |
| HU-3 Formulario xlsx (P0) | Hecho | Prueba que lee las celdas exactas del `.xlsx` generado. | Escribir sobre la plantilla original del cliente (conservar su formato) cuando llegue el archivo real. |
| HU-3 Formulario pdf (P1) | Hecho | PDF generado con todos los campos en orden. | Rellenar AcroForms cuando el cliente envíe un PDF con campos. |
| HU-3 Portal (P2) | Hecho (según el PRD) | "Formato no soportado" + `valores-portal.md`; diseño en la sección 5. | Fase 2 asistida (extensión o navegador supervisado). |
| HU-4 Paquete para firma | Hecho | `paquete/` con formulario, soportes, `checklist.md` y `borrador-correo.md`; vencido y ausente bloquean; faltante no; prueba de que el borrador no lleva datos bancarios. | Integración con firma electrónica y con SharePoint. |
| HU-4 Envío simulado con confirmación | Hecho | `ENVIO-SIMULADO.md` solo tras confirmación verificada por el servidor (pruebas). | Envío real desde el buzón corporativo, con un humano que aprueba. |
| HU-5 Manejo de errores | Hecho | Caso inexistente (lista los disponibles), plantilla dañada (continúa con soportes), formato desconocido, argumentos inválidos, errores del modelo; ninguna herramienta lanza. | Alertas operativas (monitoreo) y reintentos con cola. |
| Bonus `modulo/` | Hecho | `agent.md`, `skill/registro-proveedor/SKILL.md` y `tools/proveedor.ts` se generan desde las mismas fuentes; una prueba falla si divergen. | Publicarlo en el registro de agentes interno. |
| Link público | Hecho | <https://periferia-reto-01-proveedor-zsrc.onrender.com> en Render, probado con Claude Sonnet 5.5 y el prompt de la sección 11. | Servicio siempre encendido y autenticación corporativa. |

Verificación: `bun run demo.ts` (sin clave), `bun test` (31 pruebas), `bun run typecheck` (sin `any`) y el flujo de la sección 11 con el modelo real en el link (sección 4).

## 9. Uso de IA

- **Asistente usado:** Claude Code (modelo Claude Opus 5.5), como par de programación durante toda la construcción.
- **Para qué:**
  - Leer y desglosar el PRD en requisitos verificables.
  - Proponer la arquitectura y escribir el código y las pruebas.
  - Revisar el uso correcto del SDK de Anthropic (modelo, razonamiento adaptativo, fallback, errores tipados).
  - Probar el chat en un navegador y redactar esta documentación.
- **Decisiones humanas:** el candidato eligió el proveedor y modelo (Claude Sonnet 5.5), el runtime (Bun), la separación de cada reto como proyecto independiente y la forma de trabajo con Git. El código propuesto se ejecutó y verificó con la demo, las pruebas y el chat antes de cada commit.
- **Qué se descartó de lo propuesto y por qué:**
  - **Tool runner del SDK** (`toolRunner`) para el ciclo: el PRD exige un ciclo y un adaptador propios.
  - **Que el modelo decidiera el mapeo de campos:** se perdía determinismo y trazabilidad, y aumentaba el riesgo de inventar valores.
  - **Confiar en el prompt para la confirmación:** se agregó la verificación en el servidor.
  - **Similitud con umbral 0,5 para proponer campos:** "Referencias comerciales" acababa propuesto como "Contacto comercial". Se subió a 0,6 y se bloqueó la similitud hacia datos bancarios.
  - **Un framework de front (React):** innecesario para este chat.
- **Ajuste tras probar con el modelo real:** con el prompt de la sección 11, el primer turno cerraba sin pregunta y el envío necesitaba tres mensajes. Se ajustó el prompt para cerrar siempre con la pregunta de confirmación del envío (preguntar no es enviar). Ahora "envía" produce `ENVIO-SIMULADO.md` en el segundo mensaje, como describe el PRD.

## 10. Riesgos de llevar esto a producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo completa un campo faltante con un valor plausible. | Los valores salen solo de herramientas; `generar_formulario` relee el maestro; el prompt lo prohíbe; el checklist lista los faltantes. |
| Envío sin autorización. | Confirmación verificada por el servidor; el envío real seguirá siendo un paso humano. |
| Maestro o soportes desactualizados (un dato correcto en el maestro pero viejo en la realidad). | Dueño del dato con revisión periódica; alertas de vigencia (por ejemplo, Cámara de Comercio a 30 días). |
| Plantillas reales peores que los fixtures (celdas combinadas, PDFs escaneados, etiquetas nuevas). | Estados "por confirmar" y "faltante" en vez de adivinar; ampliar el glosario con aprobación; leer el adjunto original. |
| Exposición de datos sensibles (cuenta bancaria, identificación del representante). | Nunca en el borrador de correo; la API admite `ACCESS_KEY` (en esta entrega el link es abierto, como permite el PRD, y los datos son ficticios); descargas confinadas a `out/`; en producción, autenticación corporativa (Entra ID) y cifrado en reposo. |
| Costo descontrolado si el link es público. | Topes de iteraciones, de tokens por sesión y de tokens diarios (2.000.000 en el despliegue); límite de gasto configurable en la consola de Anthropic; `ACCESS_KEY` disponible; mensajes de hasta 4.000 caracteres. |
| Caída o lentitud del proveedor del modelo. | Timeout y reintentos; mensaje claro y sesión viva; el modo sin modelo y `demo.ts` siguen funcionando; el adaptador permite cambiar de proveedor. |
| Sesiones en archivos locales y un solo proceso. | Para varias instancias, mover sesiones y `out/` a almacenamiento compartido (Blob, SharePoint) y agregar un candado distribuido por sesión. |

# SOLUCIÓN · Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

Cada compra obliga a la **analista administrativa** a digitar a mano en SAP datos que ya vienen en el correo y a verificar de memoria quién puede aprobar cuánto en qué centro de costo. A **contabilidad y auditoría** les cuesta correcciones en el cierre y no saben cuántas OC se crean después de la factura.

## 2. Arquitectura

```
┌────────────────────────┐   POST /api/chat      ┌──────────────────────────────────────────────┐
│ web/ (chat)            │ ───────────────────▶  │ src/server.ts (Bun.serve)                    │
│ · historial            │                       │ src/agent/ciclo.ts  ← ciclo del agente       │
│ · tarjeta por llamada  │ ◀───────────────────  │  · tope de iteraciones y de tokens           │
│ · aviso de confirmación│  { reply, toolCalls,  │  · verificación de la confirmación humana    │
│ · atajos por solicitud │    needsConfirmation }│ src/llm/adapter.ts → anthropic.ts | guion.ts │
└────────────────────────┘                       │ src/agent/registro.ts (zod, <archivo>_<exp>) │
                                                 │ src/tools/oc.ts · src/tools/agente.ts        │
                                                 │ src/tools/lib: paquete, maestros, controles, │
                                                 │   payload, evidencia, control, ejecucion     │
                                                 │ src/sap/adapter.ts (SapAdapter) → mock.ts    │
                                                 └───────────────┬─────────────────┬────────────┘
                                                                 │                 │
                                   fixtures/reto-03 (solo lectura)        out/ (escritura)
                                   solicitudes/<caso>/, maestros/         <caso>/{payload,trazabilidad,aprobacion.*},
                                                                          sap/ordenes.jsonl, control.csv, log.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, regla de "valores solo de herramientas", flujo, confirmación, formato de respuesta. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` y `src/knowledge/reglas.json` | La matriz RC1–RC10 y el proceso en prosa; como datos: tolerancia de cotización (2 %), tolerancia aritmética (± 1), sociedad y organización de compras (1000), número inicial de OC, longitud del texto breve (40), unidades, monedas, acciones sugeridas por control y palabras de aprobación y confirmación. |
| **Ejecución** | `src/tools/` y `src/sap/` | Herramientas tipadas con zod y adaptador SAP. Cambiar la tolerancia o el texto de una acción sugerida no toca el servidor ni el código. |

## 3. Ciclo del agente

Es el mismo diseño de los retos 01 y 02 (`src/agent/ciclo.ts`):

1. **Entrada y topes**: tope de tokens por sesión y diario.
2. **Bucle**: `llm.enviar(mensajes, herramientas)`. Cada `tool_use` se valida con zod en el registro (un error vuelve al modelo con `is_error`, no se lanza), se ejecuta en orden y su `{ ok, data } | { ok: false, error }` vuelve al modelo. Todo queda en `toolCalls` (visible en el chat) y en `out/log.jsonl`.
3. **Tope (CA1)**: al llegar a `MAX_ITERACIONES` (25), la última respuesta se pide con `tool_choice: none` y una nota del sistema.
4. **Confirmación humana (CA3)**, en dos capas:
   - **Herramienta**: `oc_crear` no crea una OC con confirmaciones pendientes sin `confirmado: true`.
   - **Servidor**: solo deja pasar `confirmado: true` si el turno anterior terminó pidiendo confirmación y el mensaje actual de la analista es afirmativo. Si no, lo reescribe a `false`.
5. **Errores (CA5)**: los errores del modelo se muestran claros y la sesión sigue. Los errores de datos (paquete incompleto, JSON malformado, monto no numérico) se devuelven con la sugerencia de qué pedirle al solicitante.

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5`, esfuerzo `medium` (configurable).
- **Por qué:** el modelo orquesta unas 6 herramientas en orden, respeta "no la crees hasta que confirme" y presenta la OC en una tabla clara. Los controles, el payload y la evidencia son deterministas, así que no se necesita razonamiento profundo. Sonnet 5.5 es fuerte en uso de herramientas en varios pasos y cuesta la mitad que Opus 5.5 ($2 / $10 por millón de tokens). La integración incluye razonamiento adaptativo con bloques devueltos intactos, caché del prompt, fallback del servidor (`fallbacks: "default"`), timeout y reintentos.
- **Costo estimado por solicitud procesada** (estimación, aún no medida con tráfico real):
  - Una solicitud son unas 6 llamadas al modelo.
  - Cada llamada lleva unos 4.500 tokens fijos (prompt de sistema y herramientas) más el historial: el paquete pesa unos 1.500 tokens y el payload unos 800.
  - Total: unos 45.000 tokens de entrada y 4.000 de salida. Sin caché: 45k × $2/M + 4k × $10/M ≈ **US$0,13 por OC**. Con la caché de prefijo, **US$0,05–0,08**.
  - Frente al tiempo de digitación y de corrección en el cierre, el costo es marginal.

## 5. Matriz de controles

Implementación: `src/tools/lib/controles.ts`, una función pura `validarControles(paquete, maestros)`. Con la misma entrada da el mismo resultado: no depende del modelo ni de la fecha.

| # | Implementación | Tipo |
|---|---|---|
| RC1 | Proveedor por `proveedor_nit` exacto; sin NIT, por nombre normalizado (sin tildes, mayúsculas ni signos). Inexistente o `activo: false` → bloqueo con acción sugerida distinta para cada caso. Si el NIT de la cotización no coincide con el del proveedor, queda una advertencia. | Bloqueo |
| RC2 | Aprobación presente; el cuerpo contiene "Aprobado" (y ninguna negación como "no aprobado" o "rechazado"); el remitente está en `aprobadores` del centro de costo. Si no lo está, el detalle lista a los aprobadores habilitados con su tope, y la acción dice quién puede aprobar o que hay que escalar. | Bloqueo |
| RC3 | Si el aprobador es del centro: `valor_total ≤ tope`. | Bloqueo |
| RC4 | El centro existe y la subárea está en sus `subareas`. | Bloqueo |
| RC5 | Total de la cotización contra `valor_total`, ambos IVA incluido. Diferencia relativa > 2 %, monedas distintas, sin cotización o total ilegible → confirmación con ambos valores. Si el correo dice el monto aprobado ("Aprobado por 25 millones"), se agrega al detalle. | Confirmación |
| RC6 | Sin `indicador_iva` → derivado de `indicador_iva_default` del proveedor + confirmación. Un código que no existe en el maestro bloquea. | Confirmación + derivado |
| RC7 | Sin `condiciones_pago` → derivado de `condiciones_pago_default`. Se informa y queda como excepción "informativo" en el payload. | Derivado |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva = true` + confirmación. La marca va a `control.csv` en cada intento. | Confirmación |
| RC9 | Fecha local de la aprobación < `fecha_solicitud` → confirmación. | Confirmación |
| RC10 | `|cantidad × valor_unitario − valor_total| > 1` → bloqueo. | Bloqueo |

**La más difícil: RC2 junto con RC3.** El PRD las separa, pero en los datos reales se cruzan:
- En sol-003 aprueba alguien que **sí es aprobador**, pero de otro centro (CC-3030 para una compra de CC-2020).
- Evaluar RC3 con su tope (80 M) daría un "pasa" engañoso. La regla correcta es que el tope solo vale **dentro del centro**: por eso RC3 se evalúa solo cuando RC2 pasa.
- Un bloqueo que solo diga "aprobador no autorizado" no resuelve nada. La acción sugerida calcula si algún aprobador del centro tiene tope suficiente. En sol-003 ninguno lo tiene (Rocío Torres, 30 M, frente a 74 M), y el agente dice que hay que escalar en lugar de devolver el caso a un aprobador que tampoco podría aprobarlo.
- **Segunda dificultad, RC5:** cotización y solicitud tienen que compararse sobre la misma base. Las cotizaciones expresan precios "IVA incl."; se compara total contra total, ambos con IVA.

## 6. Diseño del adaptador SAP real

**Opción elegida, dada una viabilidad no confirmada:**
1. **S/4HANA (cloud o on-premise 2020+):** OData `API_PURCHASEORDER_PROCESS_SRV`, la API liberada de órdenes de compra. Es REST/JSON, admite *deep insert* (cabecera, posiciones e imputación en una sola llamada y transacción) y se publica con un *Communication Arrangement* del escenario de integración de órdenes de compra (SAP_COM_0053 en S/4HANA Cloud; el escenario exacto se confirma con el equipo SAP de Periferia). En on-premise se expone con SAP Cloud Connector o API Management. Es la más estable ante actualizaciones.
2. **ECC:** RFC/BAPI `BAPI_PO_CREATE1` + `BAPI_TRANSACTION_COMMIT`, llamado desde SAP Integration Suite (o un middleware con JCo o NCo) a través del Cloud Connector.
3. **SAP Integration Suite** como capa intermedia en ambos casos, si Periferia ya la tiene: centraliza credenciales, reintentos y monitoreo.
4. **Carga por archivo** solo como plan B (ver abajo).

El agente no cambia: `SapAdapter` tiene tres métodos. La implementación real (`src/sap/odata.ts` o `src/sap/rfc.ts`) reemplaza a `mock.ts` por configuración.

**Mapeo del payload (sección 7.4) a la estructura real:**

| Payload | OData `A_PurchaseOrder` | `BAPI_PO_CREATE1` |
|---|---|---|
| `sociedad` | `CompanyCode` | `POHEADER-COMP_CODE` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) | `POHEADER-PURCH_ORG` / `PUR_GROUP` |
| `proveedor.codigo_sap` | `Supplier` | `POHEADER-VENDOR` |
| `moneda` | `DocumentCurrency` | `POHEADER-CURRENCY` |
| `condiciones_pago` | `PaymentTerms` | `POHEADER-PMNTTRMS` |
| `referencia.solicitud_id` | Campo de extensión de cabecera `YY1_SolicitudID` (clave de idempotencia) | `EXTENSIONIN` (campo Z de EKKO) |
| `posiciones[].numero` | `to_PurchaseOrderItem.PurchaseOrderItem` (10, 20…) | `POITEM-PO_ITEM` |
| `descripcion` (40) | `PurchaseOrderItemText` | `POITEM-SHORT_TEXT` |
| `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` (tabla UN→EA, H→H, MES→MON) | `POITEM-QUANTITY` / `PO_UNIT` |
| `precio_unitario` | `NetPriceAmount` (neto: se descuenta el IVA según `TaxCode`) | `POITEM-NET_PRICE` |
| `indicador_iva` | `TaxCode` | `POITEM-TAX_CODE` |
| `centro_costo` | `AccountAssignmentCategory = K` + `to_AccountAssignment.CostCenter` (+ `GLAccount` por grupo de artículos) | `POITEM-ACCTASSCAT = K`, `POACCOUNT-COSTCENTER` / `GL_ACCOUNT` |
| `subarea` | Campo de extensión de posición `YY1_Subarea` (o elemento PEP o centro de beneficio, según la contabilidad) | `EXTENSIONIN` (campo Z de EKPO) |
| `aprobador` + evidencia | Texto de cabecera y adjunto `aprobacion.pdf` con `API_CV_ATTACHMENT_SRV` | Texto de cabecera; adjunto con GOS (`BDS` o `SO_OBJECT_INSERT`) |
| `excepciones` | Texto de cabecera "Excepciones de control" | `POTEXTHEADER` |

**Autenticación y credenciales:**
- Usuario técnico de comunicación con el rol mínimo: crear OC solo en la sociedad 1000 y la organización 1000, sin aprobar ni liberar.
- Autenticación con OAuth 2.0 *client credentials* (BTP) o certificado X.509. No hay usuario personal.
- Las credenciales viven en **Azure Key Vault** o en el *Destination Service* de BTP. Solo las lee el adaptador, del lado del servidor, en el momento de la llamada.
- **Nunca** están en el agente, el prompt, el chat, el repositorio ni los logs. Se rotan cada 90 días.

**Idempotencia y errores parciales:**
- Antes de crear, `buscarOrdenPorReferencia(solicitud_id)` consulta SAP por `YY1_SolicitudID`. Si existe, devuelve ese número; es lo que ya hace el mock.
- **Timeout:** no se reintenta a ciegas. Primero se consulta por la referencia; solo si no existe, se reintenta con la misma clave.
- **OData:** el *deep insert* es atómico (todo o nada). Un 4xx devuelve los mensajes de SAP y se registra como intento fallido en `control.csv`.
- **BAPI:** si la tabla `RETURN` trae `E` o `A`, se hace `BAPI_TRANSACTION_ROLLBACK` y se registra el intento fallido. Las advertencias (`W`) se aceptan y se registran.
- **Error parcial real:** la OC se creó pero falló el adjunto de evidencia. La OC no se reintenta (ya existe). El adjunto se reintenta aparte y la fila de control queda "evidencia pendiente" hasta que se suba.

**Plan B si la conexión no es viable** (el agente igual ahorra la mayor parte del tiempo, que es reunir, validar y transcribir):
1. **"OC lista para pegar":** una vista campo a campo en el orden de la transacción ME21N (cabecera, posición, imputación), con los valores ya validados y la evidencia PDF lista para adjuntar.
2. **Archivo de carga masiva** al final del día: CSV con la plantilla del *Migration Cockpit* (objeto "Purchase order") o LSMW en ECC, con las OC aptas y confirmadas. Una persona lo sube en un solo paso.
3. `control.csv` sigue midiendo los resultados y las retroactivas igual.

## 7. Lectura del proceso: OC retroactivas

**Lo que le diría a la dirección:** una OC creada después de la factura no es una orden de compra. Es un registro contable de una compra que ya ocurrió sin control previo:
- nadie comparó precios antes del compromiso;
- nadie verificó que el aprobador tuviera atribución por ese monto;
- el presupuesto del centro se entera después.

En el caso de prueba (sol-005), la factura es del 10 de agosto, la solicitud del 27 y la aprobación del 28: el gasto ya estaba hecho cuando se pidió permiso. Desde hoy el agente **lo mide**: `out/control.csv` marca `retroactiva = true` en cada intento, y la proporción mensual de OC retroactivas se vuelve un indicador.

**Cambio de proceso propuesto:**
1. **"Sin OC no hay pago"**, con un catálogo corto de excepciones (servicios públicos, impuestos, urgencias justificadas). Toda factura que llegue sin número de OC se devuelve al proveedor o se escala al aprobador del centro.
2. **A los proveedores habituales:** exigir el número de OC en la factura (cláusula en la orden y en el portal de proveedores).
3. **Compras recurrentes** (papelería, tóner, licencias): contratos marco u **órdenes abiertas** con vigencia trimestral o anual, para que la compra rutinaria tenga OC antes de facturarse. sol-005 es exactamente ese caso.
4. **Política:** la decisión sobre tolerar retroactivas con marca o rechazarlas es de la dirección. La recomendación es tolerarlas con marca durante un trimestre para medir la línea base, y luego exigir aprobación de un nivel superior para cada retroactiva.

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Controles deterministas en código**, con reglas en `reglas.json`. | Que el modelo evalúe los controles leyendo los documentos. | Un control de auditoría debe dar siempre el mismo resultado y ser explicable. El modelo explica y pregunta; no decide si una OC pasa. |
| 2 | **Las herramientas releen los documentos**, y `oc_crear` compara el payload recibido con el que construye de nuevo. | Confiar en el `paquete` y el `payload` que pasa el modelo. | Cierra el riesgo del PRD de que el modelo "arregle" un monto (CA2). Un payload alterado se rechaza con la lista de campos distintos. Hay una prueba para este caso. |
| 3 | **La OC usa los valores de la solicitud** (lo aprobado), no los de la cotización. Una diferencia > 2 % se vuelve confirmación. | Tomar el total de la cotización. | La aprobación respalda la solicitud; en sol-004 el aprobador escribió "por 25 millones". Crear por 26,5 M excedería lo aprobado. |
| 4 | **Los intentos bloqueados también pasan por `oc_crear`** (sin payload) para quedar en `control.csv`. | Registrar solo los intentos que llegan a crear. | El PRD pide una fila por intento "exitoso, bloqueado o pendiente". Auditoría necesita ver los bloqueos para medir el proceso. |
| 5 | **Evidencia con sha256 del contenido canónico** (encabezados + cuerpo). El mismo contenido va en el `.txt` y el `.pdf`, y el payload lleva el mismo hash. | Hash del archivo PDF. | Los bytes del PDF cambian con la fecha de generación; el contenido canónico es reproducible y verificable por cualquiera. |
| 6 | **Idempotencia en el adaptador** (`buscarOrdenPorReferencia` antes de `crearOrden`). | Que el agente recuerde qué creó. | La memoria del agente no sobrevive a reintentos ni a otras sesiones; SAP es la fuente de verdad. Es el mismo diseño del adaptador real. |

**Dependencias:**

| Paquete | Para qué |
|---|---|
| `zod` | Argumentos de herramientas (obligatorio), esquema `OrdenCompra`, paquete, maestros, reglas, entorno y API. |
| `@anthropic-ai/sdk` | Cliente oficial de Claude. |
| `pdf-lib` | Evidencia `aprobacion.pdf` (P1) sin binarios externos. |
| `exceljs` | P1: `oc_leer_excel` para solicitudes `.xlsx` reales. |
| `marked` + `dompurify` | Mostrar en el chat el Markdown del modelo, sanitizado. |

## 9. Supuestos

1. **Precios con IVA:** las cotizaciones expresan "Precio unitario (IVA incl.)" y la solicitud usa los mismos valores, así que `precio_unitario` del payload es el de la solicitud tal cual. En la implementación real se envía el precio neto a SAP, descontando la tasa del `TaxCode` (tabla 6).
2. **RC2 frente a RC3:** si quien aprueba no es aprobador del centro, se reporta RC2 (no RC3). La acción sugerida dice si hace falta escalar porque ningún aprobador del centro tiene tope suficiente.
3. **RC9** compara la fecha local de la aprobación (día, no hora). Aprobar el mismo día de la solicitud es válido (sol-004).
4. **"Aprobado"** se reconoce como palabra (aprobado, aprobada, apruebo, autorizado), salvo que aparezca una negación ("no aprobado", "rechazado").
5. **Códigos inexistentes:** un `indicador_iva` o una `condiciones_pago` informados pero que no existen en el maestro bloquean, porque SAP rechazaría la OC. El PRD no lo dice explícitamente. Una moneda distinta de COP o USD también bloquea (código `MONEDA`).
6. **Unidad:** `H` si la solicitud o el ítem de la cotización mencionan horas, `MES` si mencionan mensualidades, `UN` en otro caso.
7. **Texto breve:** se recorta a 40 caracteres en una palabra completa y sin terminar en conector; el texto completo queda en la trazabilidad.
8. **Fuentes de trazabilidad:** además de `solicitud`, `cotizacion`, `maestro.<nombre>` y `derivado`, se usan `correo` (id del correo) y `aprobacion` (aprobador y fecha), porque esos valores salen de ahí. Las constantes de sociedad y organización se rotulan `maestro.reglas`.
9. **Fecha de la OC** = fecha de ejecución en Colombia (o `FECHA_REFERENCIA`). La numeración del mock es secuencial por orden de creación.
10. **Validez de la cotización:** si venció antes de la solicitud, es una advertencia, no un control (no está en RC1–RC10).

## 10. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el paquete | Hecho | `oc_leer_paquete`: paquete normalizado (sección 7.2), adjuntos ausentes en `null` y en `faltantes`. | Leer los adjuntos reales del correo (Graph API): `.xlsx` (ya existe `oc_leer_excel`), `.pdf` y `.eml`. |
| HU-2 Validar | Hecho | RC1–RC10 con bloqueos, confirmaciones, derivados y retroactiva; pruebas por caso y por control. | Maestros consultados en SAP en tiempo real (proveedores, centros, topes). |
| HU-3 Payload | Hecho | `OrdenCompra` validado con zod; `trazabilidad.json` con la fuente de cada valor. | Precio neto e imputación contable (cuenta de mayor) según configuración real. |
| HU-4 Evidencia | Hecho (P0 y P1) | `aprobacion.txt` y `aprobacion.pdf` con sha256 verificable. | Adjuntarla en SAP (GOS o API de adjuntos). |
| HU-5 Crear en SAP simulado | Hecho | Números desde 4500000001, idempotencia, `control.csv` con todos los intentos, confirmación verificada por el servidor, payload alterado rechazado. | Adaptador real (sección 6). |
| HU-6 Errores | Hecho | Paquete incompleto, JSON malformado, monto no numérico, caso inexistente: mensaje legible con qué pedir al solicitante. | Respuesta automática al solicitante con lo que falta. |
| P1 leer Excel | Hecho | `oc_leer_excel` (prueba con un `.xlsx` generado). | — |
| Bonus `modulo/` | Hecho | Generado desde las mismas fuentes; una prueba verifica que no diverja. | — |
| Link público | Pendiente | `Dockerfile` listo. | Desplegar. |

Verificación: `bun run demo.ts` (sin clave), `bun test` (32 pruebas), `bun run typecheck` (sin `any`).

## 11. Uso de IA

- **Asistente usado:** Claude Code (modelo Claude Opus 5.5), como par de programación.
- **Para qué:**
  - Desglosar el PRD y fijar el resultado esperado de cada solicitud antes de programar.
  - Diseñar la matriz de controles y escribir el código y las pruebas.
  - Investigar el mapeo hacia las APIs de SAP para la sección 6.
  - Probar el chat en un navegador y redactar esta documentación.
- **Decisiones humanas:** el candidato eligió el modelo, el runtime, la independencia de cada reto y la forma de trabajo con Git. Todo se verificó con la demo, las pruebas y el chat antes de cada commit.
- **Qué se descartó y por qué:**
  - **Evaluar RC3 con el tope del aprobador aunque fuera de otro centro:** daba un "pasa" engañoso en sol-003.
  - **Construir la OC con el total de la cotización:** excedía lo aprobado en sol-004.
  - **Exigir el payload en `oc_crear` siempre:** impedía registrar los intentos bloqueados en el control.
  - **Hash del archivo PDF como evidencia:** no es reproducible.

## 12. Riesgos de llevar esto a producción y mitigación

| Riesgo | Mitigación |
|---|---|
| La conexión con SAP no es viable a corto plazo. | Plan B (sección 6): OC lista para pegar y archivo de carga masiva; el agente sigue validando y midiendo. |
| El modelo ajusta un monto para que cuadre con la cotización. | Los montos salen de las herramientas; `oc_crear` rechaza cualquier payload distinto al construido; la confirmación la verifica el servidor. |
| Maestros desactualizados (topes, aprobadores, proveedores inactivos). | En producción se consultan en SAP o en el directorio en tiempo real; dueño del dato por maestro; alertas cuando un aprobador cambia de cargo. |
| Correos de aprobación falsificados o reenviados. | Verificar el remitente con los encabezados del correo (DKIM/SPF) y que la aprobación responda al hilo de la solicitud; a mediano plazo, aprobación en un flujo con firma (Power Automate o SAP Flexible Workflow). |
| OC duplicadas por reintentos. | Idempotencia por `solicitud_id` consultando SAP antes de crear; nunca reintentar sin consultar. |
| Credenciales de SAP expuestas. | Usuario técnico con rol mínimo, OAuth o certificado, Key Vault, rotación, y nunca en el prompt ni en los logs. |
| Costo o abuso del link público. | Topes de iteraciones y de tokens por sesión y diarios, clave de acceso, mensajes acotados. |
| La retroactividad se normaliza en vez de corregirse. | Indicador mensual a la dirección y la política "sin OC no hay pago" (sección 7). |

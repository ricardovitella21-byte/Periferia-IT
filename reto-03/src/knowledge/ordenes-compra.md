# Proceso: órdenes de compra en SAP

## Qué es

Cada compra llega a administración por correo con tres piezas: la **solicitud** (Excel, normalizado como `solicitud.json`), la **cotización** del proveedor y el **correo de aprobación** del líder. A veces también llega la **factura**. La analista crea la orden de compra (OC) en SAP con proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjunta el correo de aprobación como evidencia.

## Flujo estándar por solicitud

1. **Leer el paquete** (`oc_leer_paquete`): correo, solicitud, cotización, aprobación y factura normalizados. Lo que falte queda `null` y se lista en `faltantes`.
2. **Validar** (`oc_validar`): aplica los controles RC1–RC10. Resultado: `apta`, `bloqueos`, `confirmaciones`, `derivados` y `retroactiva`.
3. **Construir el payload** (`oc_construir_payload`): la OC exactamente como quedaría en SAP, con la trazabilidad de cada valor (`solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado`).
4. **Generar la evidencia** (`oc_generar_evidencia`): el correo de aprobación como `aprobacion.txt` y `aprobacion.pdf`, con su `sha256`.
5. **Crear la OC** (`oc_crear`): solo si es apta; si tiene confirmaciones, solo con `confirmado: true` dado por la analista. Crear dos veces la misma solicitud devuelve el número existente.

## Matriz de controles

| # | Regla | Tipo |
|---|---|---|
| RC1 | El proveedor existe en `proveedores.json` (por NIT; si no hay NIT, por nombre normalizado) y está activo. | **Bloqueo** |
| RC2 | La aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo. | **Bloqueo** |
| RC3 | `valor_total` ≤ tope de ese aprobador en ese centro. | **Bloqueo** |
| RC4 | La subárea pertenece al centro de costo. | **Bloqueo** |
| RC5 | Cotización y solicitud no difieren más de 2 %. Si difieren, o si no hay cotización: confirmación con ambos valores. | Confirmación |
| RC6 | Sin indicador de IVA: se deriva del proveedor y se confirma. | Confirmación + derivado |
| RC7 | Sin condiciones de pago: se derivan del proveedor. Solo se informa. | Derivado |
| RC8 | Factura con fecha anterior a la solicitud: OC **retroactiva**. Confirmación; queda en el control. | Confirmación |
| RC9 | La aprobación es anterior a la solicitud. | Confirmación |
| RC10 | `cantidad × valor_unitario` = `valor_total` (± 1). | **Bloqueo** |

Un **bloqueo** impide crear la OC: se devuelve la razón y la acción sugerida. Una **confirmación** permite crearla solo cuando la analista confirma explícitamente. Un **derivado** es un valor que se completó desde un maestro y siempre se informa.

## Payload de la OC

Sociedad y organización de compras `1000`. Proveedor desde el maestro (código SAP, NIT, nombre). Una posición por solicitud (número 10), con descripción breve de máximo 40 caracteres, cantidad, unidad (`UN`, `H` para horas, `MES` para mensualidades), precio unitario, centro de costo, subárea e indicador de IVA. Aprobador con correo, fecha y `sha256` de la evidencia. Las excepciones (confirmaciones y derivados) quedan en el payload con quién las confirmó.

## Control y auditoría

Cada intento de crear una OC (creada, existente, bloqueada o pendiente de confirmación) deja una fila en `out/control.csv`: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. La dirección usa la columna `retroactiva` para medir cuántas OC se crean después de la factura.

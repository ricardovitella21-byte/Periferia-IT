# Proceso: registro de Periferia IT Group como proveedor

## Qué es

Un cliente (en Colombia, Ecuador, Perú, Panamá u Honduras) pide por correo que Periferia se registre como proveedor. Llega una solicitud con:

- el **correo** normalizado (`solicitud.json`): remitente, asunto, país, cliente y formato de salida;
- la **plantilla** del cliente: `plantilla-celdas.json` (Excel: hoja y celda de cada campo) o `plantilla-campos.json` (PDF o portal: lista ordenada de campos con `obligatorio`);
- los **soportes exigidos** (`soportes-exigidos.json`): tipos de documento que el cliente pide adjuntar.

Los datos de Periferia viven en el **repositorio maestro** (`repositorio/maestro.json`) y los soportes en `repositorio/soportes/` con su `vigencia_hasta`. El **glosario** (`glosario-campos.json`) traduce las etiquetas que usan los clientes a claves del maestro.

## Flujo estándar

1. **Leer la solicitud** → país, cliente, formato, campos pedidos y soportes exigidos.
2. **Mapear los campos** al maestro → cada campo queda `lleno`, `faltante` o `requiere_confirmacion`.
3. **Generar el formulario** en el formato pedido (Excel o PDF). Un portal web no se llena: se entregan los valores listos para copiar.
4. **Armar el paquete para firma**: formulario, copia de los soportes, checklist y borrador de correo.
5. **Resumir y pedir confirmación**. La firma y el envío son decisiones humanas.
6. **Simular el envío** solo si la analista lo confirma explícitamente.

## Estados de un campo

| Estado | Cuándo | Qué hacer |
|---|---|---|
| `lleno` | El campo existe en el maestro con confianza ≥ 0.8. | Se escribe en el formulario. Se informa la ruta del dato. |
| `requiere_confirmacion` | Confianza entre 0.6 y 0.8, o aplica una regla de país (identificador tributario extranjero o etiqueta ambigua). | Se escribe el valor propuesto y se marca para revisión. La analista debe confirmarlo. |
| `faltante` | No hay fuente en el maestro. | Se deja vacío y se lista en el checklist. **Nunca se inventa.** |

## Reglas de negocio

- **RN1 · Identificador tributario por país**: CO → NIT, EC → RUC, PE → RUC, PA → RUC, HN → RTN. Periferia solo tiene NIT colombiano. Para otros países el campo se llena con el NIT y queda `requiere_confirmacion` con la nota "identificador extranjero". Una etiqueta genérica ("Identificación tributaria") también queda por confirmar y se propone el equivalente del país.
- **RN2 · Datos bancarios**: se llenan solo si la plantilla los pide explícitamente. **Nunca** van en el borrador de correo.
- **RN3 · Bloqueos de firma**: un soporte exigido **vencido** (`vigencia_hasta` anterior a la fecha de referencia) o **ausente** bloquea `listo_para_firma`. Un campo `faltante` no bloquea, pero aparece en el checklist.
- **RN4 · Acciones externas**: el envío, la firma o la carga a un portal solo ocurren con confirmación explícita de la analista en el turno inmediatamente anterior. En este sistema "enviar" solo escribe `ENVIO-SIMULADO.md`.
- **RN5 · Trazabilidad**: cada llamada a herramienta deja una línea en `out/<caso>/log.jsonl`.

## Soportes

| Tipo | Documento |
|---|---|
| `camara_comercio` | Certificado de existencia y representación legal. Los clientes suelen pedirlo con máximo 30 días. |
| `rut` | Registro Único Tributario. No vence. |
| `certificacion_bancaria` | Certificación de la cuenta bancaria. |
| `parafiscales` | Pago de aportes parafiscales y seguridad social. |
| `estados_financieros` | Estados financieros del último año. |
| `certificado_cumplimiento_tributario` | Certificado de cumplimiento tributario. **Periferia no lo tiene en el repositorio.** |

Un cliente extranjero puede nombrar el soporte a su manera ("constancia de existencia", "registro tributario de su país"); `soportes-exigidos.json` ya trae el tipo normalizado.

## Formatos de salida

| Formato | Resultado |
|---|---|
| `xlsx` | `out/<caso>/formulario.xlsx`: cada etiqueta y valor en la hoja y celda que indica la plantilla. |
| `pdf` | `out/<caso>/formulario.pdf`: todos los campos con etiqueta y valor, en el orden de la plantilla. |
| `portal` | No soportado. Se produce `out/<caso>/valores-portal.md` con los valores para copiar. Las credenciales y el clic en "Enviar" son del humano. |

## Fecha de referencia

La vigencia de los soportes se evalúa contra la fecha de ejecución. Si la analista menciona otra fecha ("con fecha 2026-09-03"), se pasa como `fecha_referencia` a la herramienta del paquete.

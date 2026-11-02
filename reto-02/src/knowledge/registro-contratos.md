# Proceso: registro de contratos vigentes

## Qué es

El registro maestro de contratos de Periferia (`maestro-contratos.csv`) quedó congelado el **30 de mayo de 2026**. El agente es el **punto único de recepción**: lee el buzón de contratos, extrae los datos de cada documento, detecta duplicados y actualizaciones, archiva el documento en la estructura de SharePoint y alimenta el maestro. Además genera alertas de vencimientos y de pólizas.

Un contrato se registra **con o sin póliza**. Antes solo llegaban los que requerían póliza.

## Flujo estándar por mensaje

1. **Leer el buzón** (`contratos_leer_buzon`): mensajes pendientes, sus adjuntos y si traen contrato. Un mensaje sin contrato (cotización, pregunta) se clasifica `rechazado` con motivo.
2. **Extraer** (`contratos_extraer`): datos del documento con una **confianza por campo** entre 0 y 1. Un dato ausente es `null` con confianza 0; **nunca se inventa**.
3. **Validar** (`contratos_validar`): clasifica `nuevo`, `actualizacion`, `duplicado` o `rechazado` y lista lo que `requiere_revision`.
4. **Registrar** (`contratos_registrar`): escribe en el maestro, archiva el documento y deja historial. Si hay campos en revisión, **no registra sin `confirmado: true`**, y esa confirmación la da la analista.
5. **Alertas** (`contratos_alertas`) al final del lote.

## Reglas de clasificación

- **RN1 · Duplicado**: mismo `id_contrato` y mismos `valor`, `fecha_inicio` y `fecha_fin`. No se escribe nada; se reporta.
- **RN2 · Actualización**: mismo `id_contrato` (o mismo `nit_cliente` y `objeto` con similitud ≥ 0.9) y algún campo distinto, o el documento es un **otrosí**. Se actualiza la fila y el cambio queda en `historial.jsonl` con el valor anterior y el nuevo.
- **RN3 · Nuevo**: no hay coincidencia. Se inserta.
- **RN4 · Rechazado**: sin adjunto de contrato, o texto sin partes ni objeto identificables. Se reporta con motivo.
- **RN5 · Revisión humana**: un campo con confianza < 0.8, o un valor que contradice el documento o el maestro, va a `requiere_revision`. Sin `confirmado: true` no se registra.
- **RN6**: el fixture del maestro es de solo lectura; la primera ejecución lo copia a `out/sharepoint/maestro-contratos.csv`.
- **RN7**: cada herramienta deja una línea en `out/log.jsonl`.

## Esquema del maestro

| Columna | Regla |
|---|---|
| `id_contrato` | Número tal como aparece en el documento (CT-2026-015, CM-2026-03). Si no existe: `AUTO-<año>-<secuencia>`. |
| `cliente` | Razón social de la contraparte. |
| `nit_cliente` | Identificador tributario **sin dígito de verificación ni puntos**. |
| `pais` | CO, EC, PE, PA o HN, inferido del identificador o del domicilio. |
| `objeto` | Máximo 200 caracteres. |
| `valor` | Número sin separadores. `0` si el contrato es por demanda o marco (`valor_indeterminado`). |
| `moneda` | COP, USD, PEN, PAB o HNL. |
| `fecha_inicio` / `fecha_fin` | YYYY-MM-DD. `fecha_fin` puede derivarse de un plazo en meses. |
| `requiere_poliza`, `tipo_poliza` | Tipos separados por `;` (cumplimiento, calidad, responsabilidad_civil, salarios_prestaciones…). |
| `estado_poliza` | `vigente`, `pendiente`, `vencida` o `no_aplica`. Un registro nuevo con póliza queda `pendiente`. |
| `comercial` | Nombre resuelto desde `comerciales.json`. Un remitente desconocido se reporta pero no bloquea. |
| `ruta_sharepoint` | Ruta relativa en `out/sharepoint/`: `Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`. |
| `fecha_registro`, `fuente` | Fecha del registro; `buzon`, `manual` o `migracion`. |

## Casos típicos

- **Otrosí**: modifica un contrato existente (plazo, valor). Solo cambian los campos que el otrosí modifica. Si extiende el plazo y exige ampliar las garantías, la póliza pasa a `pendiente` hasta que se amplíe.
- **Contrato marco** sin valor: `valor = 0`. Si el plazo se cuenta "desde la firma" y la firma no tiene día exacto, las fechas quedan en revisión.
- **Reenvío** de un contrato ya registrado: duplicado.
- **Cotización** o propuesta: no es un contrato, se rechaza.

## Alertas

`out/alertas.md` con tres secciones: contratos que vencen en 60 días o menos, contratos que requieren póliza y no la tienen vigente, y contratos registrados desde el corte del 2026-05-30 (el gap que se está cubriendo). La fecha de referencia (`hoy`) siempre se pasa explícitamente.

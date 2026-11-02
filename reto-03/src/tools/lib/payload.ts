import { z } from "zod"
import type { Validacion } from "./controles.ts"
import type { Paquete } from "./paquete.ts"
import { reglas } from "./reglas.ts"
import { normalizar, recortarPalabras } from "./texto.ts"
import { ErrorHerramienta } from "./tipos.ts"

/** Esquema de la OC (PRD 7.4), validado con zod antes de crearla. */
export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string().min(1), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({ email: z.string().min(3), fecha_aprobacion: z.string(), evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive().multipleOf(10),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Traza = { valor: unknown; fuente: string; detalle?: string }

/** Unidad SAP desde el texto de la solicitud y de la cotización: horas → H, mensualidad → MES, si no UN. */
function unidad(p: Paquete): { valor: "UN" | "H" | "MES"; detalle: string } {
  const texto = normalizar(`${p.solicitud.descripcion} ${p.cotizacion?.item ?? ""}`)
  for (const [codigo, palabras] of Object.entries(reglas.unidades)) {
    const palabra = palabras.find((x) => new RegExp(`(^| )${normalizar(x)}( |$)`).test(texto))
    if (palabra && (codigo === "H" || codigo === "MES")) return { valor: codigo, detalle: `el texto menciona "${palabra}"` }
  }
  return { valor: reglas.unidad_por_defecto as "UN", detalle: "sin mención de horas ni mensualidades" }
}

/**
 * HU-3: construye la OC desde el paquete, la validación y los maestros.
 * Cada valor lleva su fuente en la trazabilidad.
 */
export function construirOrden(p: Paquete, v: Validacion, sha256: string): { orden: OrdenCompra; trazabilidad: Record<string, Traza> } {
  if (!v.apta) throw new ErrorHerramienta(`La OC no se puede construir mientras haya bloqueos: ${v.bloqueos.map((b) => b.codigo).join(", ")}.`)
  if (!v.proveedor || !v.centro || !p.aprobacion) throw new ErrorHerramienta("Faltan datos de proveedor, centro o aprobación para construir la OC.")
  const s = p.solicitud
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  const condiciones = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  if (!iva || !condiciones) throw new ErrorHerramienta("No se pudo determinar el indicador de IVA o las condiciones de pago.")
  const descripcion = recortarPalabras(s.descripcion, reglas.max_descripcion)
  const u = unidad(p)

  const excepciones: OrdenCompra["excepciones"] = [
    ...v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
    ...(v.derivados.condiciones_pago ? [{ codigo: "RC7", detalle: `Condiciones de pago derivadas del proveedor: ${v.derivados.condiciones_pago.detalle}.`, confirmado_por: "informativo" }] : []),
  ]
  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: reglas.sociedad,
    organizacion_compras: reglas.organizacion_compras,
    proveedor: { codigo_sap: v.proveedor.codigo_sap, nit: v.proveedor.nit, nombre: v.proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: condiciones,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: sha256 },
    posiciones: [
      {
        numero: reglas.paso_posicion,
        descripcion,
        cantidad: s.cantidad,
        unidad: u.valor,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones,
  })

  const trazabilidad: Record<string, Traza> = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: orden.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: orden.sociedad, fuente: "maestro.reglas", detalle: "sociedad fija de Periferia (src/knowledge/reglas.json)" },
    organizacion_compras: { valor: orden.organizacion_compras, fuente: "maestro.reglas" },
    "proveedor.codigo_sap": { valor: v.proveedor.codigo_sap, fuente: "maestro.proveedores", detalle: s.proveedor_nit ? `buscado por NIT ${s.proveedor_nit}` : `buscado por nombre "${s.proveedor_nombre}"` },
    "proveedor.nit": { valor: v.proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: v.proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: s.condiciones_pago ? { valor: condiciones, fuente: "solicitud" } : { valor: condiciones, fuente: "derivado", detalle: v.derivados.condiciones_pago?.fuente },
    "aprobador.email": { valor: p.aprobacion.de, fuente: "aprobacion", detalle: v.aprobador ? `aprobador de ${v.centro.centro_costo}, tope ${v.aprobador.tope}` : undefined },
    "aprobador.fecha_aprobacion": { valor: p.aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: sha256, fuente: "derivado", detalle: "sha256 del contenido de aprobacion.txt" },
    "posiciones[0].numero": { valor: reglas.paso_posicion, fuente: "maestro.reglas" },
    "posiciones[0].descripcion": { valor: descripcion, fuente: "solicitud", detalle: descripcion === s.descripcion ? undefined : `recortada a ${reglas.max_descripcion} caracteres desde "${s.descripcion}"` },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: u.valor, fuente: "derivado", detalle: u.detalle },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud", detalle: "validado contra maestro.centros-costo" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud", detalle: "validada contra maestro.centros-costo" },
    "posiciones[0].indicador_iva": s.indicador_iva ? { valor: iva, fuente: "solicitud" } : { valor: iva, fuente: "derivado", detalle: v.derivados.indicador_iva?.fuente },
  }
  return { orden, trazabilidad }
}

/** Campos en que difieren dos órdenes, ignorando quién confirmó las excepciones. */
export function diferenciasOrden(a: OrdenCompra, b: OrdenCompra): string[] {
  const sinConfirmacion = (o: OrdenCompra) => ({ ...o, excepciones: o.excepciones.map(({ codigo, detalle }) => ({ codigo, detalle })) })
  const x = sinConfirmacion(a) as Record<string, unknown>
  const y = sinConfirmacion(b) as Record<string, unknown>
  return Object.keys({ ...x, ...y }).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
}

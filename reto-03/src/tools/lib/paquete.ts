import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { esFechaIso, fechaLocal, sumarDias } from "./fechas.ts"
import { reglas } from "./reglas.ts"
import { rutas } from "./rutas.ts"
import { normalizar } from "./texto.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

const numero = z.number({ error: "debe ser un número" })

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: numero.positive("debe ser mayor que 0"),
  valor_unitario: numero.nonnegative("no puede ser negativo"),
  valor_total: numero.nonnegative("no puede ser negativo"),
  moneda: z.string().min(1),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().refine(esFechaIso, "debe tener formato YYYY-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

const CorreoSchema = z.object({ id: z.string(), de: z.string(), para: z.string().optional(), asunto: z.string(), fecha: z.string(), cuerpo: z.string().optional() })
const AprobacionSchema = z.object({ de: z.string(), para: z.string(), cc: z.array(z.string()).optional(), fecha: z.string(), asunto: z.string(), cuerpo: z.string() })

export type Cotizacion = {
  referencia: string | null
  fecha: string | null
  proveedor: string
  nit: string | null
  total: number | null
  moneda: string
  validez_hasta: string | null
  item: string | null
  texto: string
}
export type Aprobacion = {
  de: string
  para: string
  cc: string[]
  asunto: string
  fecha: string
  fecha_hora: string
  aprobado: boolean
  monto_aprobado: number | null
  texto: string
}
export type Factura = { numero: string; fecha: string; total: number | null }

/** Paquete normalizado (PRD 7.2). */
export type Paquete = {
  caso: string
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  /** Adjuntos ausentes, por nombre. */
  faltantes: string[]
}

const NOMBRE_CASO = /^[a-z0-9][a-z0-9-]*$/
const existe = (ruta: string) => stat(ruta).then(() => true, () => false)

/** "11.400.000" → 11400000 · "120,000.00" → 120000. */
export function aNumero(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!/\d/.test(limpio)) return null
  const separador = Math.max(limpio.lastIndexOf("."), limpio.lastIndexOf(","))
  const decimales = separador >= 0 ? limpio.length - separador - 1 : 0
  const [entero, fraccion] = separador >= 0 && decimales > 0 && decimales <= 2 ? [limpio.slice(0, separador), limpio.slice(separador + 1)] : [limpio, ""]
  const valor = Number(`${entero.replace(/[.,]/g, "")}${fraccion ? `.${fraccion}` : ""}`)
  return Number.isFinite(valor) ? valor : null
}

/** NIT sin puntos ni dígito de verificación: "900.555.111-2" → "900555111". */
export function nitLimpio(nit: string): string {
  return nit.replace(/\./g, "").replace(/-\d$/, "").replace(/\D/g, "")
}

async function leerJson<T>(ruta: string, nombre: string, schema: z.ZodType<T>): Promise<T> {
  let crudo: string
  try {
    crudo = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorHerramienta(`Paquete incompleto: falta ${nombre}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(crudo)
  } catch {
    throw new ErrorHerramienta(`No se pudo leer ${nombre}: el archivo está dañado (no es un JSON válido). Pide al solicitante que lo reenvíe.`)
  }
  const validado = schema.safeParse(json)
  if (!validado.success) {
    const detalle = validado.error.issues.map((i) => `${i.path.join(".") || "(raíz)"} ${i.message}`).join("; ")
    throw new ErrorHerramienta(`Hay datos inválidos en ${nombre}: ${detalle}. Pide al solicitante que lo corrija.`)
  }
  return validado.data
}

export async function listarSolicitudes(ctx: ContextoHerramienta): Promise<string[]> {
  try {
    return (await readdir(rutas(ctx).solicitudes, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

export async function validarCaso(ctx: ContextoHerramienta, caso: string): Promise<void> {
  if (!NOMBRE_CASO.test(caso) || !(await existe(rutas(ctx).caso(caso)))) {
    throw new ErrorHerramienta(`La solicitud "${caso}" no existe. Disponibles: ${(await listarSolicitudes(ctx)).join(", ") || "ninguna"}.`)
  }
}

export function parsearCotizacion(texto: string): Cotizacion {
  const linea = (patron: RegExp) => texto.match(patron)?.[1]?.trim() ?? null
  const fecha = linea(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const total = texto.match(/TOTAL[^:\n]*:\s*([A-Z]{3})\s*\$?\s*([\d.,]+)/)
  const validezDias = Number(linea(/Validez[^:\n]*:\s*(\d+)\s*d[ií]as/i) ?? Number.NaN)
  const nit = linea(/^NIT:\s*([\d.\-]+)/m)
  return {
    referencia: linea(/^COTIZACI[OÓ]N\s+(\S+)/m),
    fecha,
    proveedor: linea(/^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? nitLimpio(nit) : null,
    total: total ? aNumero(total[2] ?? "") : null,
    moneda: total?.[1] ?? "",
    validez_hasta: fecha && Number.isFinite(validezDias) ? sumarDias(fecha, validezDias) : null,
    item: linea(/^\d+\.\s*(.+?)\s*\|/m),
    texto,
  }
}

export function parsearFactura(texto: string): Factura | null {
  const fecha = texto.match(/Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
  if (!fecha) return null
  const total = texto.match(/^TOTAL:\s*[A-Z]{3}\s*\$?\s*([\d.,]+)/m)?.[1]
  return { numero: texto.match(/No\.\s*(\S+)/)?.[1] ?? "sin número", fecha, total: total ? aNumero(total) : null }
}

export function normalizarAprobacion(a: z.infer<typeof AprobacionSchema>): Aprobacion {
  const cuerpo = normalizar(a.cuerpo)
  const contiene = (frase: string) => new RegExp(`(^| )${normalizar(frase)}( |$)`).test(cuerpo)
  const negada = reglas.aprobacion.negativas.some(contiene)
  const monto = a.cuerpo.match(/aprobad[oa]\s+por\s+([\d.,]+)\s*(millones)?/i)
  const montoBase = monto ? aNumero(monto[1] ?? "") : null
  return {
    de: a.de,
    para: a.para,
    cc: a.cc ?? [],
    asunto: a.asunto,
    fecha: fechaLocal(a.fecha) ?? a.fecha,
    fecha_hora: a.fecha,
    aprobado: !negada && reglas.aprobacion.positivas.some(contiene),
    monto_aprobado: montoBase === null ? null : monto?.[2] ? montoBase * 1_000_000 : montoBase,
    texto: a.cuerpo,
  }
}

/** HU-1: lee y normaliza el paquete; lo que falte queda null y se nombra en `faltantes`. */
export async function leerPaquete(ctx: ContextoHerramienta, caso: string): Promise<Paquete> {
  await validarCaso(ctx, caso)
  const dir = rutas(ctx).caso(caso)
  const correo = await leerJson(join(dir, "correo.json"), "el correo de la solicitud (correo.json)", CorreoSchema)
  const solicitud = await leerJson(join(dir, "solicitud.json"), "la solicitud (solicitud.json)", SolicitudSchema)
  const faltantes: string[] = []

  const textoOpcional = async (archivo: string, nombre: string) => {
    if (await existe(join(dir, archivo))) return readFile(join(dir, archivo), "utf8")
    faltantes.push(nombre)
    return null
  }
  const textoCotizacion = await textoOpcional("cotizacion.txt", "cotizacion")
  let aprobacion: Aprobacion | null = null
  if (await existe(join(dir, "aprobacion.json"))) aprobacion = normalizarAprobacion(await leerJson(join(dir, "aprobacion.json"), "el correo de aprobación (aprobacion.json)", AprobacionSchema))
  else faltantes.push("aprobacion")
  const textoFactura = (await existe(join(dir, "factura.txt"))) ? await readFile(join(dir, "factura.txt"), "utf8") : null

  return {
    caso,
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: textoCotizacion ? parsearCotizacion(textoCotizacion) : null,
    aprobacion,
    factura: textoFactura ? parsearFactura(textoFactura) : null,
    faltantes,
  }
}

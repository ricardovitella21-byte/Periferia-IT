import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { rutas } from "./rutas.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

const CELDA = /^[A-Z]{1,3}[1-9]\d*$/
const PlantillaCeldasSchema = z.array(
  z.object({
    hoja: z.string().min(1),
    celda_etiqueta: z.string().regex(CELDA),
    etiqueta: z.string().min(1),
    celda_valor: z.string().regex(CELDA),
  }),
)
const PlantillaCamposSchema = z.array(z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() }))
const SoportesExigidosSchema = z.array(z.string())
const IndiceSoportesSchema = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string().nullable(),
    pais_emisor: z.string(),
    descripcion: z.string(),
  }),
)
export type SoporteRepositorio = z.infer<typeof IndiceSoportesSchema>[number]
const GlosarioSchema = z.record(z.string(), z.string())
const MaestroSchema = z.record(z.string(), z.unknown())
export type Maestro = z.infer<typeof MaestroSchema>

/** Campo pedido por el cliente, venga de una plantilla Excel o PDF/portal. */
export type CampoPlantilla = {
  etiqueta: string
  obligatorio: boolean | null
  hoja?: string
  celda_etiqueta?: string
  celda_valor?: string
}

export type CasoCargado = {
  solicitud: Solicitud
  plantilla: { archivo: string; campos: CampoPlantilla[] } | null
  soportesExigidos: string[]
  /** Problemas no fatales: el proceso continúa con lo que sí se pudo leer. */
  advertencias: string[]
}

const NOMBRE_CASO = /^[a-z0-9][a-z0-9-]*$/

async function existe(ruta: string): Promise<boolean> {
  return stat(ruta).then(
    () => true,
    () => false,
  )
}

/** Lee y valida un JSON; los errores salen como mensajes legibles, sin trazas. */
async function leerJson<T>(ruta: string, nombre: string, schema: z.ZodType<T>): Promise<T> {
  let crudo: string
  try {
    crudo = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorHerramienta(`No se encontró ${nombre}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(crudo)
  } catch {
    throw new ErrorHerramienta(`No se pudo leer ${nombre}: el archivo está dañado (no es un JSON válido).`)
  }
  const validado = schema.safeParse(json)
  if (!validado.success) {
    const detalle = validado.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("; ")
    throw new ErrorHerramienta(`No se pudo leer ${nombre}: el archivo no tiene la estructura esperada (${detalle}).`)
  }
  return validado.data
}

export async function listarCasos(ctx: ContextoHerramienta): Promise<string[]> {
  try {
    const entradas = await readdir(rutas(ctx).casos, { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

/** Falla con un mensaje claro si el caso no existe (lista los disponibles). */
export async function validarCaso(ctx: ContextoHerramienta, caso: string): Promise<void> {
  if (!NOMBRE_CASO.test(caso) || !(await existe(rutas(ctx).caso(caso)))) {
    const disponibles = await listarCasos(ctx)
    throw new ErrorHerramienta(
      `El caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ") || "ninguno"}.`,
    )
  }
}

export async function casoExiste(ctx: ContextoHerramienta, caso: string): Promise<boolean> {
  return NOMBRE_CASO.test(caso) && existe(rutas(ctx).caso(caso))
}

async function cargarPlantilla(dir: string, formato: string): Promise<CasoCargado["plantilla"]> {
  const celdas = join(dir, "plantilla-celdas.json")
  const campos = join(dir, "plantilla-campos.json")
  const preferirCeldas = formato === "xlsx" || !(await existe(campos))
  if (preferirCeldas && (await existe(celdas))) {
    const filas = await leerJson(celdas, "La plantilla Excel (plantilla-celdas.json)", PlantillaCeldasSchema)
    return { archivo: "plantilla-celdas.json", campos: filas.map((f) => ({ ...f, obligatorio: null })) }
  }
  if (await existe(campos)) {
    const filas = await leerJson(campos, "La plantilla de campos (plantilla-campos.json)", PlantillaCamposSchema)
    return { archivo: "plantilla-campos.json", campos: filas }
  }
  return null
}

export async function cargarCaso(ctx: ContextoHerramienta, caso: string): Promise<CasoCargado> {
  await validarCaso(ctx, caso)
  const dir = rutas(ctx).caso(caso)
  const solicitud = await leerJson(join(dir, "solicitud.json"), `La solicitud del caso "${caso}"`, SolicitudSchema)
  const advertencias: string[] = []

  let plantilla: CasoCargado["plantilla"] = null
  try {
    plantilla = await cargarPlantilla(dir, solicitud.formato)
    if (!plantilla) advertencias.push("El caso no trae plantilla: no hay campos que mapear.")
  } catch (e) {
    advertencias.push(`${mensajeDe(e)} Se continúa sin campos; el resto del proceso (soportes) sí se puede hacer.`)
  }

  let soportesExigidos: string[] = []
  try {
    soportesExigidos = await leerJson(join(dir, "soportes-exigidos.json"), "La lista de soportes exigidos", SoportesExigidosSchema)
  } catch (e) {
    advertencias.push(`${mensajeDe(e)} Se continúa sin lista de soportes exigidos.`)
  }
  return { solicitud, plantilla, soportesExigidos, advertencias }
}

export function cargarMaestro(ctx: ContextoHerramienta): Promise<Maestro> {
  return leerJson(rutas(ctx).maestro, "El repositorio maestro (maestro.json)", MaestroSchema)
}

export async function cargarGlosario(ctx: ContextoHerramienta): Promise<Record<string, string>> {
  return leerJson(rutas(ctx).glosario, "El glosario de campos", GlosarioSchema)
}

export function cargarIndiceSoportes(ctx: ContextoHerramienta): Promise<SoporteRepositorio[]> {
  return leerJson(join(rutas(ctx).soportes, "index.json"), "El índice de soportes", IndiceSoportesSchema)
}

export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

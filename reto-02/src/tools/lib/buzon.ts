import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join } from "node:path"
import { z } from "zod"
import { reglas } from "./reglas.ts"
import { rutas } from "./rutas.ts"
import { normalizar } from "./texto.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Correo = z.infer<typeof CorreoSchema>

const ComercialesSchema = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }))
export type Comercial = z.infer<typeof ComercialesSchema>[number]

const ProcesadosSchema = z.record(
  z.string(),
  z.object({ clasificacion: z.string(), accion: z.string(), id_contrato: z.string().nullable(), ts: z.string() }),
)
export type Procesados = z.infer<typeof ProcesadosSchema>

const ID_MENSAJE = /^[a-z0-9][a-z0-9-]*$/

export type TipoDocumento = "contrato" | "contrato_marco" | "otrosi" | "otro_contractual" | "no_contrato" | "desconocido"

export type Adjunto = { nombre: string; texto: string; tipo: TipoDocumento; titulo: string }

export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const existe = (ruta: string) => stat(ruta).then(() => true, () => false)

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
  if (!validado.success) throw new ErrorHerramienta(`No se pudo leer ${nombre}: estructura inesperada.`)
  return validado.data
}

export async function listarMensajes(ctx: ContextoHerramienta): Promise<string[]> {
  try {
    const entradas = await readdir(rutas(ctx).buzon, { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

export async function validarMensaje(ctx: ContextoHerramienta, id: string): Promise<void> {
  if (!ID_MENSAJE.test(id) || !(await existe(rutas(ctx).mensaje(id)))) {
    const disponibles = await listarMensajes(ctx)
    throw new ErrorHerramienta(`El mensaje "${id}" no existe en el buzón. Mensajes: ${disponibles.join(", ") || "ninguno"}.`)
  }
}

export async function leerCorreo(ctx: ContextoHerramienta, id: string): Promise<Correo> {
  await validarMensaje(ctx, id)
  return leerJson(join(rutas(ctx).mensaje(id), "correo.json"), `el correo ${id}`, CorreoSchema)
}

/** Texto de un adjunto: .txt directo; .pdf con texto nativo (P1); otros formatos no se leen. */
export async function leerTextoArchivo(ruta: string): Promise<string> {
  const extension = extname(ruta).toLowerCase()
  if (extension === ".txt" || extension === ".md") return readFile(ruta, "utf8")
  if (extension === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf")
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(ruta)))
    const { text } = await extractText(pdf, { mergePages: true })
    return text
  }
  throw new ErrorHerramienta(`Formato de adjunto no soportado: ${extension || "sin extensión"}.`)
}

/** Clasifica el documento por su título (primera línea con texto). */
export function tipoDocumento(texto: string): { tipo: TipoDocumento; titulo: string } {
  const titulo = texto.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ""
  const t = normalizar(titulo)
  if (!t) return { tipo: "desconocido", titulo }
  if (reglas.documentos_no_contrato.some((d) => t.startsWith(d))) return { tipo: "no_contrato", titulo }
  if (t.startsWith("otrosi")) return { tipo: "otrosi", titulo }
  if (t.startsWith("contrato marco")) return { tipo: "contrato_marco", titulo }
  if (t.startsWith("contrato")) return { tipo: "contrato", titulo }
  if (reglas.documentos_contrato.some((d) => t.startsWith(d))) return { tipo: "otro_contractual", titulo }
  return { tipo: "desconocido", titulo }
}

export async function leerAdjuntos(ctx: ContextoHerramienta, correo: Correo): Promise<{ adjuntos: Adjunto[]; problemas: string[] }> {
  const adjuntos: Adjunto[] = []
  const problemas: string[] = []
  for (const nombre of correo.adjuntos) {
    const ruta = join(rutas(ctx).mensaje(correo.id), nombre)
    try {
      const texto = await leerTextoArchivo(ruta)
      adjuntos.push({ nombre, texto, ...tipoDocumento(texto) })
    } catch (e) {
      problemas.push(`${nombre}: ${e instanceof ErrorHerramienta ? e.message : "no se pudo leer"}`)
    }
  }
  return { adjuntos, problemas }
}

/** El adjunto contractual del mensaje (contrato, contrato marco u otrosí), si existe. */
export function adjuntoContractual(adjuntos: Adjunto[]): Adjunto | undefined {
  return adjuntos.find((a) => a.tipo === "contrato" || a.tipo === "contrato_marco" || a.tipo === "otrosi" || a.tipo === "otro_contractual")
}

export function cargarComerciales(ctx: ContextoHerramienta): Promise<Comercial[]> {
  return leerJson(rutas(ctx).comerciales, "comerciales.json", ComercialesSchema)
}

export async function leerProcesados(ctx: ContextoHerramienta): Promise<Procesados> {
  if (!(await existe(rutas(ctx).procesados))) return {}
  return leerJson(rutas(ctx).procesados, "out/procesados.json", ProcesadosSchema)
}

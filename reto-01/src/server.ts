import { resolve, sep } from "node:path"
import { z } from "zod"
import index from "../web/index.html"
import { ejecutarTurno, type Presupuesto } from "./agent/ciclo.ts"
import { cargarSistema } from "./agent/prompt.ts"
import { RegistroHerramientas } from "./agent/registro.ts"
import { AlmacenSesiones } from "./agent/sesiones.ts"
import { leerConfig } from "./config.ts"
import { crearProveedor } from "./llm/index.ts"
import * as proveedorTools from "./tools/proveedor.ts"

const RAIZ = resolve(import.meta.dir, "..")
const OUT = resolve(RAIZ, "out")
const config = leerConfig()
const llm = crearProveedor(config)
const registro = new RegistroHerramientas()
const sistema = await cargarSistema(RAIZ)
const sesiones = new AlmacenSesiones(resolve(OUT, "sesiones"))

/** Tope diario de tokens en memoria (se reinicia al cambiar el día o al reiniciar el servidor). */
function crearPresupuesto(maximo: number): Presupuesto {
  let dia = ""
  let usados = 0
  const hoy = () => new Date().toISOString().slice(0, 10)
  const sincronizar = () => {
    if (dia !== hoy()) [dia, usados] = [hoy(), 0]
  }
  return {
    disponible: () => (sincronizar(), usados < maximo),
    consumir: (tokens) => {
      sincronizar()
      usados += tokens
    },
  }
}
const presupuesto = crearPresupuesto(config.maxTokensDia)

const ChatSchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().trim().min(1, "El mensaje está vacío").max(4000, "El mensaje es demasiado largo (máx. 4000 caracteres)"),
})

const json = (data: unknown, status = 200) => Response.json(data, { status })
const error = (mensaje: string, status: number) => json({ ok: false, error: mensaje }, status)

/** Si ACCESS_KEY está definida, la API exige el encabezado x-clave-acceso. */
function autorizado(req: Request): boolean {
  if (!config.claveAcceso) return true
  return req.headers.get("x-clave-acceso") === config.claveAcceso
}

function conAcceso(manejador: (req: Request) => Promise<Response> | Response) {
  return (req: Request) => (autorizado(req) ? manejador(req) : error("Falta la clave de acceso o no es válida.", 401))
}

async function chat(req: Request): Promise<Response> {
  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return error("El cuerpo debe ser JSON: { sessionId?, message }.", 400)
  }
  const datos = ChatSchema.safeParse(cuerpo)
  if (!datos.success) return error(datos.error.issues[0]?.message ?? "Solicitud inválida.", 400)

  const existente = datos.data.sessionId ? await sesiones.obtener(datos.data.sessionId) : null
  if (datos.data.sessionId && !existente) return error("La sesión no existe. Abre una sesión nueva.", 404)
  const sesion = existente ?? sesiones.crear()
  if (!sesiones.tomar(sesion.id)) return error("Esta sesión ya está procesando un mensaje. Espera la respuesta.", 409)
  try {
    const turno = await ejecutarTurno(sesion, datos.data.message, {
      llm,
      registro,
      sistema,
      ctx: { directory: RAIZ, sessionId: sesion.id },
      limites: { maxIteraciones: config.maxIteraciones, maxTokensSesion: config.maxTokensSesion },
      presupuesto,
    })
    await sesiones.guardar(sesion)
    return json({ sessionId: sesion.id, ...turno, tokensSesion: sesion.tokens })
  } finally {
    sesiones.liberar(sesion.id)
  }
}

async function obtenerSesion(id: string): Promise<Response> {
  const sesion = await sesiones.obtener(id)
  if (!sesion) return error("La sesión no existe.", 404)
  return json({ sessionId: sesion.id, creada: sesion.creada, tokens: sesion.tokens, pendienteConfirmacion: sesion.pendienteConfirmacion, historial: sesion.historial })
}

/** Descarga de archivos generados, confinada a out/ (sin sesiones ni rutas fuera). */
async function archivo(req: Request): Promise<Response> {
  const relativo = decodeURIComponent(new URL(req.url).pathname.replace(/^\/api\/archivos\//, ""))
  const destino = resolve(OUT, relativo)
  if (!destino.startsWith(OUT + sep) || relativo.startsWith("sesiones")) return error("Ruta no permitida.", 403)
  const f = Bun.file(destino)
  if (!(await f.exists())) return error("El archivo no existe (¿ya se generó?).", 404)
  const nombre = destino.split(sep).pop() ?? "archivo"
  return new Response(f, { headers: { "content-disposition": `inline; filename="${nombre}"` } })
}

async function casos(): Promise<Response> {
  const salida = JSON.parse(await proveedorTools.listar_casos.execute({}, { directory: RAIZ, sessionId: "api" })) as unknown
  return json(salida)
}

const servidor = Bun.serve({
  port: config.puerto,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/api/health": {
      GET: () => json({ ok: true, provider: llm.nombre, model: llm.modelo, requiereClave: Boolean(config.claveAcceso), maxIteraciones: config.maxIteraciones }),
    },
    "/api/chat": { POST: conAcceso(chat) },
    "/api/sessions/:id": { GET: conAcceso((req) => obtenerSesion(new URL(req.url).pathname.split("/").pop() ?? "")) },
    "/api/casos": { GET: conAcceso(casos) },
    "/api/archivos/*": { GET: conAcceso(archivo) },
  },
  fetch: () => error("No encontrado.", 404),
  error: (e) => {
    console.error("[servidor]", e instanceof Error ? e.message : e)
    return error("Error interno del servidor.", 500)
  },
})

console.log(`Agente Registro como Proveedor en ${servidor.url} · proveedor ${llm.nombre} · modelo ${llm.modelo}`)

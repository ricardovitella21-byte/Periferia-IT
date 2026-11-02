import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { ErrorProveedor, type LlamadaHerramienta, type ProveedorLLM, type ResultadoHerramienta } from "../llm/adapter.ts"
import type { ContextoHerramienta } from "../tools/lib/tipos.ts"
import { esConfirmacion, terminaEnPregunta } from "./confirmacion.ts"
import { HERRAMIENTA_CONFIRMACION, REQUIEREN_CONFIRMACION, type RegistroHerramientas } from "./registro.ts"
import type { LlamadaVisible, Sesion } from "./sesiones.ts"

export type Limites = { maxIteraciones: number; maxTokensSesion: number }

/** Tope global de tokens (por día) para que un link público no gaste la clave sin límite. */
export interface Presupuesto {
  disponible(): boolean
  consumir(tokens: number): void
}

export type DependenciasCiclo = {
  llm: ProveedorLLM
  registro: RegistroHerramientas
  sistema: string
  ctx: ContextoHerramienta
  limites: Limites
  presupuesto?: Presupuesto
}

export type ResultadoTurno = {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  error: string | null
  iteraciones: number
  tokens: { entrada: number; salida: number }
}

type Salida = { ok?: boolean; data?: unknown; error?: string }

function leerSalida(contenido: string): Salida {
  try {
    return JSON.parse(contenido) as Salida
  } catch {
    return { ok: false, error: contenido }
  }
}

/** Archivos generados en out/ que el chat puede ofrecer para descarga. */
function archivosDe(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return []
  const { ruta, ruta_archivo } = data as { ruta?: unknown; ruta_archivo?: unknown }
  return [ruta, ruta_archivo].filter((r): r is string => typeof r === "string" && r.startsWith("out/"))
}

function resumenDe(salida: Salida): string {
  if (salida.ok === false) return salida.error ?? "error"
  const data = salida.data as Record<string, unknown> | undefined
  if (!data) return "ok"
  const partes: string[] = []
  for (const clave of ["tipo_documento", "clasificacion", "accion", "id_contrato"] as const) {
    if (typeof data[clave] === "string") partes.push(data[clave] as string)
  }
  const lista = (clave: string, etiqueta: string) => {
    const valor = data[clave]
    if (Array.isArray(valor) && valor.length) partes.push(`${etiqueta}: ${valor.map((v) => (typeof v === "string" ? v : ((v as { id_contrato?: string }).id_contrato ?? "?"))).join(", ")}`)
  }
  lista("requiere_revision", "revisión")
  lista("campos_baja_confianza", "baja confianza")
  lista("vencen", "vencen")
  lista("polizas_pendientes", "pólizas pendientes")
  if (typeof data.pendientes === "number") partes.push(`${data.pendientes} pendientes`)
  if (typeof data.ruta_archivo === "string") partes.push(data.ruta_archivo)
  if (typeof data.ruta === "string") partes.push(data.ruta)
  return partes.join(" · ") || "ok"
}

async function registrarEvento(ctx: ContextoHerramienta, evento: Record<string, unknown>): Promise<void> {
  try {
    const dir = join(ctx.directory, "out")
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, ...evento })}\n`)
  } catch {
    // El log nunca interrumpe el turno.
  }
}

const NOTA_TOPE = (n: number) =>
  `[Aviso del sistema] Se alcanzó el tope de ${n} llamadas a herramientas en este turno. No puedes llamar más herramientas: responde con lo que tienes y lista lo que faltó por hacer.`

/**
 * Un turno del agente: prompt → modelo → herramientas → … → respuesta.
 * CA1 tope de iteraciones · CA2 valores solo de herramientas · CA3 confirmación humana · CA5 errores claros.
 */
export async function ejecutarTurno(sesion: Sesion, mensaje: string, deps: DependenciasCiclo): Promise<ResultadoTurno> {
  const { llm, registro, sistema, ctx, limites, presupuesto } = deps
  const toolCalls: LlamadaVisible[] = []
  const tokens = { entrada: 0, salida: 0 }
  // RN4: una acción externa solo se autoriza si el turno anterior pidió confirmación y este mensaje la da.
  const confirmacionValida = sesion.pendienteConfirmacion && esConfirmacion(mensaje)
  sesion.pendienteConfirmacion = false

  const cerrar = (reply: string, error: string | null, needsConfirmation: boolean, iteraciones: number): ResultadoTurno => {
    sesion.pendienteConfirmacion = needsConfirmation
    const ts = new Date().toISOString()
    sesion.historial.push({ rol: "usuario", texto: mensaje, ts }, { rol: "asistente", texto: reply, ts, toolCalls, needsConfirmation, error })
    return { reply, toolCalls, needsConfirmation, error, iteraciones, tokens }
  }

  const usados = sesion.tokens.entrada + sesion.tokens.salida
  if (usados >= limites.maxTokensSesion) {
    return cerrar(`Esta sesión alcanzó su tope de ${limites.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`, "tope de tokens de la sesión", false, 0)
  }
  if (presupuesto && !presupuesto.disponible()) {
    return cerrar("Se alcanzó el tope diario de uso del modelo en este servidor. Intenta mañana o usa el modo sin modelo (demo.ts).", "tope diario de tokens", false, 0)
  }

  sesion.mensajes.push({ rol: "usuario", texto: mensaje })
  let pidioConfirmacion = false

  for (let iteracion = 1; ; iteracion++) {
    const ultima = iteracion > limites.maxIteraciones
    let respuesta
    try {
      respuesta = await llm.enviar(sesion.mensajes, registro.definiciones(), { sistema, permitirHerramientas: !ultima })
    } catch (e) {
      const error = e instanceof ErrorProveedor ? e.message : "Error inesperado al llamar al modelo."
      await registrarEvento(ctx, { evento: "error_llm", error })
      return cerrar(`⚠️ ${error}\n\nLa sesión sigue activa: puedes reintentar con el mismo mensaje.`, error, false, iteracion)
    }
    tokens.entrada += respuesta.uso.entrada
    tokens.salida += respuesta.uso.salida
    sesion.tokens.entrada += respuesta.uso.entrada
    sesion.tokens.salida += respuesta.uso.salida
    presupuesto?.consumir(respuesta.uso.entrada + respuesta.uso.salida)

    const llamadas: LlamadaHerramienta[] = ultima ? [] : respuesta.llamadas
    // En el cierre por tope no se ejecutan llamadas: no se guardan para no dejar tool_use sin resultado.
    sesion.mensajes.push(
      ultima && respuesta.llamadas.length > 0
        ? { rol: "asistente", texto: respuesta.texto, llamadas: [] }
        : { rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, crudo: respuesta.crudo },
    )

    if (llamadas.length === 0) {
      let reply = respuesta.texto
      if (respuesta.fin === "rechazo") reply = "El modelo declinó responder esta solicitud. Reformúlala o procesa el caso paso a paso."
      else if (respuesta.fin === "limite_tokens") reply = `${reply}\n\n_(La respuesta se cortó por longitud.)_`
      else if (!reply) reply = "(El modelo no devolvió texto.)"
      return cerrar(reply, null, pidioConfirmacion || terminaEnPregunta(reply), iteracion)
    }

    const resultados: ResultadoHerramienta[] = []
    for (const llamada of llamadas) {
      const inicio = performance.now()
      let argumentos = llamada.argumentos
      let aviso = ""
      const nombre = registro.resolver(llamada.nombre)?.nombre ?? llamada.nombre
      if (REQUIEREN_CONFIRMACION.has(nombre) && typeof argumentos === "object" && argumentos !== null && (argumentos as { confirmado?: unknown }).confirmado === true && !confirmacionValida) {
        // El servidor, no el modelo, decide si hubo confirmación explícita en el turno anterior.
        argumentos = { ...argumentos, confirmado: false }
        aviso = " (el servidor anuló confirmado=true: la analista no confirmó en respuesta a una pregunta de confirmación)"
      }
      const ejecucion = await registro.ejecutar(llamada.nombre, argumentos, ctx)
      const contenido = ejecucion.valida ? ejecucion.salida : JSON.stringify({ ok: false, error: ejecucion.error })
      if (!ejecucion.valida) await registrarEvento(ctx, { herramienta: llamada.nombre, ok: false, resumen: ejecucion.error })
      const salida = leerSalida(contenido)
      const ok = salida.ok === true
      if (ok && nombre === HERRAMIENTA_CONFIRMACION) pidioConfirmacion = true
      resultados.push({ idLlamada: llamada.id, contenido: aviso ? JSON.stringify({ ...salida, aviso_servidor: aviso.trim() }) : contenido, esError: !ok })
      toolCalls.push({
        id: llamada.id,
        nombre,
        argumentos,
        ok,
        resumen: resumenDe(salida) + aviso,
        duracionMs: Math.round(performance.now() - inicio),
        archivos: ok ? archivosDe(salida.data) : [],
      })
    }
    const alcanzaTope = iteracion >= limites.maxIteraciones
    sesion.mensajes.push({ rol: "resultados", resultados, ...(alcanzaTope ? { nota: NOTA_TOPE(limites.maxIteraciones) } : {}) })
  }
}

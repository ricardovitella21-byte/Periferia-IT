import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, Respuesta } from "./adapter.ts"
import { esConfirmacion } from "../agent/confirmacion.ts"
import { fechaReferencia } from "../tools/lib/fechas.ts"

/**
 * Proveedor determinista SIN modelo de lenguaje: procesa el buzón mensaje por mensaje
 * (extraer → validar → registrar), genera las alertas y pide confirmación de lo dudoso.
 * Sirve para probar el chat y el ciclo sin clave; todo lo que dice sale de las herramientas.
 */

type Datos = Record<string, unknown>
type Paso = { nombre: string; args: Datos; ok: boolean; data: Datos; error?: string }
type Revision = { campo: string; valor_propuesto: unknown; motivo: string }

const FECHA = /\b\d{4}-\d{2}-\d{2}\b/

let contador = 0
const llamada = (nombre: string, argumentos: Datos): LlamadaHerramienta => ({ id: `guion-${++contador}`, nombre, argumentos })
const texto = (t: string): Respuesta => ({ texto: t, llamadas: [], fin: "fin", uso: { entrada: 0, salida: 0 } })
const usar = (nombre: string, argumentos: Datos): Respuesta => ({ texto: "", llamadas: [llamada(nombre, argumentos)], fin: "herramientas", uso: { entrada: 0, salida: 0 } })

/** Pasos (llamada, argumentos y resultado) en el orden en que ocurrieron, desde un índice. */
function pasos(mensajes: Mensaje[], desde = 0): Paso[] {
  const llamadas = new Map<string, LlamadaHerramienta>()
  const lista: Paso[] = []
  for (const m of mensajes.slice(desde)) {
    if (m.rol === "asistente") for (const l of m.llamadas) llamadas.set(l.id, l)
    if (m.rol === "resultados") {
      for (const r of m.resultados) {
        const l = llamadas.get(r.idLlamada)
        const salida = JSON.parse(r.contenido) as { ok: boolean; data?: Datos; error?: string }
        lista.push({ nombre: l?.nombre ?? "?", args: (l?.argumentos ?? {}) as Datos, ok: salida.ok, data: salida.data ?? {}, error: salida.error })
      }
    }
  }
  return lista
}

/** Correcciones simples del mensaje de confirmación: "valor 0", "fecha fin 2027-08-31", "fecha inicio …". */
function correcciones(mensaje: string): Datos {
  const c: Datos = {}
  const valor = mensaje.match(/valor\s+(?:de\s+)?(\d[\d.,]*)/i)?.[1]
  if (valor) c.valor = Number(valor.replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."))
  const fin = mensaje.match(/fecha\s+(?:de\s+)?fin\s+(\d{4}-\d{2}-\d{2})/i)?.[1]
  if (fin) c.fecha_fin = fin
  const inicio = mensaje.match(/fecha\s+(?:de\s+)?inicio\s+(\d{4}-\d{2}-\d{2})/i)?.[1]
  if (inicio) c.fecha_inicio = inicio
  return c
}

/** Mensajes que quedaron sin registrar por revisión en turnos anteriores, con su contrato extraído. */
function pendientesDeRevision(todos: Paso[]): Array<{ id: string; contrato: Datos }> {
  const pendientes = new Map<string, Datos>()
  for (const p of todos) {
    const id = String(p.args.mensaje_id ?? "")
    if (p.nombre === "contratos_registrar" && !p.ok && p.error?.startsWith("requiere revisión")) pendientes.set(id, p.args.contrato as Datos)
    if (p.nombre === "contratos_registrar" && p.ok) pendientes.delete(id)
  }
  return [...pendientes].map(([id, contrato]) => ({ id, contrato }))
}

function resumen(turno: Paso[], hoy: string): string {
  const filas = new Map<string, { clasificacion: string; contrato: string; accion: string }>()
  const revisiones: Array<{ id: string; revision: Revision[] }> = []
  for (const p of turno) {
    const id = String(p.args.mensaje_id ?? "")
    if (p.nombre === "contratos_validar" && p.ok) {
      filas.set(id, { clasificacion: String(p.data.clasificacion), contrato: String(p.data.id_contrato ?? "—"), accion: "" })
      const revision = (p.data.revision as Revision[]) ?? []
      if (revision.length) revisiones.push({ id, revision })
    }
    if (p.nombre === "contratos_registrar") {
      const fila = filas.get(id) ?? { clasificacion: "?", contrato: String(p.data.id_contrato ?? "—"), accion: "" }
      fila.accion = p.ok ? String(p.data.accion) : `no registrado (${p.error})`
      filas.set(id, fila)
    }
  }
  const alertas = turno.find((p) => p.nombre === "contratos_alertas" && p.ok)?.data as
    | { ruta: string; vencen: Array<{ id_contrato: string; fecha_fin: string }>; polizas_pendientes: Array<{ id_contrato: string }>; registrados_desde_corte: Array<{ id_contrato: string }> }
    | undefined
  const lineas = ["| Mensaje | Clasificación | Contrato | Acción |", "|---|---|---|---|", ...[...filas].map(([id, f]) => `| ${id} | ${f.clasificacion} | ${f.contrato} | ${f.accion} |`)]
  for (const r of revisiones) {
    lineas.push("", `**${r.id} requiere revisión:**`)
    for (const c of r.revision) lineas.push(`- \`${c.campo}\` = \`${String(c.valor_propuesto)}\`: ${c.motivo}`)
  }
  if (alertas) {
    lineas.push(
      "",
      `**Alertas al ${hoy}** (\`${alertas.ruta}\`):`,
      `- Vencen en 60 días o menos: ${alertas.vencen.map((v) => `${v.id_contrato} (${v.fecha_fin})`).join(", ") || "ninguno"}`,
      `- Pólizas pendientes: ${alertas.polizas_pendientes.map((p) => p.id_contrato).join(", ") || "ninguna"}`,
      `- Registrados desde el corte: ${alertas.registrados_desde_corte.map((r) => r.id_contrato).join(", ") || "ninguno"}`,
    )
  }
  lineas.push("", "_Respuesta generada por el proveedor de prueba sin IA (LLM_PROVIDER=guion)._")
  if (revisiones.length) lineas.push("", `¿Confirmas los valores propuestos para ${revisiones.map((r) => r.id).join(", ")} (puedes corregirlos, por ejemplo "confirmo el valor 0 y la fecha fin 2027-08-31")?`)
  return lineas.join("\n")
}

export class ProveedorGuion implements ProveedorLLM {
  readonly nombre = "guion"
  readonly modelo = "determinista-sin-ia"

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta> {
    if (!opciones.permitirHerramientas) return texto("Alcancé el tope de pasos de este turno. Revisa las llamadas de arriba para ver lo que se alcanzó a hacer.")
    const inicioTurno = mensajes.findLastIndex((m) => m.rol === "usuario")
    const usuario = mensajes[inicioTurno]
    const textoUsuario = usuario?.rol === "usuario" ? usuario.texto : ""
    const hoy = textoUsuario.match(FECHA)?.[0] ?? fechaReferencia()
    const turno = pasos(mensajes, inicioTurno)
    const ultimo = turno.at(-1)

    if (!ultimo) {
      const anterior = mensajes.slice(0, inicioTurno).findLast((m) => m.rol === "asistente")
      const pidio = anterior?.rol === "asistente" && /\?\s*$/.test(anterior.texto)
      const pendiente = pendientesDeRevision(pasos(mensajes.slice(0, inicioTurno)))[0]
      if (pidio && pendiente && esConfirmacion(textoUsuario)) {
        return usar("contratos_registrar", { mensaje_id: pendiente.id, contrato: { ...pendiente.contrato, ...correcciones(textoUsuario) }, confirmado: true })
      }
      if (/buz[oó]n|procesa|pendiente/i.test(textoUsuario)) return usar("contratos_leer_buzon", {})
      if (/alerta/i.test(textoUsuario)) return usar("contratos_alertas", { hoy })
      return texto('Soy el proveedor de prueba sin IA. Pídeme "procesa el buzón con fecha de hoy 2026-09-03" o "genera las alertas".')
    }

    const id = String(ultimo.args.mensaje_id ?? "")
    const cola = ((turno.find((p) => p.nombre === "contratos_leer_buzon")?.data.mensajes as Array<{ id: string }>) ?? []).map((m) => m.id)
    const siguiente = (actual: string) => cola[cola.indexOf(actual) + 1]
    const continuar = (actual: string) => {
      const proximo = siguiente(actual)
      return proximo ? usar("contratos_extraer", { mensaje_id: proximo }) : usar("contratos_alertas", { hoy })
    }

    switch (ultimo.nombre) {
      case "contratos_leer_buzon":
        return cola[0] ? usar("contratos_extraer", { mensaje_id: cola[0] }) : usar("contratos_alertas", { hoy })
      case "contratos_extraer":
        return ultimo.ok ? usar("contratos_validar", { mensaje_id: id, contrato: ultimo.data.contrato }) : continuar(id)
      case "contratos_validar": {
        const extraido = turno.findLast((p) => p.nombre === "contratos_extraer" && p.args.mensaje_id === id)
        return ultimo.ok ? usar("contratos_registrar", { mensaje_id: id, contrato: extraido?.data.contrato ?? {} }) : continuar(id)
      }
      case "contratos_registrar":
        if (turno.length === 1) {
          return texto(ultimo.ok ? `Listo: ${id} quedó ${String(ultimo.data.accion)} como ${String(ultimo.data.id_contrato)} en \`${String(ultimo.data.ruta_archivo)}\`.` : `No se registró ${id}: ${ultimo.error}`)
        }
        return continuar(id)
      case "contratos_alertas": {
        const pendientes = pendientesDeRevision(turno)
        if (pendientes.length) {
          return usar("agente_pedir_confirmacion", { accion: `registrar ${pendientes.map((p) => p.id).join(", ")} con los valores propuestos`, pregunta: "¿Confirmas los valores propuestos?" })
        }
        return texto(resumen(turno, hoy))
      }
      case "agente_pedir_confirmacion":
        return texto(resumen(turno, hoy))
      default:
        return texto(ultimo.ok ? "Hecho." : `Error: ${ultimo.error}`)
    }
  }
}

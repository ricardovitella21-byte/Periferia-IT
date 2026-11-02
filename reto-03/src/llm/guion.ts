import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, Respuesta } from "./adapter.ts"
import { esConfirmacion } from "../agent/confirmacion.ts"

/**
 * Proveedor determinista SIN modelo de lenguaje: sigue el flujo estándar de una solicitud
 * (leer → validar → construir → evidencia → confirmar → crear). Sirve para probar el chat y el
 * ciclo sin clave; todo lo que dice sale de las herramientas.
 */

type Datos = Record<string, unknown>
type Paso = { nombre: string; args: Datos; ok: boolean; data: Datos; error?: string }
type Hallazgo = { codigo: string; detalle: string; accion_sugerida: string }

const CASO = /\bsol-\d{3}\b/i
const ESPERAR = /no la crees|hasta que (?:yo )?(?:lo )?confirme|sin crear/i

let contador = 0
const llamada = (nombre: string, argumentos: Datos): LlamadaHerramienta => ({ id: `guion-${++contador}`, nombre, argumentos })
const texto = (t: string): Respuesta => ({ texto: t, llamadas: [], fin: "fin", uso: { entrada: 0, salida: 0 } })
const usar = (nombre: string, argumentos: Datos): Respuesta => ({ texto: "", llamadas: [llamada(nombre, argumentos)], fin: "herramientas", uso: { entrada: 0, salida: 0 } })

function pasos(mensajes: Mensaje[]): Paso[] {
  const llamadas = new Map<string, LlamadaHerramienta>()
  const lista: Paso[] = []
  for (const m of mensajes) {
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

const cop = (n: unknown) => `COP ${Number(n).toLocaleString("es-CO")}`

function resumen(turno: Paso[], pregunta: boolean): string {
  const paquete = turno.find((p) => p.nombre === "oc_leer_paquete")?.data as { solicitud?: Datos } | undefined
  const v = turno.find((p) => p.nombre === "oc_validar")?.data as { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, { valor: string; fuente: string }>; retroactiva: boolean } | undefined
  const payload = turno.find((p) => p.nombre === "oc_construir_payload")?.data as { orden?: { proveedor: Datos; condiciones_pago: string; aprobador: Datos; posiciones: Datos[] }; ruta_trazabilidad?: string } | undefined
  const evidencia = turno.find((p) => p.nombre === "oc_generar_evidencia")?.data
  const s = paquete?.solicitud ?? {}
  const lineas = [`**${String(s.solicitud_id ?? "")}** · ${String(s.solicitante ?? "")} · ${String(s.proveedor_nombre ?? "")} · ${cop(s.valor_total)}`, ""]
  const o = payload?.orden
  const pos = o?.posiciones[0]
  if (o && pos) {
    lineas.push(
      "| Campo | Valor |",
      "|---|---|",
      `| Proveedor | ${String(o.proveedor.codigo_sap)} · ${String(o.proveedor.nombre)} |`,
      `| Descripción | ${String(pos.descripcion)} |`,
      `| Cantidad | ${String(pos.cantidad)} ${String(pos.unidad)} × ${cop(pos.precio_unitario)} |`,
      `| Centro / subárea | ${String(pos.centro_costo)} / ${String(pos.subarea)} |`,
      `| IVA · condiciones | ${String(pos.indicador_iva)} · ${o.condiciones_pago} |`,
      `| Aprobador | ${String(o.aprobador.email)} (${String(o.aprobador.fecha_aprobacion)}) |`,
      "",
    )
  }
  if (v) {
    lineas.push(`**Controles:** ${v.apta ? "apta" : "NO apta"}${v.retroactiva ? " · **retroactiva** (queda marcada en el control)" : ""}`)
    for (const b of v.bloqueos) lineas.push(`- ⛔ ${b.codigo}: ${b.detalle} Acción: ${b.accion_sugerida}`)
    for (const c of v.confirmaciones) lineas.push(`- ❓ ${c.codigo}: ${c.detalle}`)
    for (const [campo, d] of Object.entries(v.derivados)) lineas.push(`- ↳ ${campo} derivado = ${d.valor} (${d.fuente})`)
    if (!v.bloqueos.length && !v.confirmaciones.length) lineas.push("- ✓ Todos los controles RC1–RC10 pasaron.")
  }
  if (evidencia) lineas.push("", `Evidencia: \`${String(evidencia.ruta)}\` y \`${String(evidencia.ruta_pdf)}\`. Trazabilidad: \`${String(payload?.ruta_trazabilidad ?? "")}\`.`)
  lineas.push("", "_Respuesta generada por el proveedor de prueba sin IA (LLM_PROVIDER=guion)._")
  if (pregunta) lineas.push("", "¿Confirmas que cree la OC en SAP?")
  return lineas.join("\n")
}

export class ProveedorGuion implements ProveedorLLM {
  readonly nombre = "guion"
  readonly modelo = "determinista-sin-ia"

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta> {
    if (!opciones.permitirHerramientas) return texto("Alcancé el tope de pasos de este turno. Revisa las llamadas de arriba para ver lo que se alcanzó a hacer.")
    const inicio = mensajes.findLastIndex((m) => m.rol === "usuario")
    const usuario = mensajes[inicio]
    const textoUsuario = usuario?.rol === "usuario" ? usuario.texto : ""
    const turno = pasos(mensajes.slice(inicio))
    const ultimo = turno.at(-1)

    if (!ultimo) {
      const anterior = mensajes.slice(0, inicio).findLast((m) => m.rol === "asistente")
      const pidio = anterior?.rol === "asistente" && /\?\s*$/.test(anterior.texto)
      const construido = pasos(mensajes.slice(0, inicio)).findLast((p) => p.nombre === "oc_construir_payload" && p.ok)
      if (pidio && construido && esConfirmacion(textoUsuario)) {
        return usar("oc_crear", { caso: construido.args.caso, payload: construido.data.orden, confirmado: true })
      }
      const caso = textoUsuario.match(CASO)?.[0]?.toLowerCase()
      return caso ? usar("oc_leer_paquete", { caso }) : usar("oc_listar_solicitudes", {})
    }

    const caso = String(ultimo.args.caso ?? "")
    switch (ultimo.nombre) {
      case "oc_listar_solicitudes": {
        const lista = (ultimo.data.solicitudes as Array<{ caso: string; proveedor?: string; valor_total?: number }>) ?? []
        return texto(["Solicitudes disponibles. Dime cuál proceso:", "", ...lista.map((s) => `- \`${s.caso}\` · ${s.proveedor ?? ""} · ${cop(s.valor_total)}`)].join("\n"))
      }
      case "oc_leer_paquete":
        return ultimo.ok ? usar("oc_validar", { caso, paquete: ultimo.data }) : texto(`No pude leer el paquete: ${ultimo.error}`)
      case "oc_validar": {
        if (!ultimo.ok) return texto(`No pude validar: ${ultimo.error}`)
        if (!ultimo.data.apta) return usar("oc_crear", { caso })
        const paquete = turno.find((p) => p.nombre === "oc_leer_paquete")?.data
        return usar("oc_construir_payload", { caso, paquete, derivados: ultimo.data.derivados })
      }
      case "oc_construir_payload":
        return ultimo.ok ? usar("oc_generar_evidencia", { caso }) : texto(`No pude construir la OC: ${ultimo.error}`)
      case "oc_generar_evidencia": {
        const v = turno.find((p) => p.nombre === "oc_validar")?.data as { confirmaciones: Hallazgo[] }
        const payload = turno.find((p) => p.nombre === "oc_construir_payload")?.data.orden
        if (v.confirmaciones.length || ESPERAR.test(textoUsuario)) {
          return usar("agente_pedir_confirmacion", { accion: `crear la OC de ${caso}`, caso, pregunta: "¿Confirmas que cree la OC en SAP?" })
        }
        return usar("oc_crear", { caso, payload })
      }
      case "agente_pedir_confirmacion":
        return texto(resumen(turno, true))
      case "oc_crear":
        if (turno.some((p) => p.nombre === "oc_validar")) return texto(`${resumen(turno, false)}\n\n${ultimo.ok ? `**OC ${String(ultimo.data.numero_oc)}** creada.` : "No se creó la OC (intento registrado en el control de auditoría)."}`)
        return texto(
          ultimo.ok
            ? `Listo: OC **${String(ultimo.data.numero_oc)}**${ultimo.data.idempotente ? " (ya existía; no se duplicó)" : ""}${ultimo.data.retroactiva ? ", marcada como retroactiva" : ""}. Evidencia: \`${String(ultimo.data.ruta_evidencia ?? "")}\`.`
            : `No se creó la OC: ${ultimo.error}`,
        )
      default:
        return texto(ultimo.ok ? "Hecho." : `Error: ${ultimo.error}`)
    }
  }
}

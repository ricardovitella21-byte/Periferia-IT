import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, Respuesta } from "./adapter.ts"
import { esConfirmacion } from "../agent/confirmacion.ts"

/**
 * Proveedor determinista SIN modelo de lenguaje: sigue el flujo estándar paso a paso.
 * Sirve para probar el chat, el ciclo y la confirmación sin clave, y demuestra que
 * el ciclo del agente no depende del proveedor. Todo lo que dice sale de las herramientas.
 */

type Datos = Record<string, unknown>
type Paso = { nombre: string; ok: boolean; data: Datos; error?: string }

const CASO = /\b(?:co|ec|pe|pa|hn)-[a-z0-9-]+\b/
const FECHA = /\b\d{4}-\d{2}-\d{2}\b/

let contador = 0
const llamada = (nombre: string, argumentos: Datos): LlamadaHerramienta => ({ id: `guion-${++contador}`, nombre, argumentos })
const texto = (t: string): Respuesta => ({ texto: t, llamadas: [], fin: "fin", uso: { entrada: 0, salida: 0 } })
const herramienta = (l: LlamadaHerramienta): Respuesta => ({ texto: "", llamadas: [l], fin: "herramientas", uso: { entrada: 0, salida: 0 } })

/** Pasos (llamada + resultado) desde el último mensaje de la analista. */
function pasosDelTurno(mensajes: Mensaje[]): Paso[] {
  const inicio = mensajes.findLastIndex((m) => m.rol === "usuario")
  const pasos: Paso[] = []
  const nombres = new Map<string, string>()
  for (const m of mensajes.slice(inicio + 1)) {
    if (m.rol === "asistente") for (const l of m.llamadas) nombres.set(l.id, l.nombre)
    if (m.rol === "resultados") {
      for (const r of m.resultados) {
        const salida = JSON.parse(r.contenido) as { ok: boolean; data?: Datos; error?: string }
        pasos.push({ nombre: nombres.get(r.idLlamada) ?? "?", ok: salida.ok, data: salida.data ?? {}, error: salida.error })
      }
    }
  }
  return pasos
}

function ultimoCaso(mensajes: Mensaje[]): string | null {
  for (const m of [...mensajes].reverse()) {
    if (m.rol === "usuario") {
      const c = m.texto.match(CASO)?.[0]
      if (c) return c
    }
    if (m.rol === "asistente") {
      for (const l of m.llamadas) {
        const c = (l.argumentos as { caso?: unknown }).caso
        if (typeof c === "string") return c
      }
    }
  }
  return null
}

function resumenFinal(pasos: Paso[], caso: string): string {
  const de = (n: string) => pasos.find((p) => p.nombre === n)
  const sol = de("proveedor_leer_solicitud")?.data
  const map = de("proveedor_mapear_campos")?.data
  const form = de("proveedor_generar_formulario")
  const paq = de("proveedor_armar_paquete")?.data as
    | { ruta: string; listo_para_firma: boolean; fecha_referencia: string; checklist: { bloqueos: string[]; campos_faltantes: Array<{ etiqueta: string }>; campos_por_confirmar: Array<{ etiqueta: string; nota: string }> } }
    | undefined
  const lineas = [`**Caso \`${caso}\`**${sol ? ` · ${String(sol.cliente)} (${String(sol.pais)}) · formato ${String(sol.formato)}` : ""}`, ""]
  if (map) {
    const n = (k: string) => (Array.isArray(map[k]) ? (map[k] as unknown[]).length : 0)
    lineas.push(`| Llenos | Por confirmar | Faltantes |`, `|---|---|---|`, `| ${n("llenos")} | ${n("requiere_confirmacion")} | ${n("faltantes")} |`, "")
  }
  if (form) lineas.push(form.ok ? `- Formulario: \`${String(form.data.ruta)}\`${form.data.soportado === false ? " (portal: formato no soportado, valores listos para copiar)" : ""}` : `- Formulario: no generado (${form.error})`)
  if (paq) {
    lineas.push(`- Paquete: \`${paq.ruta}\` → **${paq.listo_para_firma ? "✅ listo para firma" : "⛔ NO listo para firma"}** (fecha de referencia ${paq.fecha_referencia})`)
    for (const b of paq.checklist.bloqueos) lineas.push(`  - ${b}`)
    for (const c of paq.checklist.campos_por_confirmar) lineas.push(`- **${c.etiqueta}**: ${c.nota}`)
    for (const c of paq.checklist.campos_faltantes) lineas.push(`- Faltante: **${c.etiqueta}**`)
  }
  lineas.push("", "_Respuesta generada por el proveedor de prueba sin IA (LLM_PROVIDER=guion)._", "", "¿Quieres que simule el envío del paquete al cliente?")
  return lineas.join("\n")
}

export class ProveedorGuion implements ProveedorLLM {
  readonly nombre = "guion"
  readonly modelo = "determinista-sin-ia"

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta> {
    const ultimo = mensajes.at(-1)
    const caso = ultimoCaso(mensajes)
    if (!opciones.permitirHerramientas) return texto("Alcancé el tope de pasos de este turno. Revisa las llamadas de arriba para ver lo que se alcanzó a hacer.")

    if (ultimo?.rol === "usuario") {
      const anterior = mensajes.slice(0, -1).findLast((m) => m.rol === "asistente")
      const pidioConfirmacion = anterior?.rol === "asistente" && /\?\s*$/.test(anterior.texto)
      if (pidioConfirmacion && caso && esConfirmacion(ultimo.texto)) {
        return herramienta(llamada("proveedor_simular_envio", { caso, confirmado: true }))
      }
      const casoMensaje = ultimo.texto.match(CASO)?.[0]
      if (casoMensaje) return herramienta(llamada("proveedor_leer_solicitud", { caso: casoMensaje }))
      return herramienta(llamada("proveedor_listar_casos", {}))
    }

    const pasos = pasosDelTurno(mensajes)
    const paso = pasos.at(-1)
    if (!paso) return texto("No entendí la solicitud.")
    const fecha = mensajes.findLast((m) => m.rol === "usuario")
    const fechaReferencia = fecha?.rol === "usuario" ? fecha.texto.match(FECHA)?.[0] : undefined

    switch (paso.nombre) {
      case "proveedor_listar_casos": {
        const casos = (paso.data.casos as Array<{ caso: string; cliente?: string; formato?: string }>) ?? []
        return texto(["Estos son los casos disponibles. Dime cuál proceso:", "", ...casos.map((c) => `- \`${c.caso}\` · ${c.cliente ?? ""} · ${c.formato ?? ""}`)].join("\n"))
      }
      case "proveedor_leer_solicitud": {
        if (!paso.ok || !caso) return texto(`No pude leer la solicitud: ${paso.error}`)
        const campos = ((paso.data.campos as Array<{ etiqueta: string }>) ?? []).map((c) => c.etiqueta)
        if (campos.length === 0) return herramienta(llamada("proveedor_armar_paquete", { caso, ...(fechaReferencia ? { fecha_referencia: fechaReferencia } : {}) }))
        return herramienta(llamada("proveedor_mapear_campos", { caso, campos }))
      }
      case "proveedor_mapear_campos":
        if (!paso.ok || !caso) return texto(`No pude mapear los campos: ${paso.error}`)
        return herramienta(llamada("proveedor_generar_formulario", { caso, mapeo: paso.data }))
      case "proveedor_generar_formulario":
        if (!caso) return texto("Falta el caso.")
        return herramienta(llamada("proveedor_armar_paquete", { caso, ...(fechaReferencia ? { fecha_referencia: fechaReferencia } : {}) }))
      case "proveedor_armar_paquete":
        if (!paso.ok || !caso) return texto(`No pude armar el paquete: ${paso.error}`)
        return herramienta(
          llamada("agente_pedir_confirmacion", { accion: "simular el envío del paquete al cliente", caso, pregunta: "¿Quieres que simule el envío del paquete al cliente?" }),
        )
      case "agente_pedir_confirmacion":
        return texto(resumenFinal(pasos, caso ?? "?"))
      case "proveedor_simular_envio":
        return texto(paso.ok ? `Listo. Registré el envío simulado en \`${String(paso.data.ruta)}\`. No se envió ningún correo real.` : `No se hizo el envío: ${paso.error}`)
      default:
        return texto(paso.ok ? "Hecho." : `Error: ${paso.error}`)
    }
  }
}

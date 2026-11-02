import { extname } from "node:path"
import { CAMPOS, type Campo, type Contrato, type Extraccion } from "./extraccion.ts"
import type { FilaMaestro } from "./maestro.ts"
import { reglas } from "./reglas.ts"
import { normalizar, similitud, slug, tokens } from "./texto.ts"

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"
export type Revision = { campo: string; valor_propuesto: unknown; valor_documento: unknown; confianza: number; motivo: string }
export type Diferencia = { campo: string; antes: string; despues: string }

export type Validacion = {
  mensaje_id: string
  clasificacion: Clasificacion
  id_contrato: string | null
  id_contrato_existente: string | null
  requiere_revision: string[]
  revision: Revision[]
  diferencias: Diferencia[]
  motivo: string | null
  advertencias: string[]
  /** Fila que se escribiría en el maestro (nuevo o actualización). */
  fila: FilaMaestro | null
}

export type ContratoEnviado = Partial<Contrato>

/** Columnas que una actualización puede cambiar (no comercial, ruta, fecha de registro ni fuente). */
const ACTUALIZABLES = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza"] as const

function enTexto(valor: unknown): string {
  if (valor === null || valor === undefined) return ""
  if (typeof valor === "boolean") return valor ? "true" : "false"
  return String(valor)
}

function iguales(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b)
  return normalizar(enTexto(a)) === normalizar(enTexto(b))
}

function rechazo(ext: Extraccion, motivo: string): Validacion {
  return {
    mensaje_id: ext.mensaje_id,
    clasificacion: "rechazado",
    id_contrato: null,
    id_contrato_existente: null,
    requiere_revision: [],
    revision: [],
    diferencias: [],
    motivo,
    advertencias: ext.advertencias,
    fila: null,
  }
}

function idAutomatico(maestro: FilaMaestro[], anio: string): string {
  const usados = maestro.filter((f) => f.id_contrato.startsWith(`AUTO-${anio}-`)).length
  return `AUTO-${anio}-${String(usados + 1).padStart(3, "0")}`
}

export function rutaSharepoint(cliente: string, id: string, anio: string, adjunto: string | null, sufijo = ""): string {
  const extension = adjunto ? extname(adjunto) : ".pdf"
  return `Contratos/${anio}/${slug(cliente, reglas.sufijos_societarios)}/${id}${sufijo}${extension}`
}

/**
 * Clasifica el contrato (RN1–RN4) contra el maestro y lista lo que requiere revisión (RN5).
 * Los valores salen del documento; un valor enviado que contradice el documento es un conflicto.
 */
export function validarContrato(ext: Extraccion, enviado: ContratoEnviado | null, maestro: FilaMaestro[], fechaRegistro: string): Validacion {
  if (!ext.adjunto) return rechazo(ext, "El correo no trae adjunto de contrato.")
  if (ext.tipo_documento === "no_contrato") return rechazo(ext, `El adjunto no es un contrato: "${ext.titulo}".`)
  if (ext.tipo_documento === "desconocido") return rechazo(ext, "No se reconoce el adjunto como contrato, otrosí o acta.")
  const esOtrosi = ext.tipo_documento === "otrosi"
  if (!esOtrosi && !ext.contrato.cliente && !ext.contrato.objeto) return rechazo(ext, "El texto no tiene partes ni objeto identificables.")

  const umbral = reglas.umbral_confianza
  const revision: Revision[] = []
  const propuesto: Contrato = { ...ext.contrato }
  const conflicto = new Set<Campo>()
  for (const campo of CAMPOS) {
    const enviadoValor = enviado?.[campo]
    if (enviadoValor === undefined || iguales(enviadoValor, ext.contrato[campo])) continue
    if (ext.contrato[campo] !== null && ext.confianza[campo] >= umbral) {
      conflicto.add(campo)
      revision.push({
        campo,
        valor_propuesto: enviadoValor,
        valor_documento: ext.contrato[campo],
        confianza: ext.confianza[campo],
        motivo: `El valor enviado (${enTexto(enviadoValor)}) no coincide con el documento (${enTexto(ext.contrato[campo])}).`,
      })
    }
    ;(propuesto as Record<Campo, unknown>)[campo] = enviadoValor
  }
  if (enviado?.valor_indeterminado !== undefined) propuesto.valor_indeterminado = enviado.valor_indeterminado

  const porRevisar = (campo: Campo, motivoNulo: string) => {
    if (conflicto.has(campo)) return
    const confianza = ext.confianza[campo]
    if (propuesto[campo] === null) {
      revision.push({ campo, valor_propuesto: null, valor_documento: null, confianza, motivo: ext.notas[campo] ?? motivoNulo })
    } else if (confianza < umbral) {
      revision.push({ campo, valor_propuesto: propuesto[campo], valor_documento: ext.contrato[campo], confianza, motivo: ext.notas[campo] ?? `Confianza ${confianza} < ${umbral}.` })
    }
  }

  const advertencias = [...ext.advertencias]
  const id = propuesto.id_contrato
  let existente = id ? maestro.find((f) => f.id_contrato === id) : undefined
  if (!existente && propuesto.nit_cliente && propuesto.objeto) {
    const t = tokens(propuesto.objeto, [])
    existente = maestro.find((f) => f.nit_cliente === propuesto.nit_cliente && similitud(t, tokens(f.objeto, [])) >= reglas.umbral_similitud_objeto)
  }

  if (existente) {
    const mismasCifras = iguales(propuesto.valor, existente.valor) && iguales(propuesto.fecha_inicio, existente.fecha_inicio) && iguales(propuesto.fecha_fin, existente.fecha_fin)
    if (!esOtrosi && mismasCifras) {
      if (propuesto.objeto && !iguales(propuesto.objeto, existente.objeto)) advertencias.push("El objeto está redactado distinto al del maestro, pero el número, el valor y las fechas coinciden.")
      return { mensaje_id: ext.mensaje_id, clasificacion: "duplicado", id_contrato: existente.id_contrato, id_contrato_existente: existente.id_contrato, requiere_revision: [], revision: [], diferencias: [], motivo: "Mismo número de contrato, valor y fechas que el registro existente (RN1).", advertencias, fila: null }
    }
    const fila: FilaMaestro = { ...existente }
    const diferencias: Diferencia[] = []
    for (const campo of ACTUALIZABLES) {
      const nuevo = propuesto[campo]
      if (nuevo === null || (esOtrosi && ext.contrato[campo] === null && !enviado?.[campo])) continue
      if (campo === "cliente" && normalizar(enTexto(nuevo)) === normalizar(existente.cliente)) continue
      if (iguales(nuevo, existente[campo])) continue
      if (campo === "nit_cliente") {
        revision.push({ campo, valor_propuesto: nuevo, valor_documento: ext.contrato.nit_cliente, confianza: ext.confianza.nit_cliente, motivo: `El identificador del documento (${enTexto(nuevo)}) no coincide con el maestro (${existente.nit_cliente}).` })
        continue
      }
      diferencias.push({ campo, antes: existente[campo], despues: enTexto(nuevo) })
      fila[campo] = enTexto(nuevo)
      porRevisar(campo, "Dato sin fuente en el documento.")
    }
    if (diferencias.length === 0) advertencias.push("El documento no cambia ningún campo del maestro.")
    const requiere = [...new Set(revision.map((r) => r.campo))]
    return {
      mensaje_id: ext.mensaje_id,
      clasificacion: "actualizacion",
      id_contrato: existente.id_contrato,
      id_contrato_existente: existente.id_contrato,
      requiere_revision: requiere,
      revision,
      diferencias,
      motivo: esOtrosi ? "El documento es un otrosí de un contrato existente (RN2)." : "Mismo contrato con campos distintos (RN2).",
      advertencias,
      fila,
    }
  }

  if (esOtrosi) return rechazo(ext, `El otrosí modifica el contrato ${id ?? "(sin número)"}, que no está en el maestro. Hay que registrar primero el contrato original.`)

  for (const campo of reglas.campos_obligatorios_nuevo as Campo[]) {
    if (campo === "id_contrato") continue
    porRevisar(campo, "No se encontró en el documento.")
  }
  if (propuesto.requiere_poliza && ext.confianza.tipo_poliza < umbral) porRevisar("tipo_poliza", "No se identificó el tipo de póliza.")
  const anio = (propuesto.fecha_inicio ?? fechaRegistro).slice(0, 4)
  const idFinal = id ?? idAutomatico(maestro, anio)
  if (!id) advertencias.push(`Sin número de contrato en el documento: se asigna ${idFinal}.`)
  const fila: FilaMaestro = {
    id_contrato: idFinal,
    cliente: propuesto.cliente ?? "",
    nit_cliente: propuesto.nit_cliente ?? "",
    pais: propuesto.pais ?? "",
    objeto: (propuesto.objeto ?? "").slice(0, reglas.max_caracteres_objeto),
    valor: enTexto(propuesto.valor),
    moneda: propuesto.moneda ?? "",
    fecha_inicio: propuesto.fecha_inicio ?? "",
    fecha_fin: propuesto.fecha_fin ?? "",
    requiere_poliza: enTexto(propuesto.requiere_poliza),
    tipo_poliza: propuesto.requiere_poliza ? (propuesto.tipo_poliza ?? "") : "",
    estado_poliza: propuesto.estado_poliza ?? (propuesto.requiere_poliza ? "pendiente" : "no_aplica"),
    comercial: propuesto.comercial ?? "",
    ruta_sharepoint: rutaSharepoint(propuesto.cliente ?? "sin-cliente", idFinal, anio, ext.adjunto),
    fecha_registro: fechaRegistro,
    fuente: "buzon",
  }
  return {
    mensaje_id: ext.mensaje_id,
    clasificacion: "nuevo",
    id_contrato: idFinal,
    id_contrato_existente: null,
    requiere_revision: [...new Set(revision.map((r) => r.campo))],
    revision,
    diferencias: [],
    motivo: "No hay coincidencia en el maestro (RN3).",
    advertencias,
    fila,
  }
}

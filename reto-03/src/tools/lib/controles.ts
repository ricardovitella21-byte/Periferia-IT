import type { CentroCosto, Maestros, Proveedor } from "./maestros.ts"
import type { Paquete } from "./paquete.ts"
import { accionSugerida, reglas } from "./reglas.ts"
import { normalizar, pesos } from "./texto.ts"

export type Hallazgo = { codigo: string; detalle: string; accion_sugerida: string }
export type Derivado = { valor: string; fuente: string; detalle: string }
export type Derivados = { indicador_iva?: Derivado; condiciones_pago?: Derivado }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
  advertencias: string[]
  proveedor: Proveedor | null
  aprobador: { email: string; nombre: string; tope: number } | null
  centro: CentroCosto | null
}

const hallazgo = (codigo: string, detalle: string, accion = accionSugerida(codigo)): Hallazgo => ({ codigo, detalle, accion_sugerida: accion })

/** RC1: por NIT; si no hay NIT, por nombre normalizado. */
function buscarProveedor(p: Paquete, m: Maestros): Proveedor | undefined {
  const nit = p.solicitud.proveedor_nit
  if (nit) return m.proveedores.find((x) => x.nit === nit)
  return m.proveedores.find((x) => normalizar(x.nombre) === normalizar(p.solicitud.proveedor_nombre))
}

/** Aplica RC1–RC10 (PRD 7.3). Función pura: misma entrada, mismo resultado. */
export function validarControles(p: Paquete, m: Maestros): Validacion {
  const s = p.solicitud
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = {}
  const advertencias: string[] = p.faltantes.map((f) => `Falta el adjunto: ${f}.`)
  const moneda = s.moneda

  // RC1 · proveedor existente y activo
  const proveedor = buscarProveedor(p, m) ?? null
  if (!proveedor) {
    const por = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
    bloqueos.push(hallazgo("RC1", `El proveedor ${s.proveedor_nombre} (${por}) no existe en el maestro de proveedores.`, accionSugerida("RC1_inexistente")))
  } else if (!proveedor.activo) {
    bloqueos.push(hallazgo("RC1", `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo en SAP.`, accionSugerida("RC1_inactivo")))
  } else if (!s.proveedor_nit) {
    advertencias.push(`La solicitud no trae NIT; el proveedor se identificó por nombre: ${proveedor.nombre} (NIT ${proveedor.nit}).`)
  }
  if (proveedor && p.cotizacion?.nit && p.cotizacion.nit !== proveedor.nit) {
    advertencias.push(`El NIT de la cotización (${p.cotizacion.nit}) no coincide con el del proveedor (${proveedor.nit}).`)
  }

  // RC4 · centro y subárea
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  if (!centro) bloqueos.push(hallazgo("RC4", `El centro de costo ${s.centro_costo} no existe.`))
  else if (!centro.subareas.includes(s.subarea)) {
    bloqueos.push(hallazgo("RC4", `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo} (${centro.nombre}). Subáreas válidas: ${centro.subareas.join(", ")}.`))
  }

  // RC2 y RC3 · aprobación de un aprobador del centro, dentro de su tope
  let aprobador: Validacion["aprobador"] = null
  const a = p.aprobacion
  if (!a) bloqueos.push(hallazgo("RC2", "No hay correo de aprobación en el paquete."))
  else if (!a.aprobado) bloqueos.push(hallazgo("RC2", `El correo de aprobación de ${a.de} no contiene "Aprobado".`))
  else if (centro) {
    aprobador = centro.aprobadores.find((x) => x.email.toLowerCase() === a.de.toLowerCase()) ?? null
    if (!aprobador) {
      const habilitados = centro.aprobadores.map((x) => `${x.nombre} (tope ${pesos(x.tope, moneda)})`).join(", ")
      const conTope = centro.aprobadores.filter((x) => x.tope >= s.valor_total)
      const escalar = conTope.length
        ? `Puede aprobar: ${conTope.map((x) => `${x.nombre} <${x.email}>`).join(", ")}.`
        : `Ningún aprobador de ${centro.centro_costo} tiene tope para ${pesos(s.valor_total, moneda)}: hay que escalar (RC3).`
      bloqueos.push(
        hallazgo("RC2", `Aprobó ${a.de}, que no es aprobador de ${centro.centro_costo} (${centro.nombre}). Aprobadores del centro: ${habilitados}.`, `${accionSugerida("RC2")} ${escalar}`),
      )
    } else if (s.valor_total > aprobador.tope) {
      bloqueos.push(hallazgo("RC3", `${pesos(s.valor_total, moneda)} supera el tope de ${aprobador.nombre} en ${centro.centro_costo} (${pesos(aprobador.tope, moneda)}).`))
    }
  }

  // RC10 · cantidad × valor unitario = valor total (± 1)
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > reglas.tolerancia_valor_total) {
    bloqueos.push(hallazgo("RC10", `${s.cantidad} × ${pesos(s.valor_unitario, moneda)} = ${pesos(calculado, moneda)}, pero el valor total dice ${pesos(s.valor_total, moneda)}.`))
  }
  if (!reglas.monedas.includes(moneda)) bloqueos.push(hallazgo("MONEDA", `La moneda ${moneda} no está habilitada para OC (${reglas.monedas.join(", ")}).`, "Corregir la moneda de la solicitud."))

  // RC5 · cotización vs solicitud (≤ 2 %)
  const c = p.cotizacion
  if (!c) confirmaciones.push(hallazgo("RC5", "El paquete no trae cotización: la OC se crearía sin cotización de respaldo."))
  else if (c.total === null) confirmaciones.push(hallazgo("RC5", "No se pudo leer el total de la cotización."))
  else {
    const diferencia = s.valor_total === 0 ? 1 : Math.abs(c.total - s.valor_total) / s.valor_total
    if (diferencia > reglas.tolerancia_cotizacion || (c.moneda && c.moneda !== moneda)) {
      const aprobado = a?.monto_aprobado ? ` El aprobador aprobó ${pesos(a.monto_aprobado, moneda)}; la OC se crearía por el valor de la solicitud.` : ""
      confirmaciones.push(
        hallazgo("RC5", `Solicitud ${pesos(s.valor_total, moneda)} vs cotización ${c.referencia ?? ""} ${pesos(c.total, c.moneda || moneda)}: diferencia de ${(diferencia * 100).toFixed(1).replace(".", ",")} % (máximo ${reglas.tolerancia_cotizacion * 100} %).${aprobado}`),
      )
    }
    if (c.validez_hasta && c.validez_hasta < s.fecha_solicitud) advertencias.push(`La cotización ${c.referencia ?? ""} venció el ${c.validez_hasta}, antes de la solicitud.`)
  }

  // RC6 · indicador de IVA (derivado + confirmación)
  if (!s.indicador_iva) {
    if (proveedor) {
      const iva = m.iva.find((x) => x.codigo === proveedor.indicador_iva_default)
      derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default", detalle: iva ? `${iva.codigo} · ${iva.descripcion}` : proveedor.indicador_iva_default }
      confirmaciones.push(hallazgo("RC6", `La solicitud no informa indicador de IVA; se deriva del proveedor: ${derivados.indicador_iva.detalle}.`))
    }
  } else if (!m.iva.some((x) => x.codigo === s.indicador_iva)) {
    bloqueos.push(hallazgo("RC6", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, "Corregir el indicador de IVA de la solicitud."))
  }

  // RC7 · condiciones de pago (derivado, solo se informa)
  if (!s.condiciones_pago) {
    if (proveedor) {
      const cond = m.condiciones.find((x) => x.codigo === proveedor.condiciones_pago_default)
      derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default", detalle: cond ? `${cond.codigo} · ${cond.descripcion}` : proveedor.condiciones_pago_default }
    }
  } else if (!m.condiciones.some((x) => x.codigo === s.condiciones_pago)) {
    bloqueos.push(hallazgo("RC7", `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`, "Corregir la condición de pago de la solicitud."))
  }

  // RC8 · factura anterior a la solicitud → retroactiva
  const retroactiva = Boolean(p.factura && p.factura.fecha < s.fecha_solicitud)
  if (retroactiva && p.factura) {
    confirmaciones.push(hallazgo("RC8", `La factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud}): OC retroactiva.`))
  }

  // RC9 · aprobación no anterior a la solicitud
  if (a && a.fecha < s.fecha_solicitud) confirmaciones.push(hallazgo("RC9", `La aprobación (${a.fecha}) es anterior a la solicitud (${s.fecha_solicitud}).`))

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, advertencias, proveedor, aprobador, centro }
}

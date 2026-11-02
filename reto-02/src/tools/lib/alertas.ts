import { diasEntre, sumarDias } from "./fechas.ts"
import type { EntradaHistorial, FilaMaestro } from "./maestro.ts"
import { reglas } from "./reglas.ts"
import { celdaMd } from "./texto.ts"

export type ContratoAlerta = { id_contrato: string; cliente: string; fecha_fin: string; dias: number; comercial: string }
export type PolizaPendiente = { id_contrato: string; cliente: string; tipo_poliza: string; estado_poliza: string; comercial: string }
export type Registrado = { id_contrato: string; cliente: string; fecha_registro: string; fuente: string }
export type Actualizado = { id_contrato: string; fecha: string; cambios: string[] }

export type Alertas = {
  hoy: string
  vencen: ContratoAlerta[]
  vencidos: ContratoAlerta[]
  polizas_pendientes: PolizaPendiente[]
  registrados_desde_corte: Registrado[]
  actualizados_desde_corte: Actualizado[]
}

export function calcularAlertas(filas: FilaMaestro[], historial: EntradaHistorial[], hoy: string): Alertas {
  const limite = sumarDias(hoy, reglas.dias_alerta_vencimiento)
  const corte = reglas.fecha_corte_maestro
  const conDias = (f: FilaMaestro): ContratoAlerta => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_fin: f.fecha_fin, dias: diasEntre(hoy, f.fecha_fin), comercial: f.comercial })
  const porFecha = (a: ContratoAlerta, b: ContratoAlerta) => a.fecha_fin.localeCompare(b.fecha_fin)
  return {
    hoy,
    vencen: filas.filter((f) => f.fecha_fin && f.fecha_fin >= hoy && f.fecha_fin <= limite).map(conDias).sort(porFecha),
    vencidos: filas.filter((f) => f.fecha_fin && f.fecha_fin < hoy).map(conDias).sort(porFecha),
    polizas_pendientes: filas
      .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
      .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, comercial: f.comercial })),
    registrados_desde_corte: filas
      .filter((f) => f.fecha_registro >= corte)
      .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, fuente: f.fuente })),
    actualizados_desde_corte: historial
      .filter((h) => h.accion === "actualizacion" && h.ts.slice(0, 10) >= corte && h.id_contrato)
      .map((h) => ({ id_contrato: h.id_contrato ?? "", fecha: h.ts.slice(0, 10), cambios: Object.keys(h.cambios) })),
  }
}

export function alertasMd(a: Alertas): string {
  const tabla = (encabezado: string[], filas: string[][]) =>
    filas.length
      ? [`| ${encabezado.join(" | ")} |`, `|${encabezado.map(() => "---").join("|")}|`, ...filas.map((f) => `| ${f.map(celdaMd).join(" | ")} |`)]
      : ["_Ninguno._"]
  return [
    "# Alertas de contratos",
    "",
    `Fecha de referencia: **${a.hoy}** · corte del maestro: ${reglas.fecha_corte_maestro}`,
    "",
    `## 1. Vencen en ${reglas.dias_alerta_vencimiento} días o menos (${a.vencen.length})`,
    "",
    ...tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Comercial"], a.vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias), c.comercial])),
    "",
    `## 2. Pólizas pendientes: requieren póliza y no está vigente (${a.polizas_pendientes.length})`,
    "",
    ...tabla(["Contrato", "Cliente", "Tipo de póliza", "Estado", "Comercial"], a.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza, p.estado_poliza, p.comercial])),
    "",
    `## 3. Registrados desde el corte del ${reglas.fecha_corte_maestro}: gap cubierto (${a.registrados_desde_corte.length})`,
    "",
    ...tabla(["Contrato", "Cliente", "Fecha de registro", "Fuente"], a.registrados_desde_corte.map((r) => [r.id_contrato, r.cliente, r.fecha_registro, r.fuente])),
    ...(a.actualizados_desde_corte.length
      ? ["", "Actualizados desde el corte:", "", ...tabla(["Contrato", "Fecha", "Campos"], a.actualizados_desde_corte.map((u) => [u.id_contrato, u.fecha, u.cambios.join(", ")]))]
      : []),
    "",
    `## Informativo: ya vencidos (${a.vencidos.length})`,
    "",
    "Revisar si se liquidaron, se prorrogaron o falta un otrosí.",
    "",
    ...tabla(["Contrato", "Cliente", "Fecha fin", "Días"], a.vencidos.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias)])),
    "",
  ].join("\n")
}

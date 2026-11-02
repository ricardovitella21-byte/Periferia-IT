import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { SapAdapter } from "../src/sap/adapter.ts"
import { SapMock } from "../src/sap/mock.ts"
import * as oc from "../src/tools/oc.ts"
import { validarControles } from "../src/tools/lib/controles.ts"
import { contenidoEvidencia, sha256 } from "../src/tools/lib/evidencia.ts"
import { cargarMaestros, type Maestros } from "../src/tools/lib/maestros.ts"
import { leerPaquete, type Paquete } from "../src/tools/lib/paquete.ts"
import type { OrdenCompra } from "../src/tools/lib/payload.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"
import { proyectoTemporal, salida } from "./apoyo.ts"

let ctx: ContextoHerramienta
let limpiar: () => Promise<void>
let maestros: Maestros
beforeAll(async () => {
  process.env.FECHA_REFERENCIA = "2026-09-03"
  ;({ ctx, limpiar } = await proyectoTemporal())
  maestros = await cargarMaestros(ctx)
})
afterAll(() => limpiar())

const codigos = (h: Array<{ codigo: string }>) => h.map((x) => x.codigo)
async function construir(caso: string): Promise<OrdenCompra> {
  const paquete = salida(await oc.leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok) throw new Error(paquete.error)
  const r = salida(await oc.construir_payload.execute({ caso, paquete: paquete.data as never }, ctx))
  if (!r.ok) throw new Error(r.error)
  return r.data.orden as OrdenCompra
}
const control = async () => (await readFile(join(ctx.directory, "out/control.csv"), "utf8")).trim().split("\n").slice(1)

describe("HU-1 · paquete normalizado", () => {
  test("cotización, aprobación y factura se normalizan", async () => {
    const p = await leerPaquete(ctx, "sol-005")
    expect(p.cotizacion).toMatchObject({ referencia: "PC-5520", nit: "800444555", total: 3200000, moneda: "COP", validez_hasta: "2026-09-04" })
    expect(p.aprobacion).toMatchObject({ de: "rtorres@periferia-ficticia.com", fecha: "2026-08-28", aprobado: true })
    expect(p.factura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3200000 })
    expect(p.faltantes).toEqual([])
  })

  test("monto aprobado en el texto: 'por 25 millones'", async () => {
    expect((await leerPaquete(ctx, "sol-004")).aprobacion?.monto_aprobado).toBe(25_000_000)
  })
})

describe("HU-2 · controles RC1–RC10 sobre los 6 casos", () => {
  const esperado: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean }> = {
    "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
    "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
    "sol-003": { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false },
    "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
    "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
    "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
  }
  for (const [caso, e] of Object.entries(esperado)) {
    test(caso, async () => {
      const v = validarControles(await leerPaquete(ctx, caso), maestros)
      expect({ apta: v.apta, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones), retroactiva: v.retroactiva }).toEqual(e)
    })
  }

  test("sol-006: IVA y condiciones de pago derivados del proveedor", async () => {
    const v = validarControles(await leerPaquete(ctx, "sol-006"), maestros)
    expect(v.derivados.indicador_iva?.valor).toBe("C1")
    expect(v.derivados.condiciones_pago?.valor).toBe("Z030")
  })

  test("bloqueos traen razón y acción sugerida", async () => {
    const v = validarControles(await leerPaquete(ctx, "sol-003"), maestros)
    expect(v.bloqueos[0]?.detalle).toContain("no es aprobador de CC-2020")
    expect(v.bloqueos[0]?.accion_sugerida).toContain("escalar")
  })

  test("RC1 inactivo, RC3 tope, RC4 subárea, RC9 fecha y RC10 aritmética", async () => {
    const base = await leerPaquete(ctx, "sol-001")
    const con = (cambios: Partial<Paquete["solicitud"]>, extra: Partial<Paquete> = {}): Paquete => ({ ...base, ...extra, solicitud: { ...base.solicitud, ...cambios } })
    const bloq = (p: Paquete) => codigos(validarControles(p, maestros).bloqueos)
    expect(bloq(con({ proveedor_nit: "901777888" }))).toContain("RC1")
    expect(bloq(con({ cantidad: 1000, valor_unitario: 95000, valor_total: 95_000_000 }))).toContain("RC3")
    expect(bloq(con({ subarea: "Marketing" }))).toContain("RC4")
    expect(bloq(con({ valor_total: 11_500_000 }))).toContain("RC10")
    const anterior = validarControles(con({ fecha_solicitud: "2026-08-25" }), maestros)
    expect(codigos(anterior.confirmaciones)).toContain("RC9")
    expect(codigos(validarControles(con({}, { cotizacion: null }), maestros).confirmaciones)).toContain("RC5")
  })
})

describe("HU-3 · payload y trazabilidad", () => {
  test("payload válido, descripción ≤ 40 y unidad H para horas", async () => {
    const orden = await construir("sol-004")
    expect(orden.posiciones[0]).toMatchObject({ numero: 10, unidad: "H", cantidad: 100, precio_unitario: 250000, indicador_iva: "C1" })
    expect(orden.posiciones[0]?.descripcion.length).toBeLessThanOrEqual(40)
    expect(orden).toMatchObject({ sociedad: "1000", organizacion_compras: "1000", proveedor: { codigo_sap: "100310" }, condiciones_pago: "Z000" })
  })

  test("todo valor tiene fuente: solicitud, cotizacion, maestro.<nombre>, derivado, correo o aprobacion", async () => {
    await construir("sol-006")
    const t = JSON.parse(await readFile(join(ctx.directory, "out/sol-006/trazabilidad.json"), "utf8")) as { campos: Record<string, { fuente: string }> }
    for (const { fuente } of Object.values(t.campos)) expect(fuente).toMatch(/^(solicitud|cotizacion|correo|aprobacion|derivado|maestro\.[a-z-]+)$/)
    expect(t.campos["posiciones[0].indicador_iva"]?.fuente).toBe("derivado")
  })

  test("con bloqueos no se construye", async () => {
    const r = salida(await oc.construir_payload.execute({ caso: "sol-002", paquete: { solicitud: { solicitud_id: "SOL-2026-002" } } }, ctx))
    expect(!r.ok && r.error).toContain("bloqueos: RC1")
  })
})

describe("HU-4 · evidencia de aprobación", () => {
  test("txt con encabezados y sha256, y pdf", async () => {
    const r = salida(await oc.generar_evidencia.execute({ caso: "sol-001" }, ctx))
    if (!r.ok) throw new Error(r.error)
    const txt = await readFile(join(ctx.directory, "out/sol-001/aprobacion.txt"), "utf8")
    for (const encabezado of ["De: ", "Para: ", "Fecha: ", "Asunto: "]) expect(txt).toContain(encabezado)
    const p = await leerPaquete(ctx, "sol-001")
    expect(r.data.sha256).toBe(sha256(contenidoEvidencia(p.aprobacion ?? (null as never))))
    expect(txt).toContain(String(r.data.sha256))
    expect((await readFile(join(ctx.directory, "out/sol-001/aprobacion.pdf"))).subarray(0, 4).toString()).toBe("%PDF")
  })
})

describe("HU-5 · crear en SAP simulado", () => {
  test("sol-001 crea 4500000001 y repetirla es idempotente", async () => {
    const orden = await construir("sol-001")
    const r1 = salida(await oc.crear.execute({ caso: "sol-001", payload: orden }, ctx))
    expect(r1.ok && r1.data).toMatchObject({ numero_oc: "4500000001", idempotente: false })
    const r2 = salida(await oc.crear.execute({ caso: "sol-001", payload: orden }, ctx))
    expect(r2.ok && r2.data).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    const lineas = (await readFile(join(ctx.directory, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n")
    expect(lineas).toHaveLength(1)
  })

  test("bloqueada: no crea y deja fila en control", async () => {
    const r = salida(await oc.crear.execute({ caso: "sol-002" }, ctx))
    expect(r.ok).toBe(false)
    expect((await control()).some((f) => f.startsWith("SOL-2026-002,bloqueada,,false,RC1,"))).toBe(true)
  })

  test("con confirmaciones exige confirmado=true", async () => {
    const orden = await construir("sol-004")
    const sin = salida(await oc.crear.execute({ caso: "sol-004", payload: orden }, ctx))
    expect(!sin.ok && sin.error).toStartWith("requiere confirmación: RC5")
    const con = salida(await oc.crear.execute({ caso: "sol-004", payload: orden, confirmado: true }, ctx))
    expect(con.ok && con.data.numero_oc).toBe("4500000002")
    const registro = JSON.parse((await readFile(join(ctx.directory, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n").at(-1) ?? "{}") as { orden: OrdenCompra }
    expect(registro.orden.excepciones.find((e) => e.codigo === "RC5")?.confirmado_por).toContain("analista")
    // El resultado le dice al modelo quién confirmó, igual que lo guardado en SAP.
    const devueltas = con.ok ? (con.data.excepciones as OrdenCompra["excepciones"]) : []
    expect(devueltas.find((e) => e.codigo === "RC5")?.confirmado_por).toContain("analista")
  })

  test("retroactiva queda marcada en control.csv", async () => {
    const orden = await construir("sol-005")
    await oc.crear.execute({ caso: "sol-005", payload: orden, confirmado: true }, ctx)
    expect((await control()).some((f) => f.startsWith("SOL-2026-005,creada,4500000003,true,,RC8,"))).toBe(true)
  })

  test("CA2: un payload alterado no se crea", async () => {
    const orden = await construir("sol-006")
    const alterado: OrdenCompra = { ...orden, posiciones: orden.posiciones.map((p) => ({ ...p, precio_unitario: 1 })) }
    const r = salida(await oc.crear.execute({ caso: "sol-006", payload: alterado, confirmado: true }, ctx))
    expect(!r.ok && r.error).toContain("no coincide")
  })

  test("SapMock implementa SapAdapter", async () => {
    const sap: SapAdapter = new SapMock(ctx)
    expect(await sap.consultarProveedor("900555111")).toEqual({ codigo_sap: "100234", activo: true })
    expect(await sap.consultarProveedor("000")).toBeNull()
    expect(await sap.buscarOrdenPorReferencia("SOL-2026-001")).toEqual({ numero_oc: "4500000001" })
  })
})

describe("HU-6 · errores legibles", () => {
  const solicitud = () => join(ctx.directory, "fixtures/reto-03/solicitudes/sol-003/solicitud.json")
  test("monto no numérico, JSON malformado y caso inexistente", async () => {
    const original = await readFile(solicitud(), "utf8")
    await writeFile(solicitud(), original.replace('"valor_total": 74000000', '"valor_total": "74 millones"'), "utf8")
    expect(salida(await oc.leer_paquete.execute({ caso: "sol-003" }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("valor_total debe ser un número") })
    await writeFile(solicitud(), "{ roto", "utf8")
    expect(salida(await oc.leer_paquete.execute({ caso: "sol-003" }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("dañado") })
    await writeFile(solicitud(), original, "utf8")
    expect(salida(await oc.leer_paquete.execute({ caso: "sol-999" }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("no existe") })
  })

  test("paquete incompleto: los adjuntos faltantes quedan null", async () => {
    await rm(join(ctx.directory, "fixtures/reto-03/solicitudes/sol-003/cotizacion.txt"))
    const r = salida(await oc.leer_paquete.execute({ caso: "sol-003" }, ctx))
    expect(r.ok && r.data).toMatchObject({ cotizacion: null, faltantes: ["cotizacion"] })
  })
})

describe("P1 · leer Excel real", () => {
  test("devuelve filas con los encabezados de la primera fila", async () => {
    const libro = new ExcelJS.Workbook()
    const hoja = libro.addWorksheet("Solicitud")
    hoja.addRow(["solicitud_id", "cantidad", "valor_unitario"])
    hoja.addRow(["SOL-2026-099", 3, 1000])
    await mkdir(join(ctx.directory, "out"), { recursive: true })
    await libro.xlsx.writeFile(join(ctx.directory, "out/solicitud.xlsx"))
    const r = salida(await oc.leer_excel.execute({ ruta: "out/solicitud.xlsx" }, ctx))
    expect(r.ok && r.data.filas).toEqual([{ solicitud_id: "SOL-2026-099", cantidad: 3, valor_unitario: 1000 }])
    expect(salida(await oc.leer_excel.execute({ ruta: "../fuera.xlsx" }, ctx)).ok).toBe(false)
  })
})

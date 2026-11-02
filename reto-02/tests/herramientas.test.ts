import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import * as contratos from "../src/tools/contratos.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"
import { proyectoTemporal, salida } from "./apoyo.ts"

let ctx: ContextoHerramienta
let limpiar: () => Promise<void>
let fixtureOriginal: string
const HOY = "2026-09-03"

type Contrato = Parameters<typeof contratos.registrar.execute>[0]["contrato"]
type Ext = { tipo_documento: string; contrato: Contrato & Record<string, unknown>; confianza: Record<string, number> }

beforeAll(async () => {
  process.env.FECHA_REFERENCIA = HOY
  ;({ ctx, limpiar } = await proyectoTemporal())
  fixtureOriginal = await readFile(join(ctx.directory, "fixtures/reto-02/maestro-contratos.csv"), "utf8")
})
afterAll(() => limpiar())

async function extraer(id: string): Promise<Ext> {
  const r = salida(await contratos.extraer.execute({ mensaje_id: id }, ctx))
  if (!r.ok) throw new Error(r.error)
  return r.data as unknown as Ext
}
async function validar(id: string, contrato?: Contrato) {
  const r = salida(await contratos.validar.execute({ mensaje_id: id, contrato: contrato ?? (await extraer(id)).contrato }, ctx))
  if (!r.ok) throw new Error(r.error)
  return r.data as { clasificacion: string; requiere_revision: string[]; diferencias: Array<{ campo: string; antes: string; despues: string }>; id_contrato_existente: string | null }
}
const registrar = async (id: string, contrato?: Contrato, confirmado?: boolean) =>
  salida(await contratos.registrar.execute({ mensaje_id: id, contrato: contrato ?? (await extraer(id)).contrato, ...(confirmado ? { confirmado } : {}) }, ctx))
const maestro = async () => (await readFile(join(ctx.directory, "out/sharepoint/maestro-contratos.csv"), "utf8")).trim().split("\n")

describe("HU-1 · leer el buzón", () => {
  test("lista los 6 mensajes y marca la cotización como rechazada", async () => {
    const r = salida(await contratos.leer_buzon.execute({}, ctx))
    const mensajes = (r.ok ? r.data.mensajes : []) as Array<{ id: string; tiene_contrato: boolean; clasificacion?: string; motivo?: string }>
    expect(mensajes.map((m) => m.id)).toEqual(["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"])
    const cotizacion = mensajes.find((m) => m.id === "msg-005")
    expect(cotizacion).toMatchObject({ tiene_contrato: false, clasificacion: "rechazado" })
    expect(cotizacion?.motivo).toContain("COTIZACIÓN")
  })
})

describe("HU-2 · extracción con confianza", () => {
  test("contrato completo: valores del documento con confianza alta", async () => {
    const e = await extraer("msg-001")
    expect(e.contrato).toMatchObject({
      id_contrato: "CT-2026-015",
      cliente: "Industrias Delta S.A.S.",
      nit_cliente: "890900111",
      pais: "CO",
      valor: 265000000,
      moneda: "COP",
      fecha_inicio: "2026-08-01",
      fecha_fin: "2027-07-31",
      requiere_poliza: true,
      tipo_poliza: "cumplimiento",
      estado_poliza: "pendiente",
      comercial: "Laura Gómez Restrepo",
    })
    expect(Math.min(...Object.values(e.confianza))).toBeGreaterThanOrEqual(0.8)
  })

  test("formatos de monto y país desde RUC y domicilio", async () => {
    const e = await extraer("msg-002")
    expect(e.contrato).toMatchObject({ valor: 120000, moneda: "USD", pais: "EC", nit_cliente: "1790012345001", requiere_poliza: false, estado_poliza: "no_aplica" })
  })

  test("contrato marco: valor 0 indeterminado y fechas derivadas con confianza baja", async () => {
    const e = await extraer("msg-006")
    expect(e.contrato).toMatchObject({ id_contrato: "CM-2026-03", valor: 0, valor_indeterminado: true, fecha_inicio: "2026-08-31", fecha_fin: "2027-08-30" })
    expect(e.confianza.valor).toBeLessThan(0.8)
    expect(e.confianza.fecha_fin).toBeLessThan(0.8)
  })

  test("lo ausente es null con confianza 0, nunca inventado", async () => {
    const e = await extraer("msg-003")
    expect(e.tipo_documento).toBe("otrosi")
    expect(e.contrato.objeto).toBeNull()
    expect(e.confianza.objeto).toBe(0)
    expect(e.contrato.fecha_inicio).toBeNull()
  })
})

describe("HU-3 · validar y clasificar", () => {
  test("los 6 mensajes del buzón quedan con la clasificación esperada", async () => {
    const esperado: Record<string, string> = { "msg-001": "nuevo", "msg-002": "nuevo", "msg-003": "actualizacion", "msg-004": "duplicado", "msg-005": "rechazado", "msg-006": "nuevo" }
    for (const [id, clasificacion] of Object.entries(esperado)) expect((await validar(id)).clasificacion).toBe(clasificacion)
  })

  test("msg-006 requiere revisión de valor y fecha fin", async () => {
    expect((await validar("msg-006")).requiere_revision).toEqual(expect.arrayContaining(["valor", "fecha_fin"]))
  })

  test("un valor alterado respecto al documento se vuelve conflicto en revisión", async () => {
    const e = await extraer("msg-001")
    const v = await validar("msg-001", { ...e.contrato, valor: 300000000 })
    expect(v.requiere_revision).toContain("valor")
  })
})

describe("HU-4 · registrar y archivar", () => {
  test("RN6: la primera ejecución copia el maestro y el fixture no se toca", async () => {
    expect((await registrar("msg-001")).ok).toBe(true)
    expect(await readFile(join(ctx.directory, "fixtures/reto-02/maestro-contratos.csv"), "utf8")).toBe(fixtureOriginal)
    const filas = await maestro()
    expect(filas.at(-1)).toContain("CT-2026-015,Industrias Delta S.A.S.,890900111,CO")
    expect((await stat(join(ctx.directory, "out/sharepoint/Contratos/2026/industrias-delta/CT-2026-015.txt"))).isFile()).toBe(true)
  })

  test("duplicado: no escribe ni agrega filas", async () => {
    const antes = await maestro()
    const r = await registrar("msg-004")
    expect(r.ok && r.data.accion).toBe("duplicado")
    expect(await maestro()).toEqual(antes)
  })

  test("otrosí: actualiza la fila y deja historial con antes y después", async () => {
    const r = await registrar("msg-003")
    expect(r.ok && r.data.accion).toBe("actualizado")
    const fila = (await maestro()).find((f) => f.startsWith("CT-2026-011,"))
    expect(fila).toContain(",520000,PEN,2026-05-02,2027-11-01,")
    const historial = (await readFile(join(ctx.directory, "out/sharepoint/historial.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const linea = historial.find((h) => h.mensaje_id === "msg-003")
    expect(linea).toMatchObject({ id_contrato: "CT-2026-011", accion: "actualizacion", cambios: { valor: { antes: "350000", despues: "520000" } } })
    expect(Object.keys(linea ?? {}).sort()).toEqual(["accion", "cambios", "id_contrato", "mensaje_id", "ts"])
  })

  test("RN5: con campos en revisión no registra sin confirmación", async () => {
    const r = await registrar("msg-006")
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toStartWith("requiere revisión: ")
    expect((await maestro()).some((f) => f.startsWith("CM-2026-03,"))).toBe(false)
  })

  test("con confirmado=true registra los valores confirmados por la analista", async () => {
    const e = await extraer("msg-006")
    const r = await registrar("msg-006", { ...e.contrato, valor: 0, fecha_fin: "2027-08-31" }, true)
    expect(r.ok && r.data.accion).toBe("insertado")
    expect((await maestro()).find((f) => f.startsWith("CM-2026-03,"))).toContain(",0,COP,2026-08-31,2027-08-31,")
  })

  test("O2: un mensaje ya procesado no se registra dos veces", async () => {
    const r = await registrar("msg-001")
    expect(!r.ok && r.error).toContain("ya fue procesado")
    const ids = (await maestro()).slice(1).map((f) => f.split(",")[0])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("el buzón ya no lista los procesados", async () => {
    await registrar("msg-002")
    await registrar("msg-005")
    const r = salida(await contratos.leer_buzon.execute({}, ctx))
    expect(r.ok && r.data.pendientes).toBe(0)
    const procesados = JSON.parse(await readFile(join(ctx.directory, "out/procesados.json"), "utf8")) as Record<string, { clasificacion: string }>
    expect(Object.keys(procesados).sort()).toEqual(["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"])
  })
})

describe("HU-5 · alertas", () => {
  test("tres secciones con la fecha de referencia dada", async () => {
    const r = salida(await contratos.alertas.execute({ hoy: HOY }, ctx))
    if (!r.ok) throw new Error(r.error)
    const ids = (k: string) => (r.data[k] as Array<{ id_contrato: string }>).map((x) => x.id_contrato)
    expect(ids("vencen")).toEqual(["CT-2026-009", "CT-2026-004"])
    expect(ids("polizas_pendientes")).toEqual(expect.arrayContaining(["CT-2026-004", "CT-2026-011", "CT-2026-015", "CM-2026-03"]))
    expect(ids("registrados_desde_corte").sort()).toEqual(["CM-2026-03", "CT-2026-015", "CT-2026-016"])
    const md = await readFile(join(ctx.directory, "out/alertas.md"), "utf8")
    expect(md).toContain("## 1. Vencen en 60 días o menos")
    expect(md).toContain("## 2. Pólizas pendientes")
    expect(md).toContain("## 3. Registrados desde el corte")
  })

  test("RN7: cada herramienta deja { ts, herramienta, mensaje_id, ok, resumen } en out/log.jsonl", async () => {
    const linea = JSON.parse((await readFile(join(ctx.directory, "out/log.jsonl"), "utf8")).split("\n")[0] ?? "{}") as Record<string, unknown>
    for (const clave of ["ts", "herramienta", "mensaje_id", "ok", "resumen"]) expect(linea).toHaveProperty(clave)
  })
})

describe("HU-6 · errores legibles, sin lanzar", () => {
  test("moneda desconocida, fecha inválida y mensaje inexistente", async () => {
    expect(salida(await contratos.validar.execute({ mensaje_id: "msg-002", contrato: { moneda: "EUR" } }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("Moneda desconocida") })
    expect(salida(await contratos.alertas.execute({ hoy: "2026-13-01" }, ctx))).toMatchObject({ ok: false })
    expect(salida(await contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("no existe") })
  })

  test("texto vacío", async () => {
    await writeFile(join(ctx.directory, "fixtures/reto-02/buzon/msg-004/contrato.txt"), "  \n", "utf8")
    expect(salida(await contratos.extraer.execute({ mensaje_id: "msg-004" }, ctx))).toMatchObject({ ok: false, error: expect.stringContaining("vacío") })
  })
})

describe("P1 · leer PDF con texto nativo", () => {
  test("extrae el texto de un PDF y rechaza rutas fuera de fixtures/ u out/", async () => {
    const doc = await PDFDocument.create()
    doc.addPage().drawText("CONTRATO DE PRESTACION DE SERVICIOS No. CT-2026-099", { x: 50, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) })
    await mkdir(join(ctx.directory, "out"), { recursive: true })
    await writeFile(join(ctx.directory, "out/prueba.pdf"), await doc.save())
    const r = salida(await contratos.leer_pdf.execute({ ruta: "out/prueba.pdf" }, ctx))
    expect(r.ok && String(r.data.texto)).toContain("CT-2026-099")
    expect(salida(await contratos.leer_pdf.execute({ ruta: "../../secreto.pdf" }, ctx)).ok).toBe(false)
  })
})

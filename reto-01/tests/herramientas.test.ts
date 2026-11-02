import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import * as proveedor from "../src/tools/proveedor.ts"
import { mapearCampos } from "../src/tools/lib/mapeo.ts"
import { bloqueosDeFirma, type EstadoSoporte } from "../src/tools/lib/paquete.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"
import { proyectoTemporal, salida } from "./apoyo.ts"

let ctx: ContextoHerramienta
let limpiar: () => Promise<void>
const FECHA = "2026-09-03"

beforeAll(async () => ({ ctx, limpiar } = await proyectoTemporal()))
afterAll(() => limpiar())

async function procesar(caso: string) {
  const sol = salida(await proveedor.leer_solicitud.execute({ caso }, ctx))
  if (!sol.ok) throw new Error(sol.error)
  const campos = (sol.data.campos as Array<{ etiqueta: string }>).map((c) => c.etiqueta)
  const mapeo = salida(await proveedor.mapear_campos.execute({ caso, campos }, ctx))
  if (!mapeo.ok) throw new Error(mapeo.error)
  return { sol: sol.data, mapeo: mapeo.data as { llenos: Array<{ etiqueta: string; ruta: string; valor: unknown }>; faltantes: Array<{ etiqueta: string }>; requiere_confirmacion: Array<{ etiqueta: string; ruta: string; motivo: string }> } }
}

describe("HU-1 · leer la solicitud", () => {
  test("devuelve país, formato, campos y soportes", async () => {
    const { sol } = await procesar("co-industrias-delta")
    expect(sol.pais).toBe("CO")
    expect(sol.formato).toBe("xlsx")
    expect((sol.campos as unknown[]).length).toBe(17)
    expect((sol.soportes as unknown[]).length).toBe(4)
  })

  test("propone el identificador del país para campos extranjeros", async () => {
    const { sol } = await procesar("hn-agroexport-sula")
    expect(sol.requiere_confirmacion).toEqual([expect.objectContaining({ etiqueta: "RTN", propuesta: "RTN" })])
  })
})

describe("HU-2 · mapear campos al maestro", () => {
  test("Colombia: todo lleno con ruta del maestro, incluidos los datos bancarios pedidos", async () => {
    const { mapeo } = await procesar("co-industrias-delta")
    expect(mapeo.faltantes).toHaveLength(0)
    expect(mapeo.requiere_confirmacion).toHaveLength(0)
    expect(mapeo.llenos.find((c) => c.etiqueta === "Número de cuenta")).toMatchObject({ ruta: "banco.numero_cuenta", valor: "03100012345" })
  })

  test("RN1: RUC de Ecuador se llena con el NIT y queda por confirmar", async () => {
    const { mapeo } = await procesar("ec-corp-andina")
    const ruc = mapeo.requiere_confirmacion.find((c) => c.etiqueta === "RUC")
    expect(ruc?.ruta).toBe("nit")
    expect(ruc?.motivo).toContain("identificador extranjero")
  })

  test("un campo sin fuente queda faltante y nunca recibe valor", async () => {
    const { mapeo } = await procesar("ec-corp-andina")
    expect(mapeo.faltantes.map((c) => c.etiqueta)).toEqual(["Número de contribuyente especial"])
    expect(mapeo.faltantes[0]).not.toHaveProperty("valor")
    const hn = await procesar("hn-agroexport-sula")
    expect(hn.mapeo.faltantes.map((c) => c.etiqueta)).toEqual(["Referencias comerciales"])
  })

  test("etiqueta genérica en Colombia se reporta como ambigua", () => {
    const maestro = { nit: "900123456" }
    const r = mapearCampos(["Identificación tributaria"], "CO", maestro, { "Identificación tributaria": "nit" })
    expect(r.requiere_confirmacion[0]?.motivo).toContain("ambigua")
  })

  test("un parecido a un dato bancario no se llena (RN2)", () => {
    const maestro = { banco: { numero_cuenta: "123" } }
    const r = mapearCampos(["Cuenta número para pagos"], "CO", maestro, { "Número de cuenta": "banco.numero_cuenta" })
    expect(r.llenos).toHaveLength(0)
    expect(r.requiere_confirmacion).toHaveLength(0)
  })
})

describe("HU-3 · generar el formulario", () => {
  test("Excel: etiqueta y valor en la hoja y celda exactas", async () => {
    const { mapeo } = await procesar("co-industrias-delta")
    const r = salida(await proveedor.generar_formulario.execute({ caso: "co-industrias-delta", mapeo }, ctx))
    expect(r.ok).toBe(true)
    const libro = new ExcelJS.Workbook()
    await libro.xlsx.readFile(join(ctx.directory, "out/co-industrias-delta/formulario.xlsx"))
    const banco = libro.getWorksheet("Datos Bancarios")
    expect(banco?.getCell("B5").value).toBe("Número de cuenta")
    expect(banco?.getCell("C5").value).toBe("03100012345")
    expect(libro.getWorksheet("Datos Proveedor")?.getCell("C4").value).toBe("900123456")
  })

  test("PDF: se genera el archivo", async () => {
    const { mapeo } = await procesar("ec-corp-andina")
    const r = salida(await proveedor.generar_formulario.execute({ caso: "ec-corp-andina", mapeo }, ctx))
    expect(r.ok && r.data.ruta).toBe("out/ec-corp-andina/formulario.pdf")
    const pdf = await readFile(join(ctx.directory, "out/ec-corp-andina/formulario.pdf"))
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF")
  })

  test("portal: formato no soportado y valores listos para copiar", async () => {
    const { mapeo } = await procesar("pa-logistica-istmo")
    const r = salida(await proveedor.generar_formulario.execute({ caso: "pa-logistica-istmo", mapeo }, ctx))
    expect(r.ok && r.data.soportado).toBe(false)
    expect(r.ok && String(r.data.aviso)).toContain("no soportado")
    const md = await readFile(join(ctx.directory, "out/pa-logistica-istmo/valores-portal.md"), "utf8")
    expect(md).toContain("Periferia IT Group S.A.S.")
  })

  test("un mapeo alterado por el modelo no cambia los valores", async () => {
    const mapeo = { llenos: [{ etiqueta: "Número de contribuyente especial", ruta: "banco.numero_cuenta" }], requiere_confirmacion: [], faltantes: [] }
    const r = salida(await proveedor.generar_formulario.execute({ caso: "ec-corp-andina", mapeo }, ctx))
    expect(r.ok && (r.data.faltantes as string[])).toContain("Número de contribuyente especial")
    expect(r.ok && (r.data.advertencias as string[]).join(" ")).toContain("no tiene fuente")
  })
})

describe("HU-4 · paquete para firma", () => {
  const paquete = async (caso: string) => salida(await proveedor.armar_paquete.execute({ caso, fecha_referencia: FECHA }, ctx))

  test("Colombia con todo vigente: listo para firma", async () => {
    const r = await paquete("co-industrias-delta")
    expect(r.ok && r.data.listo_para_firma).toBe(true)
    for (const f of ["checklist.md", "borrador-correo.md", "formulario.xlsx", "soportes/rut-2026.txt"]) {
      expect((await stat(join(ctx.directory, "out/co-industrias-delta/paquete", f))).isFile()).toBe(true)
    }
  })

  test("soporte vencido bloquea (parafiscales de Honduras)", async () => {
    const r = await paquete("hn-agroexport-sula")
    expect(r.ok && r.data.listo_para_firma).toBe(false)
    expect(r.ok && JSON.stringify(r.data.checklist)).toContain('"tipo":"parafiscales","descripcion":"Certificación de pago de parafiscales y seguridad social","estado":"vencido"')
  })

  test("soporte ausente bloquea (cumplimiento tributario de Ecuador)", async () => {
    const r = await paquete("ec-corp-andina")
    expect(r.ok && r.data.listo_para_firma).toBe(false)
    expect(r.ok && (r.data.checklist as { bloqueos: string[] }).bloqueos.join(" ")).toContain("certificado_cumplimiento_tributario")
  })

  test("RN3: un campo faltante no bloquea la firma", () => {
    const vigente: EstadoSoporte = { tipo: "rut", descripcion: "RUT", estado: "vigente", archivo: "rut.txt", vigencia_hasta: null, detalle: "" }
    expect(bloqueosDeFirma([vigente], "formulario.pdf")).toEqual([])
  })

  test("RN2: el borrador de correo no contiene datos bancarios", async () => {
    await paquete("co-industrias-delta")
    const correo = await readFile(join(ctx.directory, "out/co-industrias-delta/paquete/borrador-correo.md"), "utf8")
    for (const dato of ["03100012345", "COLOCOBM", "Bancolombia", "Ahorros"]) expect(correo).not.toContain(dato)
  })

  test("RN5: cada llamada queda en out/<caso>/log.jsonl", async () => {
    const log = await readFile(join(ctx.directory, "out/co-industrias-delta/log.jsonl"), "utf8")
    const linea = JSON.parse(log.trim().split("\n")[0] ?? "{}") as Record<string, unknown>
    expect(Object.keys(linea).sort()).toEqual(["herramienta", "ok", "resumen", "ts"])
  })
})

describe("RN4 y HU-5 · confirmación y errores", () => {
  test("simular_envio sin confirmación devuelve el error del contrato", async () => {
    const r = salida(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: false }, ctx))
    expect(r).toEqual({ ok: false, error: "requiere confirmación explícita" })
  })

  test("simular_envio confirmado escribe ENVIO-SIMULADO.md", async () => {
    await proveedor.armar_paquete.execute({ caso: "co-industrias-delta", fecha_referencia: FECHA }, ctx)
    const r = salida(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: true }, ctx))
    expect(r.ok && r.data.ruta).toBe("out/co-industrias-delta/ENVIO-SIMULADO.md")
  })

  test("caso inexistente: mensaje claro con los casos disponibles", async () => {
    const r = salida(await proveedor.leer_solicitud.execute({ caso: "no-existe" }, ctx))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("Casos disponibles: co-industrias-delta")
  })

  test("ninguna herramienta lanza excepciones", async () => {
    await expect(proveedor.armar_paquete.execute({ caso: "../../etc" }, ctx)).resolves.toContain('"ok":false')
  })
})

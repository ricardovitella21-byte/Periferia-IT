import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ejecutarTurno, type DependenciasCiclo } from "../src/agent/ciclo.ts"
import { RegistroHerramientas } from "../src/agent/registro.ts"
import { AlmacenSesiones } from "../src/agent/sesiones.ts"
import { ErrorProveedor, type ProveedorLLM } from "../src/llm/adapter.ts"
import { ProveedorGuion } from "../src/llm/guion.ts"
import * as oc from "../src/tools/oc.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"
import { ProveedorFalso, proyectoTemporal, responder, salida, usar } from "./apoyo.ts"

let ctx: ContextoHerramienta
let limpiar: () => Promise<void>
let orden004: unknown
beforeAll(async () => {
  process.env.FECHA_REFERENCIA = "2026-09-03"
  ;({ ctx, limpiar } = await proyectoTemporal())
  const p = salida(await oc.leer_paquete.execute({ caso: "sol-004" }, ctx))
  const r = salida(await oc.construir_payload.execute({ caso: "sol-004", paquete: (p.ok ? p.data : {}) as never }, ctx))
  orden004 = r.ok ? r.data.orden : null
})
afterAll(() => limpiar())

const registro = new RegistroHerramientas()
const deps = (llm: ProveedorLLM, maxIteraciones = 25, c: ContextoHerramienta = ctx): DependenciasCiclo => ({ llm, registro, sistema: "prueba", ctx: c, limites: { maxIteraciones, maxTokensSesion: 1_000_000 } })
const nuevaSesion = (c: ContextoHerramienta = ctx) => new AlmacenSesiones(join(c.directory, "out", "sesiones")).crear()
const ordenes = (c: ContextoHerramienta = ctx) => readFile(join(c.directory, "out/sap/ordenes.jsonl"), "utf8").catch(() => "")

describe("contrato del registro de herramientas", () => {
  test("nombres oc_<export> con esquema JSON", () => {
    expect(registro.nombres()).toEqual(expect.arrayContaining(["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_generar_evidencia", "oc_crear", "oc_leer_excel"]))
    expect(registro.definiciones().find((d) => d.nombre === "oc_crear")?.esquema).toMatchObject({ type: "object", required: ["caso"] })
  })
})

describe("CA3 · confirmación humana verificada por el servidor", () => {
  test("confirmado=true sin pregunta previa se anula y no crea la OC", async () => {
    const llm = new ProveedorFalso([() => usar("oc_crear", { caso: "sol-004", payload: orden004, confirmado: true }), () => responder("No se pudo.")])
    const turno = await ejecutarTurno(nuevaSesion(), "crea la OC de sol-004", deps(llm))
    expect(turno.toolCalls[0]?.ok).toBe(false)
    expect(turno.toolCalls[0]?.resumen).toContain("anuló confirmado=true")
    expect(await ordenes()).toBe("")
  })

  test("pregunta → «confirmo» → OC creada", async () => {
    const sesion = nuevaSesion()
    const llm = new ProveedorFalso([
      () => usar("agente_pedir_confirmacion", { accion: "crear OC sol-004", caso: "sol-004", pregunta: "¿Confirmas?" }),
      () => responder("La cotización difiere 6 %. ¿Confirmas que cree la OC?"),
      () => usar("oc_crear", { caso: "sol-004", payload: orden004, confirmado: true }),
      () => responder("OC creada."),
    ])
    expect((await ejecutarTurno(sesion, "procesa sol-004", deps(llm))).needsConfirmation).toBe(true)
    const t2 = await ejecutarTurno(sesion, "confirmo", deps(llm))
    expect(t2.toolCalls[0]).toMatchObject({ ok: true, nombre: "oc_crear" })
    expect(await ordenes()).toContain("SOL-2026-004")
  })
})

describe("CA1 y CA5", () => {
  test("tope de iteraciones", async () => {
    const llm = new ProveedorFalso((_m, o) => (o.permitirHerramientas ? usar("oc_listar_solicitudes", {}) : responder("Tope.")))
    const turno = await ejecutarTurno(nuevaSesion(), "lista sin parar", deps(llm, 3))
    expect(turno.toolCalls).toHaveLength(3)
    expect(turno.reply).toBe("Tope.")
  })

  test("error del proveedor: mensaje claro y la sesión sigue", async () => {
    const sesion = nuevaSesion()
    const fallido: ProveedorLLM = { nombre: "x", modelo: "x", enviar: async () => { throw new ErrorProveedor("No hay conexión con el proveedor del modelo.", true) } }
    expect((await ejecutarTurno(sesion, "hola", deps(fallido))).error).toContain("conexión")
    expect((await ejecutarTurno(sesion, "hola", deps(new ProveedorFalso([() => responder("Hola.")])))).reply).toBe("Hola.")
  })
})

describe("prompt de ejemplo del PRD con el proveedor sin IA", () => {
  test("sol-004: payload, confirmaciones y pregunta; tras «confirmo», número de OC", async () => {
    const { ctx: otro, limpiar: limpiarOtro } = await proyectoTemporal()
    try {
      const sesion = nuevaSesion(otro)
      const d = deps(new ProveedorGuion(), 25, otro)
      const t1 = await ejecutarTurno(sesion, 'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.', d)
      expect(t1.toolCalls.map((t) => t.nombre)).toEqual(["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_generar_evidencia", "agente_pedir_confirmacion"])
      expect(t1.needsConfirmation).toBe(true)
      expect(t1.reply).toContain("COP 26.500.000")
      const t2 = await ejecutarTurno(sesion, "confirmo", d)
      expect(t2.toolCalls[0]).toMatchObject({ nombre: "oc_crear", ok: true })
      expect(t2.reply).toContain("4500000001")
    } finally {
      await limpiarOtro()
    }
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ejecutarTurno, type DependenciasCiclo } from "../src/agent/ciclo.ts"
import { esConfirmacion } from "../src/agent/confirmacion.ts"
import { RegistroHerramientas } from "../src/agent/registro.ts"
import { AlmacenSesiones } from "../src/agent/sesiones.ts"
import { ErrorProveedor, type ProveedorLLM } from "../src/llm/adapter.ts"
import { ProveedorGuion } from "../src/llm/guion.ts"
import * as contratos from "../src/tools/contratos.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"
import { ProveedorFalso, proyectoTemporal, responder, salida, usar } from "./apoyo.ts"

let ctx: ContextoHerramienta
let limpiar: () => Promise<void>
let contrato006: Record<string, unknown>
beforeAll(async () => {
  process.env.FECHA_REFERENCIA = "2026-09-03"
  ;({ ctx, limpiar } = await proyectoTemporal())
  const ext = salida(await contratos.extraer.execute({ mensaje_id: "msg-006" }, ctx))
  contrato006 = ext.ok ? (ext.data.contrato as Record<string, unknown>) : {}
})
afterAll(() => limpiar())

const registro = new RegistroHerramientas()
const deps = (llm: ProveedorLLM, maxIteraciones = 25): DependenciasCiclo => ({ llm, registro, sistema: "prueba", ctx, limites: { maxIteraciones, maxTokensSesion: 1_000_000 } })
const nuevaSesion = () => new AlmacenSesiones(join(ctx.directory, "out", "sesiones")).crear()
const maestro = () => readFile(join(ctx.directory, "out/sharepoint/maestro-contratos.csv"), "utf8").catch(() => "")

describe("contrato del registro de herramientas", () => {
  test("nombres contratos_<export> con esquema JSON", () => {
    expect(registro.nombres()).toEqual(
      expect.arrayContaining(["contratos_leer_buzon", "contratos_extraer", "contratos_validar", "contratos_registrar", "contratos_alertas", "contratos_leer_pdf"]),
    )
    expect(registro.definiciones().find((d) => d.nombre === "contratos_alertas")?.esquema).toMatchObject({ type: "object", required: ["hoy"] })
  })
})

describe("CA3 · confirmación humana verificada por el servidor", () => {
  test("confirmado=true sin pregunta previa se anula", async () => {
    const llm = new ProveedorFalso([() => usar("contratos_registrar", { mensaje_id: "msg-006", contrato: contrato006, confirmado: true }), () => responder("No se pudo.")])
    const turno = await ejecutarTurno(nuevaSesion(), "registra el msg-006", deps(llm))
    expect(turno.toolCalls[0]?.ok).toBe(false)
    expect(turno.toolCalls[0]?.resumen).toContain("anuló confirmado=true")
    expect(await maestro()).not.toContain("CM-2026-03")
  })

  test("pregunta → «confirmo el valor 0 y la fecha fin 2027-08-31» → registrado", async () => {
    expect(esConfirmacion("confirmo el valor 0 y la fecha fin 2027-08-31")).toBe(true)
    const sesion = nuevaSesion()
    const llm = new ProveedorFalso([
      () => usar("agente_pedir_confirmacion", { accion: "registrar msg-006", pregunta: "¿Confirmas?" }),
      () => responder("msg-006 requiere revisión de valor y fecha fin. ¿Confirmas los valores?"),
      () => usar("contratos_registrar", { mensaje_id: "msg-006", contrato: { ...contrato006, valor: 0, fecha_fin: "2027-08-31" }, confirmado: true }),
      () => responder("Registrado."),
    ])
    expect((await ejecutarTurno(sesion, "procesa el msg-006", deps(llm))).needsConfirmation).toBe(true)
    const t2 = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", deps(llm))
    expect(t2.toolCalls[0]?.ok).toBe(true)
    expect(await maestro()).toContain("CM-2026-03")
  })
})

describe("CA1 y CA5", () => {
  test("tope de iteraciones: cierra sin herramientas", async () => {
    const llm = new ProveedorFalso((_m, o) => (o.permitirHerramientas ? usar("contratos_leer_buzon", {}) : responder("Tope alcanzado.")))
    const turno = await ejecutarTurno(nuevaSesion(), "lee el buzón sin parar", deps(llm, 2))
    expect(turno.toolCalls).toHaveLength(2)
    expect(turno.reply).toBe("Tope alcanzado.")
  })

  test("error del proveedor: mensaje claro y la sesión sigue", async () => {
    const sesion = nuevaSesion()
    const fallido: ProveedorLLM = { nombre: "x", modelo: "x", enviar: async () => { throw new ErrorProveedor("El proveedor del modelo limitó las solicitudes.", true) } }
    const turno = await ejecutarTurno(sesion, "hola", deps(fallido))
    expect(turno.error).toContain("limitó")
    expect((await ejecutarTurno(sesion, "hola", deps(new ProveedorFalso([() => responder("Hola.")])))).reply).toBe("Hola.")
  })
})

describe("flujo de la demo del PRD con el proveedor sin IA", () => {
  test("procesa el buzón, pide confirmación de msg-006 y lo registra al confirmar", async () => {
    const { ctx: otro, limpiar: limpiarOtro } = await proyectoTemporal()
    try {
      const sesion = new AlmacenSesiones(join(otro.directory, "out", "sesiones")).crear()
      const d = { ...deps(new ProveedorGuion()), ctx: otro }
      const t1 = await ejecutarTurno(sesion, "Procesa el buzón de contratos con fecha de hoy 2026-09-03. No registres nada dudoso sin preguntarme.", d)
      expect(t1.needsConfirmation).toBe(true)
      expect(t1.reply).toContain("msg-006 requiere revisión")
      expect(t1.toolCalls.at(-2)?.nombre).toBe("contratos_alertas")
      const t2 = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", d)
      expect(t2.toolCalls[0]).toMatchObject({ nombre: "contratos_registrar", ok: true })
      const csv = await readFile(join(otro.directory, "out/sharepoint/maestro-contratos.csv"), "utf8")
      expect(csv).toContain(",0,COP,2026-08-31,2027-08-31,")
    } finally {
      await limpiarOtro()
    }
  })
})

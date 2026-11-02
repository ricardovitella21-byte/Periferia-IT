import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { ejecutarTurno, type DependenciasCiclo } from "../src/agent/ciclo.ts"
import { esConfirmacion, terminaEnPregunta } from "../src/agent/confirmacion.ts"
import { RegistroHerramientas } from "../src/agent/registro.ts"
import { AlmacenSesiones } from "../src/agent/sesiones.ts"
import { ErrorProveedor, type ProveedorLLM } from "../src/llm/adapter.ts"
import { ProveedorGuion } from "../src/llm/guion.ts"
import * as proveedor from "../src/tools/proveedor.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"
import { ProveedorFalso, proyectoTemporal, responder, usar } from "./apoyo.ts"

let ctx: ContextoHerramienta
let limpiar: () => Promise<void>
beforeAll(async () => {
  ;({ ctx, limpiar } = await proyectoTemporal())
  await proveedor.armar_paquete.execute({ caso: "ec-corp-andina", fecha_referencia: "2026-09-03" }, ctx)
})
afterAll(() => limpiar())

const registro = new RegistroHerramientas()
const deps = (llm: ProveedorLLM, maxIteraciones = 25): DependenciasCiclo => ({
  llm,
  registro,
  sistema: "prueba",
  ctx,
  limites: { maxIteraciones, maxTokensSesion: 1_000_000 },
})
const existe = (ruta: string) => stat(join(ctx.directory, ruta)).then(() => true, () => false)

describe("contrato del registro de herramientas", () => {
  test("nombres <archivo>_<export> con esquema JSON de entrada", () => {
    expect(registro.nombres()).toEqual(
      expect.arrayContaining(["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete", "proveedor_simular_envio"]),
    )
    const def = registro.definiciones().find((d) => d.nombre === "proveedor_leer_solicitud")
    expect(def?.esquema).toMatchObject({ type: "object", required: ["caso"] })
  })

  test("argumentos inválidos vuelven al modelo como error, sin lanzar", async () => {
    const r = await registro.ejecutar("proveedor_leer_solicitud", { caso: 42 }, ctx)
    expect(r).toMatchObject({ valida: false })
    expect(!r.valida && r.error).toContain("Argumentos inválidos")
  })
})

describe("CA3 / RN4 · confirmación humana verificada por el servidor", () => {
  test("detecta confirmaciones y negaciones", () => {
    expect(esConfirmacion("Sí, confirmo")).toBe(true)
    expect(esConfirmacion("envía")).toBe(true)
    expect(esConfirmacion("No envíes nada todavía")).toBe(false)
    expect(terminaEnPregunta("Resumen…\n\n¿Confirmas el envío?")).toBe(true)
  })

  test("sin pregunta previa, confirmado=true se anula y no se escribe nada", async () => {
    const sesion = new AlmacenSesiones(join(ctx.directory, "out", "sesiones")).crear()
    const llm = new ProveedorFalso([() => usar("proveedor_simular_envio", { caso: "ec-corp-andina", confirmado: true }), () => responder("No pude enviar.")])
    const turno = await ejecutarTurno(sesion, "envía el paquete de ec-corp-andina", deps(llm))
    expect(turno.toolCalls[0]?.ok).toBe(false)
    expect(turno.toolCalls[0]?.resumen).toContain("anuló confirmado=true")
    expect(await existe("out/ec-corp-andina/ENVIO-SIMULADO.md")).toBe(false)
  })

  test("pregunta → confirmación explícita → envío simulado", async () => {
    const sesion = new AlmacenSesiones(join(ctx.directory, "out", "sesiones")).crear()
    const llm = new ProveedorFalso([
      () => usar("agente_pedir_confirmacion", { accion: "simular envío", caso: "ec-corp-andina", pregunta: "¿Confirmas el envío?" }),
      () => responder("El paquete tiene bloqueos. ¿Confirmas que simule el envío?"),
      () => usar("proveedor_simular_envio", { caso: "ec-corp-andina", confirmado: true }),
      () => responder("Listo."),
    ])
    const t1 = await ejecutarTurno(sesion, "prepara el envío de ec-corp-andina", deps(llm))
    expect(t1.needsConfirmation).toBe(true)
    const t2 = await ejecutarTurno(sesion, "Sí, confirmo", deps(llm))
    expect(t2.toolCalls[0]?.ok).toBe(true)
    expect(await existe("out/ec-corp-andina/ENVIO-SIMULADO.md")).toBe(true)
    expect(sesion.historial).toHaveLength(4)
  })
})

describe("CA1 · tope de iteraciones", () => {
  test("al llegar al tope, el modelo responde sin herramientas con lo que tiene", async () => {
    const sesion = new AlmacenSesiones(join(ctx.directory, "out", "sesiones")).crear()
    const llm = new ProveedorFalso((_m, opciones) => (opciones.permitirHerramientas ? usar("proveedor_listar_casos", {}) : responder("Tope alcanzado: esto es lo que tengo.")))
    const turno = await ejecutarTurno(sesion, "lista casos sin parar", deps(llm, 3))
    expect(turno.toolCalls).toHaveLength(3)
    expect(turno.iteraciones).toBe(4)
    expect(turno.reply).toContain("Tope alcanzado")
    const ultimoResultado = sesion.mensajes.findLast((m) => m.rol === "resultados")
    expect(ultimoResultado?.rol === "resultados" && ultimoResultado.nota).toContain("tope de 3")
  })
})

describe("CA5 · errores del proveedor", () => {
  test("un error del modelo se muestra claro y la sesión sigue viva", async () => {
    const sesion = new AlmacenSesiones(join(ctx.directory, "out", "sesiones")).crear()
    const fallido: ProveedorLLM = {
      nombre: "fallido",
      modelo: "x",
      enviar: async () => {
        throw new ErrorProveedor("El modelo no respondió en 90 s. Intenta de nuevo.", true)
      },
    }
    const turno = await ejecutarTurno(sesion, "hola", deps(fallido))
    expect(turno.error).toContain("no respondió")
    expect(turno.reply).toContain("La sesión sigue activa")
    const siguiente = await ejecutarTurno(sesion, "hola otra vez", deps(new ProveedorFalso([() => responder("Hola.")])))
    expect(siguiente.reply).toBe("Hola.")
  })
})

describe("proveedor de prueba sin IA (guion)", () => {
  test("procesa un caso completo y cierra pidiendo confirmación", async () => {
    const sesion = new AlmacenSesiones(join(ctx.directory, "out", "sesiones")).crear()
    const turno = await ejecutarTurno(sesion, 'Procesa el caso "hn-agroexport-sula" con fecha 2026-09-03', deps(new ProveedorGuion()))
    expect(turno.toolCalls.map((t) => t.nombre)).toEqual([
      "proveedor_leer_solicitud",
      "proveedor_mapear_campos",
      "proveedor_generar_formulario",
      "proveedor_armar_paquete",
      "agente_pedir_confirmacion",
    ])
    expect(turno.needsConfirmation).toBe(true)
    expect(turno.reply).toContain("NO listo para firma")
  })
})

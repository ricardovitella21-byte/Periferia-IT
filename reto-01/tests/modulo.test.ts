import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { contenidoModulo } from "../scripts/build-modulo.ts"
import * as moduloTools from "../modulo/tools/proveedor.ts"
import * as appTools from "../src/tools/proveedor.ts"

describe("bonus · modulo/ es el mismo agente que usa la aplicación", () => {
  test("agent.md y SKILL.md están sincronizados con el prompt y el conocimiento", async () => {
    for (const [ruta, esperado] of Object.entries(await contenidoModulo())) {
      const actual = (await readFile(join(import.meta.dir, "..", "modulo", ruta), "utf8")).replace(/\r\n/g, "\n")
      expect(actual).toBe(esperado)
    }
  })

  test("las herramientas del módulo son las mismas instancias que las de la app", () => {
    expect(Object.keys(moduloTools).sort()).toEqual(Object.keys(appTools).sort())
    expect(moduloTools.leer_solicitud).toBe(appTools.leer_solicitud)
  })
})

import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DefinicionHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, Respuesta } from "../src/llm/adapter.ts"
import type { ContextoHerramienta } from "../src/tools/lib/tipos.ts"

const RAIZ = join(import.meta.dir, "..")

async function copiar(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const e of await readdir(origen, { withFileTypes: true })) {
    if (e.isDirectory()) await copiar(join(origen, e.name), join(destino, e.name))
    else await copyFile(join(origen, e.name), join(destino, e.name))
  }
}

/** Proyecto temporal con copia de los fixtures: las pruebas nunca escriben en el repo. */
export async function proyectoTemporal(): Promise<{ ctx: ContextoHerramienta; limpiar: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "reto02-test-"))
  await copiar(join(RAIZ, "fixtures"), join(dir, "fixtures"))
  return { ctx: { directory: dir, sessionId: "test" }, limpiar: () => rm(dir, { recursive: true, force: true }) }
}

export type Salida = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
export const salida = (s: string) => JSON.parse(s) as Salida

type Guion = (mensajes: Mensaje[], opciones: OpcionesEnvio) => Respuesta

/** Proveedor falso que responde con un guion fijo, para probar el ciclo sin modelo. */
export class ProveedorFalso implements ProveedorLLM {
  readonly nombre = "falso"
  readonly modelo = "falso"
  llamadas = 0
  constructor(private readonly guion: Guion[] | Guion) {}
  async enviar(mensajes: Mensaje[], _h: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta> {
    const paso = Array.isArray(this.guion) ? this.guion[this.llamadas] : this.guion
    this.llamadas++
    if (!paso) throw new Error("El guion se quedó sin pasos")
    return paso(mensajes, opciones)
  }
}

export const responder = (texto: string): Respuesta => ({ texto, llamadas: [], fin: "fin", uso: { entrada: 10, salida: 5 } })
export const usar = (nombre: string, argumentos: Record<string, unknown>, id = crypto.randomUUID()): Respuesta => ({
  texto: "",
  llamadas: [{ id, nombre, argumentos }],
  fin: "herramientas",
  uso: { entrada: 10, salida: 5 },
})

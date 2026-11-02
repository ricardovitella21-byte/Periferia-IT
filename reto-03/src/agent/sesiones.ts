import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Mensaje } from "../llm/adapter.ts"

export type LlamadaVisible = {
  id: string
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
  duracionMs: number
  archivos: string[]
}

export type EntradaHistorial = {
  rol: "usuario" | "asistente"
  texto: string
  ts: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  error?: string | null
}

export type Sesion = {
  id: string
  creada: string
  /** Conversación tal como la ve el modelo. */
  mensajes: Mensaje[]
  /** Conversación tal como la ve la analista en el chat. */
  historial: EntradaHistorial[]
  tokens: { entrada: number; salida: number }
  /** El turno anterior terminó pidiendo confirmación. */
  pendienteConfirmacion: boolean
}

const ID_VALIDO = /^[A-Za-z0-9-]{8,64}$/

export function idValido(id: string): boolean {
  return ID_VALIDO.test(id)
}

/** Sesiones en memoria, respaldadas en out/sesiones/<id>.json para sobrevivir reinicios. */
export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>()
  private readonly ocupadas = new Set<string>()

  constructor(private readonly directorio: string) {}

  crear(): Sesion {
    const sesion: Sesion = {
      id: crypto.randomUUID(),
      creada: new Date().toISOString(),
      mensajes: [],
      historial: [],
      tokens: { entrada: 0, salida: 0 },
      pendienteConfirmacion: false,
    }
    this.memoria.set(sesion.id, sesion)
    return sesion
  }

  async obtener(id: string): Promise<Sesion | null> {
    if (!idValido(id)) return null
    const enMemoria = this.memoria.get(id)
    if (enMemoria) return enMemoria
    try {
      const sesion = JSON.parse(await readFile(join(this.directorio, `${id}.json`), "utf8")) as Sesion
      this.memoria.set(id, sesion)
      return sesion
    } catch {
      return null
    }
  }

  async guardar(sesion: Sesion): Promise<void> {
    try {
      await mkdir(this.directorio, { recursive: true })
      await writeFile(join(this.directorio, `${sesion.id}.json`), JSON.stringify(sesion), "utf8")
    } catch {
      // Si el disco falla, la sesión sigue viva en memoria.
    }
  }

  /** Evita dos turnos simultáneos sobre la misma sesión. */
  tomar(id: string): boolean {
    if (this.ocupadas.has(id)) return false
    this.ocupadas.add(id)
    return true
  }

  liberar(id: string): void {
    this.ocupadas.delete(id)
  }
}

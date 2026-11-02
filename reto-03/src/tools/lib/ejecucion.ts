import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { rutas } from "./rutas.ts"
import { mensajeDe } from "./texto.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

type Salida<T> = { data: T; resumen: string }

/** Quita rutas absolutas y trazas de un mensaje para no filtrar detalles del servidor. */
function limpiar(mensaje: string, ctx: ContextoHerramienta): string {
  return mensaje.split(ctx.directory).join(".").replace(/\s+at\s.+$/gm, "")
}

/** CA4: cada llamada deja { ts, sesion, herramienta, caso, ok, resumen } en out/log.jsonl. */
async function registrar(ctx: ContextoHerramienta, herramienta: string, caso: string | null, ok: boolean, resumen: string) {
  try {
    const r = rutas(ctx)
    await mkdir(r.out, { recursive: true })
    const linea = { ts: new Date().toISOString(), sesion: ctx.sessionId, herramienta, caso, ok, resumen }
    await appendFile(join(r.out, "log.jsonl"), `${JSON.stringify(linea)}\n`)
  } catch {
    // El log nunca debe tumbar la herramienta.
  }
}

/**
 * Envoltura común: ejecuta, registra en el log y serializa `{ ok, data }` o
 * `{ ok: false, error }`. Nunca lanza hacia el agente (HU-6).
 */
export async function ejecutar<T>(
  herramienta: string,
  ctx: ContextoHerramienta,
  caso: string | null,
  fn: () => Promise<Salida<T>>,
): Promise<string> {
  try {
    const { data, resumen } = await fn()
    await registrar(ctx, herramienta, caso, true, resumen)
    return JSON.stringify({ ok: true, data })
  } catch (e) {
    const error = e instanceof ErrorHerramienta ? e.message : `Error inesperado en ${herramienta}: ${limpiar(mensajeDe(e), ctx)}`
    await registrar(ctx, herramienta, caso, false, error)
    return JSON.stringify({ ok: false, error })
  }
}

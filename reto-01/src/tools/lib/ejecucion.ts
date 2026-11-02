import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { casoExiste, mensajeDe } from "./fixtures.ts"
import { rutas } from "./rutas.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

type Salida<T> = { data: T; resumen: string }

/** Quita rutas absolutas de un mensaje para no filtrar detalles del servidor. */
function limpiar(mensaje: string, ctx: ContextoHerramienta): string {
  return mensaje.split(ctx.directory).join(".").replace(/\s+at\s.+$/gm, "")
}

async function registrar(ctx: ContextoHerramienta, herramienta: string, caso: string | null, ok: boolean, resumen: string) {
  try {
    const r = rutas(ctx)
    const ts = new Date().toISOString()
    await mkdir(r.out, { recursive: true })
    await appendFile(join(r.out, "log.jsonl"), `${JSON.stringify({ ts, sesion: ctx.sessionId, herramienta, caso, ok, resumen })}\n`)
    // RN5: registro por caso con { ts, herramienta, ok, resumen }.
    if (caso && (await casoExiste(ctx, caso))) {
      await mkdir(r.outCaso(caso), { recursive: true })
      await appendFile(join(r.outCaso(caso), "log.jsonl"), `${JSON.stringify({ ts, herramienta, ok, resumen })}\n`)
    }
  } catch {
    // El log nunca debe tumbar la herramienta.
  }
}

/**
 * Envoltura común: ejecuta, registra en los logs y serializa `{ ok, data }` o
 * `{ ok: false, error }`. Nunca lanza hacia el agente (HU-5).
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

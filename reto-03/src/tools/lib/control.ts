import { appendFile, mkdir, stat } from "node:fs/promises"
import { rutas } from "./rutas.ts"
import type { ContextoHerramienta } from "./tipos.ts"

export type ResultadoIntento = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoIntento
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"]

function celda(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

/** HU-5: cada intento de crear una OC (exitoso, bloqueado o pendiente) agrega una fila a out/control.csv. */
export async function registrarIntento(ctx: ContextoHerramienta, fila: FilaControl): Promise<void> {
  const r = rutas(ctx)
  await mkdir(r.out, { recursive: true })
  const existe = await stat(r.control).then(() => true, () => false)
  const valores = [fila.solicitud_id, fila.resultado, fila.numero_oc, String(fila.retroactiva), fila.bloqueos.join(";"), fila.confirmaciones.join(";"), new Date().toISOString()]
  await appendFile(r.control, `${existe ? "" : `${COLUMNAS.join(",")}\n`}${valores.map(celda).join(",")}\n`, "utf8")
}

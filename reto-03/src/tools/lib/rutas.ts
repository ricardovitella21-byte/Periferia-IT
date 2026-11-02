import { join } from "node:path"
import type { ContextoHerramienta } from "./tipos.ts"

/** Todas las rutas se resuelven desde ctx.directory; nunca rutas absolutas fijas. */
export function rutas(ctx: ContextoHerramienta) {
  const fixtures = join(ctx.directory, "fixtures", "reto-03")
  const out = join(ctx.directory, "out")
  return {
    fixtures,
    solicitudes: join(fixtures, "solicitudes"),
    caso: (caso: string) => join(fixtures, "solicitudes", caso),
    maestro: (nombre: string) => join(fixtures, "maestros", `${nombre}.json`),
    out,
    outCaso: (caso: string) => join(out, caso),
    sap: join(out, "sap"),
    ordenes: join(out, "sap", "ordenes.jsonl"),
    control: join(out, "control.csv"),
  }
}

/** Ruta relativa a la raíz del proyecto, con "/" para mostrarla en el chat. */
export function relativa(ctx: ContextoHerramienta, ruta: string): string {
  const raiz = ctx.directory.replace(/[\\/]+$/, "")
  const rel = ruta.startsWith(raiz) ? ruta.slice(raiz.length + 1) : ruta
  return rel.replace(/\\/g, "/")
}

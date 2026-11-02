import { join } from "node:path"
import type { ContextoHerramienta } from "./tipos.ts"

/** Todas las rutas se resuelven desde ctx.directory; nunca rutas absolutas fijas. */
export function rutas(ctx: ContextoHerramienta) {
  const fixtures = join(ctx.directory, "fixtures", "reto-02")
  const out = join(ctx.directory, "out")
  const sharepoint = join(out, "sharepoint")
  return {
    fixtures,
    buzon: join(fixtures, "buzon"),
    mensaje: (id: string) => join(fixtures, "buzon", id),
    maestroFixture: join(fixtures, "maestro-contratos.csv"),
    comerciales: join(fixtures, "comerciales.json"),
    out,
    procesados: join(out, "procesados.json"),
    alertas: join(out, "alertas.md"),
    sharepoint,
    maestro: join(sharepoint, "maestro-contratos.csv"),
    historial: join(sharepoint, "historial.jsonl"),
  }
}

/** Ruta relativa a la raíz del proyecto, con "/" para mostrarla en el chat. */
export function relativa(ctx: ContextoHerramienta, ruta: string): string {
  const raiz = ctx.directory.replace(/[\\/]+$/, "")
  const rel = ruta.startsWith(raiz) ? ruta.slice(raiz.length + 1) : ruta
  return rel.replace(/\\/g, "/")
}

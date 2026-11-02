import { join } from "node:path"
import type { ContextoHerramienta } from "./tipos.ts"

/** Todas las rutas se resuelven desde ctx.directory; nunca rutas absolutas fijas. */
export function rutas(ctx: ContextoHerramienta) {
  const fixtures = join(ctx.directory, "fixtures", "reto-01")
  const out = join(ctx.directory, "out")
  return {
    fixtures,
    casos: join(fixtures, "casos"),
    caso: (caso: string) => join(fixtures, "casos", caso),
    maestro: join(fixtures, "repositorio", "maestro.json"),
    soportes: join(fixtures, "repositorio", "soportes"),
    glosario: join(fixtures, "glosario-campos.json"),
    out,
    outCaso: (caso: string) => join(out, caso),
    paquete: (caso: string) => join(out, caso, "paquete"),
  }
}

/** Ruta relativa a la raíz del proyecto, con "/" para mostrarla en el chat. */
export function relativa(ctx: ContextoHerramienta, ruta: string): string {
  const raiz = ctx.directory.replace(/[\\/]+$/, "")
  const rel = ruta.startsWith(raiz) ? ruta.slice(raiz.length + 1) : ruta
  return rel.replace(/\\/g, "/")
}

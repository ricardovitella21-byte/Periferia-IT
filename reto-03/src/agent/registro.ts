import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter.ts"
import * as agente from "../tools/agente.ts"
import * as oc from "../tools/oc.ts"
import type { ContextoHerramienta, Herramienta } from "../tools/lib/tipos.ts"

type Entrada = { nombre: string; herramienta: Herramienta; esquema: z.ZodObject<z.ZodRawShape> }

export type Ejecucion =
  | { valida: true; salida: string }
  | { valida: false; error: string }

/** Módulos de herramientas: cada export de `<archivo>.ts` se publica como `<archivo>_<export>`. */
const MODULOS: Record<string, Record<string, Herramienta>> = {
  oc: oc as unknown as Record<string, Herramienta>,
  agente: agente as unknown as Record<string, Herramienta>,
}

/** Herramientas donde `confirmado: true` solo vale si el turno anterior pidió confirmación a la analista. */
export const REQUIEREN_CONFIRMACION = new Set(["oc_crear"])
export const HERRAMIENTA_CONFIRMACION = "agente_pedir_confirmacion"

export class RegistroHerramientas {
  private readonly entradas = new Map<string, Entrada>()

  constructor(modulos: Record<string, Record<string, Herramienta>> = MODULOS) {
    for (const [archivo, exports] of Object.entries(modulos)) {
      for (const [nombreExport, herramienta] of Object.entries(exports)) {
        const nombre = `${archivo}_${nombreExport}`
        this.entradas.set(nombre, { nombre, herramienta, esquema: z.object(herramienta.args) })
      }
    }
  }

  nombres(): string[] {
    return [...this.entradas.keys()]
  }

  definiciones(): DefinicionHerramienta[] {
    return [...this.entradas.values()].map(({ nombre, herramienta, esquema }) => {
      const { $schema: _omitido, ...json } = z.toJSONSchema(esquema, { io: "input" }) as Record<string, unknown>
      return { nombre, descripcion: herramienta.description, esquema: json }
    })
  }

  /** Acepta diferencias de mayúsculas en el nombre si no hay ambigüedad. */
  resolver(nombre: string): Entrada | undefined {
    return this.entradas.get(nombre) ?? [...this.entradas.values()].find((e) => e.nombre.toLowerCase() === nombre.toLowerCase())
  }

  /** Valida los argumentos con zod antes de ejecutar; un error vuelve al modelo, no se lanza. */
  async ejecutar(nombre: string, argumentos: unknown, ctx: ContextoHerramienta): Promise<Ejecucion> {
    const entrada = this.resolver(nombre)
    if (!entrada) return { valida: false, error: `Herramienta desconocida "${nombre}". Disponibles: ${this.nombres().join(", ")}.` }
    const args = entrada.esquema.safeParse(argumentos ?? {})
    if (!args.success) {
      const detalle = args.error.issues.map((i) => `${i.path.join(".") || "(argumentos)"}: ${i.message}`).join("; ")
      return { valida: false, error: `Argumentos inválidos para ${entrada.nombre}: ${detalle}` }
    }
    return { valida: true, salida: await entrada.herramienta.execute(args.data, ctx) }
  }
}

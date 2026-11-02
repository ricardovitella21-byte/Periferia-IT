import type { z } from "zod"

/** Contexto que recibe cada herramienta. `directory` es la raíz del proyecto. */
export type ContextoHerramienta = { directory: string; sessionId: string }

/**
 * Contrato de herramienta del PRD (sección 6.2): description + args (zod) + execute.
 * El nombre que ve el modelo es `<archivo>_<export>`.
 */
export type Herramienta<A extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: A
  execute(args: z.infer<z.ZodObject<A>>, ctx: ContextoHerramienta): Promise<string>
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

/** Identidad tipada: conserva la inferencia de `args` dentro de `execute`. */
export function definirHerramienta<A extends z.ZodRawShape>(herramienta: Herramienta<A>): Herramienta<A> {
  return herramienta
}

/** Error esperado: su mensaje es apto para mostrarse al usuario tal cual. */
export class ErrorHerramienta extends Error {}

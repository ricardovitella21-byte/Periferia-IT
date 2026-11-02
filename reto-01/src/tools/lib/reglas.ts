import { z } from "zod"
import crudo from "../../knowledge/reglas.json"

/**
 * Reglas de negocio como datos (src/knowledge/reglas.json): cambiar un país,
 * un umbral o un soporte no toca el código de las herramientas ni el servidor.
 */
const ReglasSchema = z.object({
  paises: z.record(z.string(), z.object({ nombre: z.string(), identificador_tributario: z.string() })),
  pais_emisor_maestro: z.string(),
  clave_identificador_tributario: z.string(),
  claves_bancarias: z.array(z.string()),
  mapeo: z.object({
    umbral_lleno: z.number().min(0).max(1),
    umbral_propuesta: z.number().min(0).max(1),
    palabras_vacias: z.array(z.string()),
  }),
  soportes: z.record(z.string(), z.string()),
  formatos_soportados: z.array(z.string()),
  formatos_conocidos: z.array(z.string()),
  confirmacion: z.object({ afirmativas: z.array(z.string()), negativas: z.array(z.string()) }),
})

export type Reglas = z.infer<typeof ReglasSchema>

export const reglas: Reglas = ReglasSchema.parse(crudo)

export function nombrePais(pais: string): string {
  return reglas.paises[pais]?.nombre ?? pais
}

export function identificadorDePais(pais: string): string | null {
  return reglas.paises[pais]?.identificador_tributario ?? null
}

export function nombreSoporte(tipo: string): string {
  return reglas.soportes[tipo] ?? tipo
}

import { z } from "zod"
import crudo from "../../knowledge/reglas.json"

/**
 * Reglas de negocio como datos (src/knowledge/reglas.json): tolerancias, códigos de SAP,
 * unidades o acciones sugeridas se cambian sin tocar herramientas ni servidor.
 */
const ReglasSchema = z.object({
  sociedad: z.string(),
  organizacion_compras: z.string(),
  numero_oc_inicial: z.number().int().positive(),
  tolerancia_cotizacion: z.number().min(0),
  tolerancia_valor_total: z.number().min(0),
  max_descripcion: z.number().int().positive(),
  paso_posicion: z.number().int().positive(),
  monedas: z.array(z.string()),
  aprobacion: z.object({ positivas: z.array(z.string()), negativas: z.array(z.string()) }),
  unidades: z.record(z.string(), z.array(z.string())),
  unidad_por_defecto: z.string(),
  acciones_sugeridas: z.record(z.string(), z.string()),
  confirmacion: z.object({ afirmativas: z.array(z.string()), negativas: z.array(z.string()) }),
})

export type Reglas = z.infer<typeof ReglasSchema>

export const reglas: Reglas = ReglasSchema.parse(crudo)

export function accionSugerida(codigo: string): string {
  return reglas.acciones_sugeridas[codigo] ?? "Revisar con el solicitante."
}

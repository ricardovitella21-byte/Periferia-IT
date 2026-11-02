import { z } from "zod"
import crudo from "../../knowledge/reglas.json"

/**
 * Reglas de negocio como datos (src/knowledge/reglas.json): umbrales, fecha de corte,
 * monedas, países o tipos de póliza se cambian sin tocar herramientas ni servidor.
 */
const ReglasSchema = z.object({
  umbral_confianza: z.number().min(0).max(1),
  umbral_similitud_objeto: z.number().min(0).max(1),
  fecha_corte_maestro: z.string(),
  dias_alerta_vencimiento: z.number().int().positive(),
  max_caracteres_objeto: z.number().int().positive(),
  monedas: z.array(z.string()),
  paises: z.array(z.string()),
  pais_por_lugar: z.record(z.string(), z.string()),
  pais_por_identificador: z.record(z.string(), z.string()),
  longitud_ruc: z.record(z.string(), z.string()),
  tipos_poliza: z.record(z.string(), z.string()),
  documentos_contrato: z.array(z.string()),
  documentos_no_contrato: z.array(z.string()),
  sufijos_societarios: z.array(z.string()),
  campos_obligatorios_nuevo: z.array(z.string()),
  confirmacion: z.object({ afirmativas: z.array(z.string()), negativas: z.array(z.string()) }),
})

export type Reglas = z.infer<typeof ReglasSchema>

export const reglas: Reglas = ReglasSchema.parse(crudo)

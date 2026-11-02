import { readFile } from "node:fs/promises"
import { z } from "zod"
import { rutas } from "./rutas.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
const CentroSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })),
})
const IvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
const CondicionSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroSchema>
export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: Array<z.infer<typeof IvaSchema>>
  condiciones: Array<z.infer<typeof CondicionSchema>>
}

async function leer<T>(ctx: ContextoHerramienta, nombre: string, schema: z.ZodType<T>): Promise<T[]> {
  try {
    return z.array(schema).parse(JSON.parse(await readFile(rutas(ctx).maestro(nombre), "utf8")))
  } catch {
    throw new ErrorHerramienta(`No se pudo leer el maestro ${nombre}.json.`)
  }
}

export async function cargarMaestros(ctx: ContextoHerramienta): Promise<Maestros> {
  const [proveedores, centros, iva, condiciones] = await Promise.all([
    leer(ctx, "proveedores", ProveedorSchema),
    leer(ctx, "centros-costo", CentroSchema),
    leer(ctx, "indicadores-iva", IvaSchema),
    leer(ctx, "condiciones-pago", CondicionSchema),
  ])
  return { proveedores, centros, iva, condiciones }
}

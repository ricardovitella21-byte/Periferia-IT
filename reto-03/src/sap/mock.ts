import { appendFile, mkdir, readFile } from "node:fs/promises"
import { fechaReferencia } from "../tools/lib/fechas.ts"
import { cargarMaestros } from "../tools/lib/maestros.ts"
import { reglas } from "../tools/lib/reglas.ts"
import { rutas } from "../tools/lib/rutas.ts"
import type { ContextoHerramienta } from "../tools/lib/tipos.ts"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

type Registro = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }

/** SAP simulado sobre out/sap/: números secuenciales desde 4500000001 en ordenes.jsonl. */
export class SapMock implements SapAdapter {
  constructor(private readonly ctx: ContextoHerramienta) {}

  private async ordenes(): Promise<Registro[]> {
    const texto = await readFile(rutas(this.ctx).ordenes, "utf8").catch(() => "")
    return texto
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedor = (await cargarMaestros(this.ctx)).proveedores.find((p) => p.nit === nit)
    return proveedor ? { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existentes = await this.ordenes()
    const numero_oc = String(reglas.numero_oc_inicial + existentes.length)
    const fecha = fechaReferencia()
    await mkdir(rutas(this.ctx).sap, { recursive: true })
    const registro: Registro = { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, orden }
    await appendFile(rutas(this.ctx).ordenes, `${JSON.stringify(registro)}\n`, "utf8")
    return { numero_oc, fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const encontrada = (await this.ordenes()).find((o) => o.solicitud_id === solicitud_id)
    return encontrada ? { numero_oc: encontrada.numero_oc } : null
  }

  /** Fecha de una OC existente (para responder la idempotencia con la fecha original). */
  async fechaDe(numero_oc: string): Promise<string | null> {
    return (await this.ordenes()).find((o) => o.numero_oc === numero_oc)?.fecha ?? null
  }
}

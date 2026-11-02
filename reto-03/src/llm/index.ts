import type { Config } from "../config.ts"
import type { ProveedorLLM } from "./adapter.ts"
import { ProveedorAnthropic } from "./anthropic.ts"
import { ProveedorGuion } from "./guion.ts"

/** Único punto que conoce las implementaciones concretas del proveedor. */
export function crearProveedor(config: Config): ProveedorLLM {
  if (config.proveedor === "guion") return new ProveedorGuion()
  return new ProveedorAnthropic({
    modelo: config.modelo,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    esfuerzo: config.esfuerzo,
    fallback: config.fallback,
  })
}

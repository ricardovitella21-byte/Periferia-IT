import { z } from "zod"

const entero = (porDefecto: number) => z.coerce.number().int().positive().default(porDefecto)

const EnvSchema = z.object({
  PORT: entero(3000),
  LLM_PROVIDER: z.enum(["anthropic", "guion"]).default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LLM_MAX_TOKENS: entero(16000),
  LLM_TIMEOUT_MS: entero(90000),
  LLM_FALLBACK: z.enum(["default", "off"]).default("default"),
  MAX_ITERACIONES: entero(25),
  MAX_TOKENS_SESION: entero(400000),
  MAX_TOKENS_DIA: entero(5000000),
  ACCESS_KEY: z.string().optional(),
})

export type Config = {
  puerto: number
  proveedor: "anthropic" | "guion"
  modelo: string
  esfuerzo: "low" | "medium" | "high" | "xhigh" | "max"
  maxTokens: number
  timeoutMs: number
  fallback: boolean
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensDia: number
  claveAcceso: string | null
}

/** Lee la configuración de variables de entorno. La clave del modelo nunca pasa por aquí. */
export function leerConfig(env: Record<string, string | undefined> = process.env): Config {
  const limpio = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""))
  const e = EnvSchema.parse(limpio)
  return {
    puerto: e.PORT,
    proveedor: e.LLM_PROVIDER,
    modelo: e.LLM_PROVIDER === "guion" ? "determinista-sin-ia" : e.LLM_MODEL,
    esfuerzo: e.LLM_EFFORT,
    maxTokens: e.LLM_MAX_TOKENS,
    timeoutMs: e.LLM_TIMEOUT_MS,
    fallback: e.LLM_FALLBACK === "default",
    maxIteraciones: e.MAX_ITERACIONES,
    maxTokensSesion: e.MAX_TOKENS_SESION,
    maxTokensDia: e.MAX_TOKENS_DIA,
    claveAcceso: e.ACCESS_KEY ?? null,
  }
}

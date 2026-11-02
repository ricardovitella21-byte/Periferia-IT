import Anthropic from "@anthropic-ai/sdk"
import {
  ErrorProveedor,
  type DefinicionHerramienta,
  type FinRespuesta,
  type Mensaje,
  type OpcionesEnvio,
  type ProveedorLLM,
  type Respuesta,
} from "./adapter.ts"

type BetaMessageParam = Anthropic.Beta.BetaMessageParam
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam
type BetaContentBlock = Anthropic.Beta.BetaContentBlock
type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

export type ConfigAnthropic = {
  modelo: string
  maxTokens: number
  timeoutMs: number
  esfuerzo: Esfuerzo
  /** Reintento del servidor en otro modelo si este declina por política ("default"). */
  fallback: boolean
}

const NOMBRE = "anthropic"

function aParam(mensaje: Mensaje): BetaMessageParam {
  if (mensaje.rol === "usuario") return { role: "user", content: mensaje.texto }
  if (mensaje.rol === "asistente") {
    // Se devuelve el contenido original (incluye bloques de razonamiento) sin modificarlo.
    if (mensaje.crudo?.proveedor === NOMBRE) return { role: "assistant", content: mensaje.crudo.contenido as BetaContentBlockParam[] }
    const contenido: BetaContentBlockParam[] = []
    if (mensaje.texto) contenido.push({ type: "text", text: mensaje.texto })
    for (const l of mensaje.llamadas) contenido.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos })
    return { role: "assistant", content: contenido }
  }
  const contenido: BetaContentBlockParam[] = mensaje.resultados.map((r) => ({
    type: "tool_result",
    tool_use_id: r.idLlamada,
    content: r.contenido,
    is_error: r.esError,
  }))
  if (mensaje.nota) contenido.push({ type: "text", text: mensaje.nota })
  return { role: "user", content: contenido }
}

function finDe(motivo: string | null): FinRespuesta {
  if (motivo === "tool_use") return "herramientas"
  if (motivo === "max_tokens") return "limite_tokens"
  if (motivo === "refusal") return "rechazo"
  return "fin"
}

/** Traduce los errores tipados del SDK a mensajes claros para la analista. */
function traducirError(e: unknown, timeoutMs: number): ErrorProveedor {
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorProveedor(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`, true)
  }
  if (e instanceof Anthropic.APIConnectionError) return new ErrorProveedor("No hay conexión con el proveedor del modelo. Intenta de nuevo.", true)
  if (e instanceof Anthropic.AuthenticationError) {
    return new ErrorProveedor("La clave del modelo no es válida o falta. Revisa ANTHROPIC_API_KEY en el servidor.", false)
  }
  if (e instanceof Anthropic.PermissionDeniedError) return new ErrorProveedor("La clave del modelo no tiene permiso para este modelo.", false)
  if (e instanceof Anthropic.RateLimitError) return new ErrorProveedor("El proveedor del modelo limitó las solicitudes. Espera unos segundos e intenta de nuevo.", true)
  if (e instanceof Anthropic.BadRequestError) return new ErrorProveedor(`El proveedor rechazó la solicitud: ${e.message}`, false)
  if (e instanceof Anthropic.InternalServerError) return new ErrorProveedor("El proveedor del modelo está saturado o con fallas. Intenta en un momento.", true)
  if (e instanceof Anthropic.APIError) return new ErrorProveedor(`Error del proveedor del modelo (${e.status ?? "sin estado"}).`, true)
  return new ErrorProveedor("Error inesperado al llamar al modelo.", true)
}

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = NOMBRE
  readonly modelo: string
  private cliente: Anthropic | null = null

  constructor(private readonly config: ConfigAnthropic) {
    this.modelo = config.modelo
  }

  private obtenerCliente(): Anthropic {
    if (!this.cliente) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new ErrorProveedor("Falta ANTHROPIC_API_KEY en el servidor. Configúrala o usa LLM_PROVIDER=guion para probar sin modelo.", false)
      }
      this.cliente = new Anthropic({ timeout: this.config.timeoutMs, maxRetries: 2 })
    }
    return this.cliente
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta> {
    const cliente = this.obtenerCliente()
    const tools: Anthropic.Beta.BetaTool[] = herramientas.map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      input_schema: h.esquema as Anthropic.Beta.BetaTool.InputSchema,
    }))
    let respuesta: Anthropic.Beta.BetaMessage
    try {
      respuesta = await cliente.beta.messages.create({
        model: this.config.modelo,
        max_tokens: this.config.maxTokens,
        system: opciones.sistema,
        messages: mensajes.map(aParam),
        tools,
        tool_choice: { type: opciones.permitirHerramientas ? "auto" : "none" },
        output_config: { effort: this.config.esfuerzo },
        // El prompt de sistema y las herramientas no cambian: se cachean entre llamadas.
        cache_control: { type: "ephemeral" },
        ...(this.config.fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      })
    } catch (e) {
      throw traducirError(e, this.config.timeoutMs)
    }
    const bloques: BetaContentBlock[] = respuesta.content
    const texto = bloques
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim()
    const llamadas = bloques.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, argumentos: b.input }] : []))
    const uso = respuesta.usage
    return {
      texto,
      llamadas,
      fin: finDe(respuesta.stop_reason),
      uso: {
        entrada: uso.input_tokens + (uso.cache_read_input_tokens ?? 0) + (uso.cache_creation_input_tokens ?? 0),
        salida: uso.output_tokens,
      },
      crudo: { proveedor: NOMBRE, contenido: bloques },
    }
  }
}

/**
 * Interfaz propia del proveedor de lenguaje (PRD 6.1): `enviar(mensajes, herramientas) → respuesta`.
 * El ciclo del agente solo conoce estos tipos; cambiar de proveedor no lo toca.
 */

export type LlamadaHerramienta = { id: string; nombre: string; argumentos: unknown }

export type ResultadoHerramienta = { idLlamada: string; contenido: string; esError: boolean }

export type Mensaje =
  | { rol: "usuario"; texto: string }
  | {
      rol: "asistente"
      texto: string
      llamadas: LlamadaHerramienta[]
      /** Contenido nativo del proveedor (p. ej. bloques de razonamiento) para devolverlo intacto. */
      crudo?: { proveedor: string; contenido: unknown }
    }
  | { rol: "resultados"; resultados: ResultadoHerramienta[]; nota?: string }

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type FinRespuesta = "fin" | "herramientas" | "limite_tokens" | "rechazo"

export type Respuesta = {
  texto: string
  llamadas: LlamadaHerramienta[]
  fin: FinRespuesta
  uso: { entrada: number; salida: number }
  crudo?: { proveedor: string; contenido: unknown }
}

export type OpcionesEnvio = {
  sistema: string
  /** false = el modelo no puede llamar herramientas en esta respuesta (cierre por tope). */
  permitirHerramientas: boolean
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta>
}

/** Error del proveedor con un mensaje apto para el chat (sin claves ni trazas). */
export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    readonly reintentable: boolean,
  ) {
    super(mensaje)
  }
}

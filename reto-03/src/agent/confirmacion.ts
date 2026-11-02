import { reglas } from "../tools/lib/reglas.ts"
import { normalizar } from "../tools/lib/texto.ts"

function contiene(texto: string, frase: string): boolean {
  return new RegExp(`(^| )${normalizar(frase)}( |$)`).test(texto)
}

/**
 * CA3: ¿el mensaje de la analista confirma explícitamente?
 * Ante cualquier negación se asume que no (es más seguro no crear la OC).
 */
export function esConfirmacion(mensaje: string): boolean {
  const texto = normalizar(mensaje)
  if (reglas.confirmacion.negativas.some((n) => contiene(texto, n))) return false
  return reglas.confirmacion.afirmativas.some((a) => contiene(texto, a))
}

/** Respaldo: un turno que cierra con una pregunta también queda esperando respuesta. */
export function terminaEnPregunta(texto: string): boolean {
  const lineas = texto.trim().split(/\n+/).filter((l) => l.trim())
  return /\?\s*[*_]*\s*$/.test(lineas.at(-1) ?? "")
}

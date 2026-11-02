const ISO = /^\d{4}-\d{2}-\d{2}$/

export function esFechaIso(valor: string): boolean {
  if (!ISO.test(valor)) return false
  const fecha = new Date(`${valor}T00:00:00Z`)
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor
}

/** Fecha de hoy en la zona horaria del negocio (Medellín por defecto), formato YYYY-MM-DD. */
export function hoyIso(): string {
  const zona = process.env.ZONA_HORARIA || "America/Bogota"
  return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

/**
 * Fecha contra la que se evalúa la vigencia de los soportes:
 * argumento explícito → variable FECHA_REFERENCIA → hoy.
 */
export function fechaReferencia(explicita?: string): string {
  if (explicita) return explicita
  const env = process.env.FECHA_REFERENCIA
  if (env && esFechaIso(env)) return env
  return hoyIso()
}

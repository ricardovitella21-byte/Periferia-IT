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

/** Fecha de las OC creadas: variable FECHA_REFERENCIA (demo determinista) → hoy. */
export function fechaReferencia(): string {
  const env = process.env.FECHA_REFERENCIA
  if (env && esFechaIso(env)) return env
  return hoyIso()
}

/** Fecha local (YYYY-MM-DD) de un timestamp con zona horaria, como "2026-08-21T10:02:00-05:00". */
export function fechaLocal(timestamp: string): string | null {
  const parte = timestamp.slice(0, 10)
  return esFechaIso(parte) ? parte : null
}

export function sumarDias(iso: string, dias: number): string {
  const fecha = new Date(`${iso}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

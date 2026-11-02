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

/** Fecha de registro: variable FECHA_REFERENCIA (demo determinista) → hoy. */
export function fechaReferencia(): string {
  const env = process.env.FECHA_REFERENCIA
  if (env && esFechaIso(env)) return env
  return hoyIso()
}

function aIso(fecha: Date): string {
  return fecha.toISOString().slice(0, 10)
}

/** Suma meses a una fecha ISO; si el día no existe en el mes destino, usa el último día. */
export function sumarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number]
  const ultimoDia = new Date(Date.UTC(a, m - 1 + meses + 1, 0)).getUTCDate()
  return aIso(new Date(Date.UTC(a, m - 1 + meses, Math.min(d, ultimoDia))))
}

export function sumarDias(iso: string, dias: number): string {
  const fecha = new Date(`${iso}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return aIso(fecha)
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000)
}

export function ultimoDiaDelMes(anio: number, mes: number): string {
  return aIso(new Date(Date.UTC(anio, mes, 0)))
}

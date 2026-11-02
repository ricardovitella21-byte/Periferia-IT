/** Minúsculas, sin tildes y sin signos: "TecnoSuministros  S.A.S." → "tecnosuministros s a s". */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

const CONECTORES = /\s+(?:de|del|la|las|el|los|y|e|o|para|con|por|en|a|al)$/i

/** Recorta a `max` caracteres sin partir palabras ni terminar en un conector (texto breve de SAP). */
export function recortarPalabras(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const corte = limpio.slice(0, max + 1)
  const espacio = corte.lastIndexOf(" ")
  let recorte = (espacio > 0 ? corte.slice(0, espacio) : limpio.slice(0, max)).replace(/[,;:.\-\s]+$/, "")
  while (CONECTORES.test(recorte)) recorte = recorte.replace(CONECTORES, "")
  return recorte
}

/** "COP 11.400.000" con separador de miles colombiano. */
export function pesos(valor: number, moneda = "COP"): string {
  return `${moneda} ${valor.toLocaleString("es-CO", { maximumFractionDigits: 2 })}`
}

export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

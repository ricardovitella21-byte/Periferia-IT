/** Minúsculas, sin tildes y sin signos: "Razón  Social" → "razon social". */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Raíz muy simple para plurales en español: "comerciales" → "comercial". */
function raiz(palabra: string): string {
  if (palabra.length > 4 && palabra.endsWith("es")) return palabra.slice(0, -2)
  if (palabra.length > 3 && palabra.endsWith("s")) return palabra.slice(0, -1)
  return palabra
}

export function tokens(texto: string, palabrasVacias: readonly string[]): Set<string> {
  const vacias = new Set(palabrasVacias)
  return new Set(
    normalizar(texto)
      .split(" ")
      .filter((p) => p.length > 0 && !vacias.has(p))
      .map(raiz),
  )
}

/** Coeficiente de Dice entre dos conjuntos de tokens, en [0, 1]. */
export function similitud(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let comunes = 0
  for (const t of a) if (b.has(t)) comunes++
  return (2 * comunes) / (a.size + b.size)
}

/** Escapa un valor para una celda de tabla Markdown. */
export function celdaMd(valor: string): string {
  return valor.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

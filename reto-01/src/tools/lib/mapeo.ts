import type { Maestro } from "./fixtures.ts"
import { identificadorDePais, reglas } from "./reglas.ts"
import { normalizar, similitud, tokens } from "./texto.ts"

export type ValorMaestro = string | number | boolean
type Metodo = "glosario" | "clave_maestro" | "similitud"

export type CampoLleno = { etiqueta: string; ruta: string; valor: ValorMaestro; confianza: number; metodo: Metodo }
export type CampoPorConfirmar = {
  etiqueta: string
  ruta: string
  valor_propuesto: ValorMaestro
  confianza: number
  metodo: Metodo
  motivo: string
}
export type CampoFaltante = { etiqueta: string; motivo: string }
export type ResultadoMapeo = {
  llenos: CampoLleno[]
  faltantes: CampoFaltante[]
  requiere_confirmacion: CampoPorConfirmar[]
}

type Candidato = { ruta: string; confianza: number; metodo: Metodo; referencia: string }

/** Lee un dato del maestro por ruta con puntos ("banco.numero_cuenta"). */
export function valorPorRuta(maestro: Maestro, ruta: string): ValorMaestro | undefined {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return undefined
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean") return actual
  if (Array.isArray(actual) && actual.every((v) => typeof v === "string")) return actual.join(", ")
  return undefined
}

/** Rutas de todas las hojas del maestro: "nit", "banco.swift", ... */
function rutasHoja(objeto: Record<string, unknown>, prefijo = ""): string[] {
  return Object.entries(objeto).flatMap(([clave, valor]) => {
    const ruta = prefijo ? `${prefijo}.${clave}` : clave
    if (typeof valor === "object" && valor !== null && !Array.isArray(valor)) {
      return rutasHoja(valor as Record<string, unknown>, ruta)
    }
    return [ruta]
  })
}

function buscarCandidato(etiqueta: string, maestro: Maestro, glosario: Record<string, string>): Candidato | null {
  const buscada = normalizar(etiqueta)
  for (const [sinonimo, ruta] of Object.entries(glosario)) {
    if (normalizar(sinonimo) === buscada) return { ruta, confianza: 1, metodo: "glosario", referencia: sinonimo }
  }
  const hojas = rutasHoja(maestro)
  for (const ruta of hojas) {
    if (normalizar(ruta.replace(/[._]/g, " ")) === buscada) {
      return { ruta, confianza: 0.9, metodo: "clave_maestro", referencia: ruta }
    }
  }
  // Similitud por tokens contra sinónimos del glosario y nombres de claves del maestro.
  const vacias = reglas.mapeo.palabras_vacias
  const t = tokens(etiqueta, vacias)
  const referencias: Array<[string, string]> = [
    ...Object.entries(glosario),
    ...hojas.map((ruta): [string, string] => [ruta.replace(/[._]/g, " "), ruta]),
  ]
  let mejor: Candidato | null = null
  for (const [texto, ruta] of referencias) {
    const confianza = Math.round(similitud(t, tokens(texto, vacias)) * 100) / 100
    if (!mejor || confianza > mejor.confianza) mejor = { ruta, confianza, metodo: "similitud", referencia: texto }
  }
  return mejor
}

/** RN1: el maestro solo tiene NIT colombiano; cualquier otra lectura se confirma. */
function motivoIdentificador(etiqueta: string, pais: string): string | null {
  const exigido = identificadorDePais(pais) ?? "identificador tributario"
  const esNitColombiano = pais === reglas.pais_emisor_maestro && normalizar(etiqueta) === normalizar(exigido)
  if (esNitColombiano) return null
  if (pais !== reglas.pais_emisor_maestro) {
    return `identificador extranjero: el cliente (${pais}) pide ${exigido}; Periferia solo tiene NIT colombiano, se propone el NIT`
  }
  return `etiqueta ambigua "${etiqueta}": en Colombia el identificador tributario es ${exigido}`
}

export function mapearCampos(
  etiquetas: string[],
  pais: string,
  maestro: Maestro,
  glosario: Record<string, string>,
): ResultadoMapeo {
  const resultado: ResultadoMapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  const { umbral_lleno, umbral_propuesta } = reglas.mapeo

  for (const etiqueta of etiquetas) {
    const candidato = buscarCandidato(etiqueta, maestro, glosario)
    if (!candidato || candidato.confianza < umbral_propuesta) {
      resultado.faltantes.push({ etiqueta, motivo: "No existe en el repositorio maestro ni en el glosario." })
      continue
    }
    const valor = valorPorRuta(maestro, candidato.ruta)
    if (valor === undefined) {
      resultado.faltantes.push({ etiqueta, motivo: `La clave "${candidato.ruta}" no tiene valor en el maestro.` })
      continue
    }
    // RN2: un dato bancario solo se llena si la plantilla lo pide explícitamente.
    if (reglas.claves_bancarias.includes(candidato.ruta) && candidato.metodo === "similitud") {
      resultado.faltantes.push({
        etiqueta,
        motivo: `Dato bancario: solo se llena si la plantilla lo pide explícitamente (parecido a "${candidato.referencia}").`,
      })
      continue
    }
    const motivoPais = candidato.ruta === reglas.clave_identificador_tributario ? motivoIdentificador(etiqueta, pais) : null
    if (motivoPais) {
      resultado.requiere_confirmacion.push({ etiqueta, ruta: candidato.ruta, valor_propuesto: valor, confianza: candidato.confianza, metodo: candidato.metodo, motivo: motivoPais })
    } else if (candidato.confianza < umbral_lleno) {
      resultado.requiere_confirmacion.push({
        etiqueta,
        ruta: candidato.ruta,
        valor_propuesto: valor,
        confianza: candidato.confianza,
        metodo: candidato.metodo,
        motivo: `confianza ${candidato.confianza} < ${umbral_lleno}: parecido a "${candidato.referencia}"`,
      })
    } else {
      resultado.llenos.push({ etiqueta, ruta: candidato.ruta, valor, confianza: candidato.confianza, metodo: candidato.metodo })
    }
  }
  return resultado
}

/** Campos de identificación ambiguos o extranjeros, para avisar desde la lectura (HU-1). */
export function identificadoresPorConfirmar(
  etiquetas: string[],
  pais: string,
  glosario: Record<string, string>,
): Array<{ etiqueta: string; propuesta: string; motivo: string }> {
  const propuesta = identificadorDePais(pais) ?? "identificador tributario"
  return etiquetas.flatMap((etiqueta) => {
    const ruta = Object.entries(glosario).find(([s]) => normalizar(s) === normalizar(etiqueta))?.[1]
    if (ruta !== reglas.clave_identificador_tributario) return []
    const motivo = motivoIdentificador(etiqueta, pais)
    return motivo ? [{ etiqueta, propuesta, motivo }] : []
  })
}

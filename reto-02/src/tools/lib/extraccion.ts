import type { Adjunto, Comercial, Correo, TipoDocumento } from "./buzon.ts"
import { esFechaIso, sumarDias, sumarMeses, ultimoDiaDelMes } from "./fechas.ts"
import { reglas } from "./reglas.ts"
import { normalizar } from "./texto.ts"
import { ErrorHerramienta } from "./tipos.ts"

export const CAMPOS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
] as const
export type Campo = (typeof CAMPOS)[number]

export type EstadoPoliza = "vigente" | "pendiente" | "vencida" | "no_aplica"

export type Contrato = {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: string | null
  objeto: string | null
  valor: number | null
  valor_indeterminado: boolean
  moneda: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
  estado_poliza: EstadoPoliza | null
  comercial: string | null
}

export type Extraccion = {
  mensaje_id: string
  tipo_documento: TipoDocumento
  titulo: string
  adjunto: string | null
  numero_otrosi: string | null
  contrato: Contrato
  confianza: Record<Campo, number>
  notas: Partial<Record<Campo, string>>
  advertencias: string[]
}

type Dato<T> = { valor: T; confianza: number; nota?: string }
const nada = <T>(valor: T, nota?: string): Dato<T> => ({ valor, confianza: 0, ...(nota ? { nota } : {}) })

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}
const NOMBRES_MES = Object.keys(MESES).join("|")

function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

function parrafos(texto: string): string[] {
  return texto.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean)
}

/** Párrafo de una cláusula: su encabezado (primeras palabras) menciona la clave. */
function clausula(texto: string, clave: string): string | null {
  return parrafos(texto).find((p) => normalizar(p).split(" ").slice(0, 8).includes(clave)) ?? null
}

type FechaEncontrada = { iso: string; posicion: number }

/** Fechas en español: "primero (1) de agosto de 2026", "14 de mayo de 2026", "(30) días del mes de julio de 2026". */
function fechasEn(texto: string): FechaEncontrada[] {
  const plano = sinTildes(texto).toLowerCase()
  const patron = new RegExp(`(?:\\((\\d{1,2})\\)|\\b(\\d{1,2}))\\s+(?:dias\\s+del\\s+mes\\s+)?de\\s+(${NOMBRES_MES})\\s+de\\s+(\\d{4})`, "g")
  const fechas: FechaEncontrada[] = []
  for (const m of plano.matchAll(patron)) {
    const dia = Number(m[1] ?? m[2])
    const mes = MESES[m[3] ?? ""] ?? 0
    const iso = `${m[4]}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
    if (!esFechaIso(iso)) throw new ErrorHerramienta(`Fecha inválida en el documento: "${m[0]}".`)
    fechas.push({ iso, posicion: m.index ?? 0 })
  }
  return fechas
}

/** "120,000.00" → 120000 · "265.000.000" → 265000000. */
export function aNumero(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!/\d/.test(limpio)) return null
  const separador = Math.max(limpio.lastIndexOf("."), limpio.lastIndexOf(","))
  const decimales = separador >= 0 ? limpio.length - separador - 1 : 0
  const [entero, fraccion] = separador >= 0 && decimales > 0 && decimales <= 2 ? [limpio.slice(0, separador), limpio.slice(separador + 1)] : [limpio, ""]
  const valor = Number(`${entero.replace(/[.,]/g, "")}${fraccion ? `.${fraccion}` : ""}`)
  return Number.isFinite(valor) ? valor : null
}

function extraerId(titulo: string, texto: string): Dato<string | null> {
  const enTitulo = titulo.match(/No\.?\s*([A-Z]{1,5}-\d{4}-\d{1,5})/i)?.[1]
  if (enTitulo) return { valor: enTitulo.toUpperCase(), confianza: 0.98 }
  const enTexto = texto.match(/contrato[^.\n]{0,60}?No\.?\s*([A-Z]{1,5}-\d{4}-\d{1,5})/i)?.[1]
  if (enTexto) return { valor: enTexto.toUpperCase(), confianza: 0.85 }
  return nada(null, "El documento no trae número de contrato; se asignará AUTO-<año>-<secuencia>.")
}

/** Busca la forma con mayúsculas y minúsculas del nombre (p. ej. en el bloque de firmas). */
function nombreLegible(mayusculas: string, texto: string): Dato<string> {
  const buscado = normalizar(mayusculas)
  for (const linea of texto.split(/\r?\n/)) {
    for (const celda of linea.split(/\s{2,}/).map((c) => c.trim())) {
      if (celda && celda !== celda.toUpperCase() && normalizar(celda) === buscado) return { valor: celda, confianza: 0.95 }
    }
  }
  const menores = new Set(["de", "del", "la", "las", "los", "y", "e"])
  const titulo = mayusculas
    .toLowerCase()
    .split(" ")
    .map((p, i) => (p.includes(".") ? p.toUpperCase() : i > 0 && menores.has(p) ? p : p.replace(/^\p{L}/u, (c) => c.toUpperCase())))
    .join(" ")
  return { valor: titulo, confianza: 0.85, nota: "Nombre convertido desde mayúsculas; no se encontró en el bloque de firmas." }
}

type Partes = { cliente: Dato<string | null>; nit: Dato<string | null>; tipoId: string | null; domicilio: string | null }

function extraerPartes(texto: string): Partes {
  const primero = parrafos(texto).find((p) => /^entre\b/i.test(p)) ?? texto
  const patron = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .&-]+?),\s*(?:identificad[ao]\s+con\s+)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?([\d][\d.\-]*\d)/g
  for (const m of primero.matchAll(patron)) {
    const nombre = (m[1] ?? "").trim()
    if (normalizar(nombre).includes("periferia")) continue
    const tipoId = m[2] ?? null
    let nit = (m[3] ?? "").replace(/\./g, "")
    if (tipoId === "NIT") nit = nit.replace(/-\d$/, "") // sin dígito de verificación
    nit = nit.replace(/-/g, "")
    const resto = primero.slice((m.index ?? 0) + m[0].length)
    const domicilio = resto.match(/domicilio en ([^,]+(?:,\s*[A-ZÁÉÍÓÚ][a-záéíóúñ]+)?)/)?.[1] ?? null
    return { cliente: nombreLegible(nombre, texto), nit: { valor: nit, confianza: 0.95 }, tipoId, domicilio }
  }
  return { cliente: nada(null, "No se identificó la contraparte."), nit: nada(null, "No se identificó el identificador tributario."), tipoId: null, domicilio: null }
}

function extraerPais(partes: Partes): Dato<string | null> {
  const lugar = partes.domicilio ? normalizar(partes.domicilio) : ""
  const porLugar = Object.entries(reglas.pais_por_lugar).find(([l]) => lugar.includes(l))?.[1] ?? null
  let porId: string | null = null
  if (partes.tipoId === "RUC") porId = reglas.longitud_ruc[String(partes.nit.valor?.length ?? 0)] ?? null
  else if (partes.tipoId) porId = reglas.pais_por_identificador[partes.tipoId] ?? null
  if (porLugar && porId && porLugar !== porId) return { valor: porLugar, confianza: 0.6, nota: `El domicilio indica ${porLugar} pero el identificador sugiere ${porId}.` }
  if (porLugar && porId) return { valor: porLugar, confianza: 0.95 }
  if (porLugar ?? porId) return { valor: porLugar ?? porId, confianza: 0.85 }
  return nada(null, "No se pudo inferir el país.")
}

function extraerObjeto(texto: string): Dato<string | null> {
  const p = clausula(texto, "objeto")
  if (!p) return nada(null, "El documento no tiene cláusula de objeto.")
  let objeto = p
    .replace(/^[^.]+\.\s*OBJETO\.?\s*/i, "")
    .replace(/^EL CONTRATISTA\s+(?:se obliga a (?:ejecutar|prestar)\s+|prestar[áa]\s+(?:el servicio de\s+)?)/i, "")
    .replace(/^(?:la|el|los|las)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim()
  objeto = objeto.charAt(0).toUpperCase() + objeto.slice(1)
  const max = reglas.max_caracteres_objeto
  if (objeto.length <= max) return { valor: objeto, confianza: 0.9 }
  const recorte = objeto.slice(0, max - 1)
  return { valor: `${recorte.slice(0, recorte.lastIndexOf(" "))}…`, confianza: 0.85, nota: `Objeto recortado a ${max} caracteres.` }
}

type Valor = { valor: Dato<number | null>; moneda: Dato<string | null>; indeterminado: boolean }

function extraerValor(texto: string, pais: string | null): Valor {
  const p = clausula(texto, "valor") ?? parrafos(texto).find((x) => /valor/i.test(x)) ?? null
  const monedaEnTexto = (t: string) => t.match(new RegExp(`\\b(${reglas.monedas.join("|")})\\b`))?.[1] ?? null
  if (!p) return { valor: nada(null, "No hay cláusula de valor."), moneda: nada(null), indeterminado: false }
  const indeterminado = /no tiene (?:un )?valor determinado|valor indeterminado|por demanda|seg[uú]n (?:las )?[oó]rdenes/i.test(sinTildes(p))
  if (indeterminado) {
    const moneda = monedaEnTexto(texto)
    return {
      valor: { valor: 0, confianza: 0.7, nota: "Contrato sin valor determinado (marco o por demanda): se registra 0 con valor_indeterminado = true." },
      moneda: moneda ? { valor: moneda, confianza: 0.8, nota: "Moneda tomada de otra cláusula del contrato." } : nada(null, "No se indica la moneda."),
      indeterminado: true,
    }
  }
  const conCodigo = p.match(/\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*\d)/)
  if (conCodigo) {
    const codigo = conCodigo[1] ?? ""
    if (!reglas.monedas.includes(codigo)) throw new ErrorHerramienta(`Moneda desconocida "${codigo}". Monedas válidas: ${reglas.monedas.join(", ")}.`)
    const numero = aNumero(conCodigo[2] ?? "")
    return { valor: numero === null ? nada(null) : { valor: numero, confianza: 0.95 }, moneda: { valor: codigo, confianza: 0.95 }, indeterminado: false }
  }
  const soloSigno = p.match(/\$\s*(\d[\d.,]*\d)/)
  if (soloSigno) {
    const numero = aNumero(soloSigno[1] ?? "")
    const moneda = pais === "CO" ? "COP" : null
    return {
      valor: numero === null ? nada(null) : { valor: numero, confianza: 0.85 },
      moneda: moneda ? { valor: moneda, confianza: 0.6, nota: "Solo aparece el signo $; se infiere la moneda del país." } : nada(null, "Moneda no indicada."),
      indeterminado: false,
    }
  }
  return { valor: nada(null, "No se encontró un monto en la cláusula de valor."), moneda: nada(null), indeterminado: false }
}

/** Fecha de firma: "a los treinta (30) días del mes de julio de 2026" o solo "en el mes de agosto de 2026". */
function extraerFirma(texto: string, correo: Correo): Dato<string | null> {
  const p = parrafos(texto).find((x) => /se firma|para constancia/i.test(x))
  if (!p) return nada(null, "No se encontró la fecha de firma.")
  const completa = fechasEn(p)[0]
  if (completa) return { valor: completa.iso, confianza: 0.95 }
  const soloMes = sinTildes(p).toLowerCase().match(new RegExp(`mes de (${NOMBRES_MES}) de (\\d{4})`))
  if (!soloMes) return nada(null, "La fecha de firma no es legible.")
  const anio = Number(soloMes[2])
  const mes = MESES[soloMes[1] ?? ""] ?? 1
  const fechaCorreo = correo.fecha.slice(0, 10)
  const propuesta = fechaCorreo.startsWith(`${anio}-${String(mes).padStart(2, "0")}`) ? fechaCorreo : ultimoDiaDelMes(anio, mes)
  return { valor: propuesta, confianza: 0.5, nota: `El documento solo dice "${soloMes[0]}", sin día. Se propone ${propuesta} (fecha del correo o fin de mes).` }
}

function extraerPlazo(texto: string, correo: Correo): { inicio: Dato<string | null>; fin: Dato<string | null> } {
  const p = clausula(texto, "plazo") ?? parrafos(texto).find((x) => /plazo/i.test(x)) ?? null
  if (!p) return { inicio: nada(null, "No hay cláusula de plazo."), fin: nada(null, "No hay cláusula de plazo.") }
  const plano = sinTildes(p).toLowerCase()
  const fechas = fechasEn(p)
  const meses = Number(plano.match(/\((\d{1,3})\)\s+meses|\b(\d{1,3})\s+meses/)?.slice(1).find(Boolean) ?? 0)
  const desde = /\bdesde\b/.test(plano)
  const hasta = /\bhasta\b/.test(plano)

  let inicio: Dato<string | null> = nada(null, "El documento no indica la fecha de inicio.")
  let fin: Dato<string | null> = nada(null, "El documento no indica la fecha de fin.")
  if (desde && hasta && fechas.length >= 2) {
    inicio = { valor: fechas[0]?.iso ?? null, confianza: 0.95 }
    fin = { valor: fechas[1]?.iso ?? null, confianza: 0.95 }
  } else if (hasta && fechas.length === 1) {
    fin = { valor: fechas[0]?.iso ?? null, confianza: 0.9 }
  } else if (fechas.length === 1) {
    inicio = { valor: fechas[0]?.iso ?? null, confianza: 0.9 }
  }
  if (!inicio.valor && /(?:a partir|desde) (?:de )?la (?:fecha de (?:su )?)?firma/.test(plano)) {
    const firma = extraerFirma(texto, correo)
    inicio = { ...firma, nota: `Inicio = fecha de firma. ${firma.nota ?? ""}`.trim() }
  }
  if (inicio.valor && !fin.valor && meses > 0) {
    const derivada = sumarDias(sumarMeses(inicio.valor, meses), -1)
    fin = { valor: derivada, confianza: Math.min(inicio.confianza, 0.7), nota: `Derivada de un plazo de ${meses} meses desde ${inicio.valor}.` }
  }
  if (inicio.valor && fin.valor && meses > 0 && inicio.confianza >= 0.9) {
    const esperada = sumarDias(sumarMeses(inicio.valor, meses), -1)
    if (esperada !== fin.valor) fin = { ...fin, confianza: 0.7, nota: `El plazo de ${meses} meses daría ${esperada}, pero el documento dice ${fin.valor}.` }
  }
  return { inicio, fin }
}

type Poliza = { requiere: Dato<boolean | null>; tipos: Dato<string | null>; estado: Dato<EstadoPoliza | null> }

function extraerPoliza(texto: string, correo: Correo, esOtrosi: boolean): Poliza {
  const relevantes = parrafos(texto).filter((p) => /p[oó]liza|garant[ií]a/i.test(p))
  const cuerpo = normalizar(correo.cuerpo)
  const correoNiega = /\b(no pide|no requiere|sin) poliza/.test(cuerpo)
  const correoAfirma = !correoNiega && /\b(requiere|pide|con) poliza/.test(cuerpo)
  if (relevantes.length === 0) {
    if (esOtrosi) return { requiere: nada(null), tipos: nada(null), estado: nada(null) }
    const confianza = correoAfirma ? 0.6 : correoNiega ? 0.95 : 0.85
    const nota = correoAfirma ? "El documento no tiene garantías pero el correo dice que requiere póliza." : "El documento no tiene cláusula de garantías ni pólizas."
    return { requiere: { valor: false, confianza, nota }, tipos: { valor: "", confianza }, estado: { valor: "no_aplica", confianza } }
  }
  const plano = normalizar(relevantes.join(" "))
  const tipos = [...new Set(Object.entries(reglas.tipos_poliza).filter(([t]) => plano.includes(t)).map(([, v]) => v))]
  const condicional = /para cada|cuyo valor supere|en caso de/.test(plano)
  const nota = condicional ? "Póliza condicionada (por ejemplo, solo para órdenes de servicio que superen un monto)." : undefined
  const confianza = correoNiega ? 0.6 : condicional ? 0.85 : 0.9
  const ampliar = esOtrosi && /ampliar|ampliarse|prorrogar/.test(plano)
  return {
    requiere: { valor: true, confianza, ...(nota ? { nota } : {}) },
    tipos: tipos.length ? { valor: tipos.join(";"), confianza } : { valor: "", confianza: 0.5, nota: "No se identificó el tipo de póliza." },
    estado: ampliar
      ? { valor: "pendiente", confianza: 0.85, nota: "El otrosí exige ampliar la vigencia de las garantías: la póliza queda pendiente hasta su ampliación." }
      : esOtrosi
        ? nada(null)
        : { valor: "pendiente", confianza },
  }
}

function resolverComercial(correo: Correo, comerciales: Comercial[]): { dato: Dato<string | null>; advertencia: string | null } {
  const comercial = comerciales.find((c) => c.email.toLowerCase() === correo.de.toLowerCase())
  if (comercial) return { dato: { valor: comercial.nombre, confianza: 1 }, advertencia: null }
  return {
    dato: { valor: `${correo.de} (no registrado)`, confianza: 1, nota: "Remitente que no está en comerciales.json." },
    advertencia: `Remitente no registrado como comercial: ${correo.de}. Se reporta pero no bloquea el registro.`,
  }
}

/** Extracción determinista (regex y heurísticas) con confianza por campo. Nunca inventa: lo ausente es null con confianza 0. */
export function extraerContrato(correo: Correo, adjunto: Adjunto | undefined, comerciales: Comercial[]): Extraccion {
  const comercial = resolverComercial(correo, comerciales)
  const advertencias = comercial.advertencia ? [comercial.advertencia] : []
  const base = (tipo: TipoDocumento, titulo: string): Extraccion => ({
    mensaje_id: correo.id,
    tipo_documento: tipo,
    titulo,
    adjunto: adjunto?.nombre ?? null,
    numero_otrosi: null,
    contrato: {
      id_contrato: null, cliente: null, nit_cliente: null, pais: null, objeto: null, valor: null, valor_indeterminado: false,
      moneda: null, fecha_inicio: null, fecha_fin: null, requiere_poliza: null, tipo_poliza: null, estado_poliza: null, comercial: comercial.dato.valor,
    },
    confianza: Object.fromEntries(CAMPOS.map((c) => [c, c === "comercial" ? comercial.dato.confianza : 0])) as Record<Campo, number>,
    notas: {},
    advertencias,
  })
  if (adjunto && !adjunto.texto.trim()) throw new ErrorHerramienta(`El adjunto ${adjunto.nombre} está vacío: no hay texto que extraer.`)
  if (!adjunto || adjunto.tipo === "no_contrato" || adjunto.tipo === "desconocido") {
    return base(adjunto?.tipo ?? "desconocido", adjunto?.titulo ?? "")
  }

  const texto = adjunto.texto
  const esOtrosi = adjunto.tipo === "otrosi"
  const partes = extraerPartes(texto)
  const pais = extraerPais(partes)
  const valor = extraerValor(texto, pais.valor)
  const plazo = extraerPlazo(texto, correo)
  const poliza = extraerPoliza(texto, correo, esOtrosi)
  const datos: Record<Campo, Dato<string | number | boolean | null>> = {
    id_contrato: extraerId(adjunto.titulo, texto),
    cliente: partes.cliente,
    nit_cliente: partes.nit,
    pais,
    objeto: esOtrosi ? nada(null, "Un otrosí no repite el objeto; se conserva el del maestro.") : extraerObjeto(texto),
    valor: valor.valor,
    moneda: valor.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipos,
    estado_poliza: poliza.estado,
    comercial: comercial.dato,
  }
  const resultado = base(adjunto.tipo, adjunto.titulo)
  resultado.numero_otrosi = esOtrosi ? (adjunto.titulo.match(/OTROS[IÍ]\s+No\.?\s*(\d+)/i)?.[1] ?? "1") : null
  resultado.contrato = {
    id_contrato: datos.id_contrato.valor as string | null,
    cliente: datos.cliente.valor as string | null,
    nit_cliente: datos.nit_cliente.valor as string | null,
    pais: datos.pais.valor as string | null,
    objeto: datos.objeto.valor as string | null,
    valor: datos.valor.valor as number | null,
    valor_indeterminado: valor.indeterminado,
    moneda: datos.moneda.valor as string | null,
    fecha_inicio: datos.fecha_inicio.valor as string | null,
    fecha_fin: datos.fecha_fin.valor as string | null,
    requiere_poliza: datos.requiere_poliza.valor as boolean | null,
    tipo_poliza: datos.tipo_poliza.valor as string | null,
    estado_poliza: datos.estado_poliza.valor as EstadoPoliza | null,
    comercial: datos.comercial.valor as string | null,
  }
  for (const campo of CAMPOS) {
    resultado.confianza[campo] = datos[campo].confianza
    const nota = datos[campo].nota
    if (nota) resultado.notas[campo] = nota
  }
  return resultado
}

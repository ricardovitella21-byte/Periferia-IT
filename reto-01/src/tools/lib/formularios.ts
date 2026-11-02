import ExcelJS from "exceljs"
import { writeFile } from "node:fs/promises"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { CampoPlantilla } from "./fixtures.ts"
import type { ResultadoMapeo, ValorMaestro } from "./mapeo.ts"
import { celdaMd } from "./texto.ts"

export type EstadoCampo = "lleno" | "requiere_confirmacion" | "faltante"
export type CampoResuelto = CampoPlantilla & { valor: ValorMaestro | null; estado: EstadoCampo; nota: string | null }

export type Encabezado = { cliente: string; caso: string; asunto: string; fecha: string }

/** Cruza la plantilla con el mapeo, conservando el orden y la posición de cada campo. */
export function resolverCampos(campos: CampoPlantilla[], mapeo: ResultadoMapeo): CampoResuelto[] {
  return campos.map((campo) => {
    const lleno = mapeo.llenos.find((c) => c.etiqueta === campo.etiqueta)
    if (lleno) return { ...campo, valor: lleno.valor, estado: "lleno", nota: null }
    const porConfirmar = mapeo.requiere_confirmacion.find((c) => c.etiqueta === campo.etiqueta)
    if (porConfirmar) {
      return { ...campo, valor: porConfirmar.valor_propuesto, estado: "requiere_confirmacion", nota: `Por confirmar: ${porConfirmar.motivo}` }
    }
    const faltante = mapeo.faltantes.find((c) => c.etiqueta === campo.etiqueta)
    return { ...campo, valor: null, estado: "faltante", nota: `Faltante: ${faltante?.motivo ?? "sin fuente en el maestro"}` }
  })
}

const RELLENO: Record<Exclude<EstadoCampo, "lleno">, string> = {
  requiere_confirmacion: "FFFCE4D6",
  faltante: "FFFFF2CC",
}

function columna(celda: string): string {
  return celda.replace(/\d+$/, "")
}

/** HU-3 P0: escribe cada etiqueta y valor exactamente en la hoja y celda de la plantilla. */
export async function escribirXlsx(ruta: string, campos: CampoResuelto[], encabezado: Encabezado): Promise<void> {
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro como Proveedor"
  libro.title = `Registro de proveedor - ${encabezado.cliente}`
  const anchos = new Map<string, Map<string, number>>()

  for (const campo of campos) {
    if (!campo.hoja || !campo.celda_etiqueta || !campo.celda_valor) continue
    const hoja = libro.getWorksheet(campo.hoja) ?? libro.addWorksheet(campo.hoja)
    const etiqueta = hoja.getCell(campo.celda_etiqueta)
    etiqueta.value = campo.etiqueta
    etiqueta.font = { bold: true }
    const valor = hoja.getCell(campo.celda_valor)
    valor.value = campo.valor
    if (campo.estado !== "lleno") {
      valor.fill = { type: "pattern", pattern: "solid", fgColor: { argb: RELLENO[campo.estado] } }
      if (campo.nota) valor.note = campo.nota
    }
    const columnas = anchos.get(campo.hoja) ?? new Map<string, number>()
    for (const [celda, texto] of [[campo.celda_etiqueta, campo.etiqueta], [campo.celda_valor, String(campo.valor ?? "")]] as const) {
      const col = columna(celda)
      columnas.set(col, Math.max(columnas.get(col) ?? 10, Math.min(texto.length + 2, 70)))
    }
    anchos.set(campo.hoja, columnas)
  }
  for (const [nombre, columnas] of anchos) {
    const hoja = libro.getWorksheet(nombre)
    for (const [col, ancho] of columnas) if (hoja) hoja.getColumn(col).width = ancho
  }
  await libro.xlsx.writeFile(ruta)
}

/** Las fuentes estándar de PDF usan WinAnsi: se reemplaza lo que no se puede codificar. */
function paraPdf(texto: string): string {
  return texto
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[^\x20-\x7E\xA0-\xFF—–•…€]/g, "?")
}

function partirLineas(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of paraPdf(texto).split(/\s+/)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tamano) <= ancho || !actual) actual = prueba
    else {
      lineas.push(actual)
      actual = palabra
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

const MARGEN = 50
const ANCHO_ETIQUETA = 190

/** HU-3 P1: PDF generado con todos los campos (etiqueta y valor) en el orden de la plantilla. */
export async function escribirPdf(ruta: string, campos: CampoResuelto[], encabezado: Encabezado): Promise<void> {
  const doc = await PDFDocument.create()
  doc.setTitle(paraPdf(`Formulario de registro de proveedor - ${encabezado.cliente}`))
  doc.setCreator("Agente Registro como Proveedor")
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  let pagina: PDFPage = doc.addPage([595, 842])
  let y = 842 - MARGEN
  const anchoValor = 595 - MARGEN * 2 - ANCHO_ETIQUETA - 10

  const texto = (t: string, x: number, tam: number, fuente: PDFFont, color = rgb(0, 0, 0)) => {
    pagina.drawText(paraPdf(t), { x, y, size: tam, font: fuente, color })
  }
  const asegurarEspacio = (alto: number) => {
    if (y - alto < MARGEN + 40) {
      pagina = doc.addPage([595, 842])
      y = 842 - MARGEN
    }
  }

  texto("Formulario de registro de proveedor", MARGEN, 16, negrita)
  y -= 22
  for (const linea of [`Cliente: ${encabezado.cliente}`, `Solicitud: ${encabezado.asunto}`, `Caso: ${encabezado.caso} · Generado: ${encabezado.fecha}`]) {
    texto(linea, MARGEN, 9, normal, rgb(0.3, 0.3, 0.3))
    y -= 13
  }
  y -= 10

  for (const campo of campos) {
    const etiqueta = `${campo.etiqueta}${campo.obligatorio ? " *" : ""}`
    const lineasEtiqueta = partirLineas(etiqueta, negrita, 10, ANCHO_ETIQUETA)
    const valorTexto = campo.valor === null ? "" : String(campo.valor)
    const lineasValor = partirLineas(valorTexto, normal, 10, anchoValor)
    const marca = campo.estado === "faltante" ? "[FALTANTE]" : campo.estado === "requiere_confirmacion" ? "[POR CONFIRMAR]" : null
    const filas = Math.max(lineasEtiqueta.length, lineasValor.length + (marca ? 1 : 0))
    asegurarEspacio(filas * 13 + 10)
    const inicio = y
    lineasEtiqueta.forEach((l, i) => pagina.drawText(l, { x: MARGEN, y: inicio - i * 13, size: 10, font: negrita }))
    lineasValor.forEach((l, i) => pagina.drawText(l, { x: MARGEN + ANCHO_ETIQUETA + 10, y: inicio - i * 13, size: 10, font: normal }))
    if (marca) {
      const color = campo.estado === "faltante" ? rgb(0.75, 0.1, 0.1) : rgb(0.8, 0.45, 0)
      pagina.drawText(marca, { x: MARGEN + ANCHO_ETIQUETA + 10, y: inicio - lineasValor.length * 13, size: 8, font: negrita, color })
    }
    y = inicio - filas * 13 - 4
    pagina.drawLine({ start: { x: MARGEN, y: y + 6 }, end: { x: 595 - MARGEN, y: y + 6 }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) })
    y -= 6
  }

  asegurarEspacio(90)
  y -= 30
  texto("* Campo obligatorio para el cliente.", MARGEN, 8, normal, rgb(0.3, 0.3, 0.3))
  y -= 45
  pagina.drawLine({ start: { x: MARGEN, y }, end: { x: MARGEN + 230, y }, thickness: 0.8 })
  y -= 12
  texto("Firma del representante legal", MARGEN, 9, normal)
  await writeFile(ruta, await doc.save())
}

/** HU-3 P2: el portal no se llena; se entregan los valores listos para copiar. */
export async function escribirValoresPortal(
  ruta: string,
  campos: CampoResuelto[],
  encabezado: Encabezado,
  urlPortal: string | null,
  soportes: string[],
): Promise<void> {
  const filas = campos.map((c, i) => {
    const estado = c.estado === "lleno" ? "lleno" : c.estado === "faltante" ? "**FALTANTE**" : "**POR CONFIRMAR**"
    return `| ${i + 1} | ${celdaMd(c.etiqueta)}${c.obligatorio ? " *" : ""} | ${celdaMd(String(c.valor ?? ""))} | ${estado} |`
  })
  const contenido = [
    `# Valores para el portal · ${encabezado.cliente}`,
    "",
    "> **Formato no soportado: portal web.** El agente no ingresa a portales. Copia estos valores en el formulario en línea.",
    "> El ingreso de credenciales, la carga de soportes y el clic en \"Enviar\" los hace una persona.",
    "",
    `- Caso: \`${encabezado.caso}\``,
    `- Solicitud: ${encabezado.asunto}`,
    `- Portal mencionado en el correo: ${urlPortal ?? "no indicado"}`,
    `- Generado: ${encabezado.fecha}`,
    "",
    "| # | Campo | Valor | Estado |",
    "|---|---|---|---|",
    ...filas,
    "",
    "\\* Campo obligatorio para el cliente.",
    "",
    "## Soportes que pide cargar el portal",
    "",
    ...soportes.map((s) => `- ${s}`),
    "",
    "## Pasos humanos",
    "",
    "1. Ingresar al portal con las credenciales que recibió el representante legal (no pasan por el agente).",
    "2. Copiar los valores de la tabla. Revisar antes los campos **POR CONFIRMAR** y completar los **FALTANTES**.",
    "3. Cargar los soportes desde la carpeta `paquete/`.",
    "4. Revisar y hacer clic en \"Enviar\".",
    "",
  ].join("\n")
  await writeFile(ruta, contenido, "utf8")
}

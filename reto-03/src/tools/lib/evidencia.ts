import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { Aprobacion } from "./paquete.ts"

/** Contenido canónico del correo de aprobación: encabezados y cuerpo. El sha256 se calcula sobre esto. */
export function contenidoEvidencia(a: Aprobacion): string {
  return [`De: ${a.de}`, `Para: ${a.para}`, ...(a.cc.length ? [`CC: ${a.cc.join(", ")}`] : []), `Fecha: ${a.fecha_hora}`, `Asunto: ${a.asunto}`, "", a.texto.trim(), ""].join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

/** Las fuentes estándar de PDF usan WinAnsi: se reemplaza lo que no se puede codificar. */
function paraPdf(texto: string): string {
  return texto.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7E\xA0-\xFF—–•…€]/g, "?")
}

async function escribirPdf(ruta: string, titulo: string, contenido: string, hash: string): Promise<void> {
  const doc = await PDFDocument.create()
  doc.setTitle(paraPdf(titulo))
  doc.setCreator("Agente Órdenes de Compra")
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const fija = await doc.embedFont(StandardFonts.Courier)
  const pagina = doc.addPage([595, 842])
  let y = 790
  pagina.drawText(paraPdf(titulo), { x: 50, y, size: 14, font: negrita })
  y -= 28
  for (const linea of contenido.split("\n")) {
    const palabras = paraPdf(linea).split(" ")
    let actual = ""
    for (const palabra of palabras) {
      const prueba = actual ? `${actual} ${palabra}` : palabra
      if (normal.widthOfTextAtSize(prueba, 10) > 495 && actual) {
        pagina.drawText(actual, { x: 50, y, size: 10, font: normal })
        y -= 14
        actual = palabra
      } else actual = prueba
    }
    pagina.drawText(actual, { x: 50, y, size: 10, font: normal })
    y -= 14
  }
  y -= 20
  pagina.drawText("SHA-256 del contenido:", { x: 50, y, size: 9, font: negrita, color: rgb(0.3, 0.3, 0.3) })
  pagina.drawText(hash, { x: 50, y: y - 13, size: 8, font: fija, color: rgb(0.3, 0.3, 0.3) })
  await writeFile(ruta, await doc.save())
}

/** HU-4: aprobacion.txt (P0) y aprobacion.pdf (P1) con el mismo contenido y su sha256. */
export async function escribirEvidencia(dir: string, a: Aprobacion, solicitudId: string): Promise<{ txt: string; pdf: string; sha256: string }> {
  const contenido = contenidoEvidencia(a)
  const hash = sha256(contenido)
  await mkdir(dir, { recursive: true })
  const txt = join(dir, "aprobacion.txt")
  const pdf = join(dir, "aprobacion.pdf")
  await writeFile(txt, `${contenido}\n---\nSHA-256 del contenido: ${hash}\n`, "utf8")
  await escribirPdf(pdf, `Evidencia de aprobación · ${solicitudId}`, contenido, hash)
  return { txt, pdf, sha256: hash }
}

/** CSV mínimo (RFC 4180): comillas dobles para campos con coma, comillas o saltos de línea. */

export function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let entreComillas = false
  const contenido = texto.replace(/^﻿/, "")
  for (let i = 0; i < contenido.length; i++) {
    const c = contenido[i]
    if (entreComillas) {
      if (c === '"' && contenido[i + 1] === '"') {
        campo += '"'
        i++
      } else if (c === '"') entreComillas = false
      else campo += c
    } else if (c === '"') entreComillas = true
    else if (c === ",") {
      fila.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && contenido[i + 1] === "\n") i++
      fila.push(campo)
      if (fila.some((v) => v !== "")) filas.push(fila)
      fila = []
      campo = ""
    } else campo += c
  }
  fila.push(campo)
  if (fila.some((v) => v !== "")) filas.push(fila)
  return filas
}

function celda(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function serializarCsv(filas: string[][]): string {
  return `${filas.map((f) => f.map(celda).join(",")).join("\n")}\n`
}

import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { parsearCsv, serializarCsv } from "./csv.ts"
import { rutas } from "./rutas.ts"
import { ErrorHerramienta, type ContextoHerramienta } from "./tipos.ts"

export const COLUMNAS = [
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
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
] as const
export type Columna = (typeof COLUMNAS)[number]
export type FilaMaestro = Record<Columna, string>

const existe = (ruta: string) => stat(ruta).then(() => true, () => false)

/** RN6: el fixture es de solo lectura; la primera ejecución lo copia a out/sharepoint/. */
export async function asegurarMaestro(ctx: ContextoHerramienta): Promise<string> {
  const r = rutas(ctx)
  if (!(await existe(r.maestro))) {
    await mkdir(r.sharepoint, { recursive: true })
    await copyFile(r.maestroFixture, r.maestro)
  }
  return r.maestro
}

function aFilas(texto: string, origen: string): FilaMaestro[] {
  const [encabezado, ...datos] = parsearCsv(texto)
  if (!encabezado || COLUMNAS.some((c, i) => encabezado[i] !== c)) {
    throw new ErrorHerramienta(`El maestro (${origen}) no tiene los encabezados esperados.`)
  }
  return datos.map((fila) => Object.fromEntries(COLUMNAS.map((c, i) => [c, fila[i] ?? ""])) as FilaMaestro)
}

/** Lee el maestro vigente: la copia en out/ si existe, si no el fixture (sin copiarlo). */
export async function leerMaestro(ctx: ContextoHerramienta): Promise<FilaMaestro[]> {
  const r = rutas(ctx)
  const ruta = (await existe(r.maestro)) ? r.maestro : r.maestroFixture
  return aFilas(await readFile(ruta, "utf8"), ruta.endsWith("fixtures") ? "fixture" : "maestro-contratos.csv")
}

export async function escribirMaestro(ctx: ContextoHerramienta, filas: FilaMaestro[]): Promise<void> {
  await asegurarMaestro(ctx)
  await writeFile(rutas(ctx).maestro, serializarCsv([[...COLUMNAS], ...filas.map((f) => COLUMNAS.map((c) => f[c]))]), "utf8")
}

export type EntradaHistorial = {
  ts: string
  id_contrato: string | null
  accion: string
  cambios: Record<string, unknown>
  mensaje_id: string
}

export async function agregarHistorial(ctx: ContextoHerramienta, entrada: EntradaHistorial): Promise<void> {
  await mkdir(rutas(ctx).sharepoint, { recursive: true })
  await appendFile(rutas(ctx).historial, `${JSON.stringify(entrada)}\n`, "utf8")
}

export async function leerHistorial(ctx: ContextoHerramienta): Promise<EntradaHistorial[]> {
  const texto = await readFile(rutas(ctx).historial, "utf8").catch(() => "")
  return texto
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as EntradaHistorial]
      } catch {
        return []
      }
    })
}

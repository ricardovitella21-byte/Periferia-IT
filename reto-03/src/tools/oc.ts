import { mkdir, writeFile } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"
import ExcelJS from "exceljs"
import { z } from "zod"
import { SapMock } from "../sap/mock.ts"
import { registrarIntento } from "./lib/control.ts"
import { validarControles, type Validacion } from "./lib/controles.ts"
import { ejecutar } from "./lib/ejecucion.ts"
import { contenidoEvidencia, escribirEvidencia, sha256 } from "./lib/evidencia.ts"
import { cargarMaestros } from "./lib/maestros.ts"
import { leerPaquete, listarSolicitudes, type Paquete } from "./lib/paquete.ts"
import { construirOrden, diferenciasOrden, OrdenCompraSchema } from "./lib/payload.ts"
import { relativa, rutas } from "./lib/rutas.ts"
import { pesos } from "./lib/texto.ts"
import { definirHerramienta, ErrorHerramienta, type ContextoHerramienta } from "./lib/tipos.ts"

// Cada export de este archivo es una herramienta: el modelo la ve como `oc_<export>`.
// Las funciones auxiliares viven en ./lib y ../sap para que este módulo exporte solo herramientas.

const caso = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Usa el nombre de la carpeta, por ejemplo sol-001")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-004")

const paqueteArg = z
  .looseObject({ solicitud: z.looseObject({ solicitud_id: z.string() }).describe("Solicitud normalizada") })
  .describe("Paquete normalizado devuelto por oc_leer_paquete; los controles se aplican sobre los documentos originales")

const derivadosArg = z
  .record(z.string(), z.looseObject({ valor: z.string() }))
  .optional()
  .describe("Derivados devueltos por oc_validar (indicador_iva, condiciones_pago)")

/** Lee el paquete y los maestros y aplica los controles: siempre desde los documentos, no desde lo que diga el modelo. */
async function evaluar(ctx: ContextoHerramienta, nombre: string): Promise<{ paquete: Paquete; validacion: Validacion }> {
  const [paquete, maestros] = await Promise.all([leerPaquete(ctx, nombre), cargarMaestros(ctx)])
  return { paquete, validacion: validarControles(paquete, maestros) }
}

/** Avisa si el paquete que envía el modelo difiere de los documentos (se usan los documentos). */
function avisosPaquete(enviado: z.infer<typeof paqueteArg>, real: Paquete): string[] {
  const s = enviado.solicitud as Record<string, unknown>
  const r = real.solicitud as Record<string, unknown>
  const distintos = Object.keys(r).filter((k) => k in s && JSON.stringify(s[k]) !== JSON.stringify(r[k]))
  return distintos.length ? [`El paquete enviado difiere de los documentos en: ${distintos.join(", ")}. Se usaron los documentos.`] : []
}

function sha256Evidencia(p: Paquete): string {
  if (!p.aprobacion) throw new ErrorHerramienta("No hay correo de aprobación: no se puede generar la evidencia.")
  return sha256(contenidoEvidencia(p.aprobacion))
}

const codigos = (h: Array<{ codigo: string }>) => h.map((x) => x.codigo)

export const listar_solicitudes = definirHerramienta({
  description: "Lista las solicitudes de orden de compra disponibles con su id, solicitante, proveedor y valor total.",
  args: {},
  async execute(_args, ctx) {
    return ejecutar("oc_listar_solicitudes", ctx, null, async () => {
      const solicitudes = await Promise.all(
        (await listarSolicitudes(ctx)).map(async (nombre) => {
          try {
            const { solicitud } = await leerPaquete(ctx, nombre)
            return { caso: nombre, solicitud_id: solicitud.solicitud_id, solicitante: solicitud.solicitante, proveedor: solicitud.proveedor_nombre, valor_total: solicitud.valor_total, moneda: solicitud.moneda }
          } catch (e) {
            return { caso: nombre, error: e instanceof Error ? e.message : String(e) }
          }
        }),
      )
      return { data: { solicitudes }, resumen: `${solicitudes.length} solicitudes` }
    })
  },
})

export const leer_paquete = definirHerramienta({
  description:
    "Lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe) y lo devuelve normalizado; lo que falte queda en null y se lista en faltantes.",
  args: { caso },
  async execute(args, ctx) {
    return ejecutar("oc_leer_paquete", ctx, args.caso, async () => {
      const p = await leerPaquete(ctx, args.caso)
      return {
        data: p,
        resumen: `${p.solicitud.solicitud_id} · ${p.solicitud.proveedor_nombre} · ${pesos(p.solicitud.valor_total, p.solicitud.moneda)}${p.factura ? " · trae factura" : ""}${p.faltantes.length ? ` · faltan: ${p.faltantes.join(", ")}` : ""}`,
      }
    })
  },
})

export const validar = definirHerramienta({
  description:
    "Aplica los controles RC1 a RC10 a la solicitud (proveedor, aprobador y tope, subárea, cotización, IVA, condiciones de pago, factura retroactiva, fechas y aritmética) y devuelve apta, bloqueos, confirmaciones, derivados y retroactiva.",
  args: { caso, paquete: paqueteArg },
  async execute(args, ctx) {
    return ejecutar("oc_validar", ctx, args.caso, async () => {
      const { paquete, validacion: v } = await evaluar(ctx, args.caso)
      const data = {
        solicitud_id: paquete.solicitud.solicitud_id,
        apta: v.apta,
        bloqueos: v.bloqueos,
        confirmaciones: v.confirmaciones,
        derivados: v.derivados,
        retroactiva: v.retroactiva,
        advertencias: [...v.advertencias, ...avisosPaquete(args.paquete, paquete)],
      }
      return {
        data,
        resumen: `${v.apta ? "apta" : "NO apta"}${v.bloqueos.length ? ` · bloqueos: ${codigos(v.bloqueos).join(", ")}` : ""}${v.confirmaciones.length ? ` · confirmar: ${codigos(v.confirmaciones).join(", ")}` : ""}${v.retroactiva ? " · retroactiva" : ""}`,
      }
    })
  },
})

export const construir_payload = definirHerramienta({
  description:
    "Construye la orden de compra exactamente como quedaría en SAP (proveedor, condiciones de pago, aprobador, posiciones, excepciones), validada con zod, y guarda en out/<caso>/trazabilidad.json la fuente de cada valor.",
  args: { caso, paquete: paqueteArg, derivados: derivadosArg },
  async execute(args, ctx) {
    return ejecutar("oc_construir_payload", ctx, args.caso, async () => {
      const { paquete, validacion: v } = await evaluar(ctx, args.caso)
      const { orden, trazabilidad } = construirOrden(paquete, v, sha256Evidencia(paquete))
      const advertencias = avisosPaquete(args.paquete, paquete)
      for (const [clave, d] of Object.entries(args.derivados ?? {})) {
        const real = v.derivados[clave as keyof typeof v.derivados]
        if (!real || real.valor !== d.valor) advertencias.push(`El derivado ${clave}=${d.valor} no coincide con los maestros${real ? ` (${real.valor})` : ""}; se usaron los maestros.`)
      }
      const dir = rutas(ctx).outCaso(args.caso)
      await mkdir(dir, { recursive: true })
      const ruta = join(dir, "trazabilidad.json")
      await writeFile(ruta, JSON.stringify({ solicitud_id: orden.referencia.solicitud_id, generado: new Date().toISOString(), campos: trazabilidad }, null, 2), "utf8")
      await writeFile(join(dir, "payload.json"), JSON.stringify(orden, null, 2), "utf8")
      return {
        data: { orden, ruta_trazabilidad: relativa(ctx, ruta), confirmaciones_pendientes: codigos(v.confirmaciones), advertencias },
        resumen: `${orden.proveedor.nombre} · ${orden.posiciones.length} posición · ${pesos(orden.posiciones[0]?.precio_unitario ?? 0, orden.moneda)} × ${orden.posiciones[0]?.cantidad ?? 0} ${orden.posiciones[0]?.unidad ?? ""}`,
      }
    })
  },
})

export const generar_evidencia = definirHerramienta({
  description: "Genera la evidencia de aprobación de la OC: out/<caso>/aprobacion.txt y aprobacion.pdf con encabezados, cuerpo y el sha256 del contenido.",
  args: { caso },
  async execute(args, ctx) {
    return ejecutar("oc_generar_evidencia", ctx, args.caso, async () => {
      const p = await leerPaquete(ctx, args.caso)
      if (!p.aprobacion) throw new ErrorHerramienta("No hay correo de aprobación: pide al solicitante que reenvíe la aprobación del líder.")
      const e = await escribirEvidencia(rutas(ctx).outCaso(args.caso), p.aprobacion, p.solicitud.solicitud_id)
      return { data: { ruta: relativa(ctx, e.txt), ruta_pdf: relativa(ctx, e.pdf), sha256: e.sha256 }, resumen: `sha256 ${e.sha256.slice(0, 12)}…` }
    })
  },
})

type ResultadoCrear = {
  numero_oc: string
  fecha: string
  idempotente: boolean
  retroactiva?: boolean
  ruta_evidencia?: string
  ruta_evidencia_pdf?: string
}

export const crear = definirHerramienta({
  description:
    "Crea la orden de compra en el SAP simulado y devuelve su número; solo si es apta y, si tiene confirmaciones pendientes, con confirmado=true dado por la analista. Repetir la misma solicitud devuelve el número existente. Cada intento queda en out/control.csv.",
  args: {
    caso,
    payload: OrdenCompraSchema.optional().describe("La orden devuelta por oc_construir_payload, sin modificar (no aplica si la solicitud tiene bloqueos)"),
    confirmado: z.boolean().optional().describe("true solo si la analista confirmó explícitamente las confirmaciones pendientes en su último mensaje"),
  },
  async execute(args, ctx) {
    return ejecutar<ResultadoCrear>("oc_crear", ctx, args.caso, async () => {
      const { paquete, validacion: v } = await evaluar(ctx, args.caso)
      const sap = new SapMock(ctx)
      const id = paquete.solicitud.solicitud_id
      const base = { solicitud_id: id, retroactiva: v.retroactiva, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones) }

      // Idempotencia: la misma solicitud nunca genera una segunda OC.
      const existente = await sap.buscarOrdenPorReferencia(id)
      if (existente) {
        await registrarIntento(ctx, { ...base, resultado: "existente", numero_oc: existente.numero_oc })
        return { data: { numero_oc: existente.numero_oc, fecha: (await sap.fechaDe(existente.numero_oc)) ?? "", idempotente: true }, resumen: `ya existía la OC ${existente.numero_oc}` }
      }
      if (!v.apta) {
        await registrarIntento(ctx, { ...base, resultado: "bloqueada", numero_oc: "" })
        throw new ErrorHerramienta(`No se crea la OC: ${v.bloqueos.map((b) => `${b.codigo} ${b.detalle} Acción: ${b.accion_sugerida}`).join(" | ")}`)
      }
      if (v.confirmaciones.length > 0 && args.confirmado !== true) {
        await registrarIntento(ctx, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
        throw new ErrorHerramienta(`requiere confirmación: ${v.confirmaciones.map((c) => `${c.codigo} ${c.detalle}`).join(" | ")}`)
      }

      // El payload debe ser exactamente el que construyen las herramientas (CA2).
      const { orden } = construirOrden(paquete, v, sha256Evidencia(paquete))
      if (!args.payload) throw new ErrorHerramienta("Falta el payload: llama primero oc_construir_payload y pásalo sin modificar.")
      const enviado = OrdenCompraSchema.parse(args.payload)
      const distintos = diferenciasOrden(enviado, orden)
      if (distintos.length) throw new ErrorHerramienta(`El payload no coincide con el que construye oc_construir_payload (campos: ${distintos.join(", ")}). Vuelve a construirlo sin modificarlo.`)

      if (!paquete.aprobacion) throw new ErrorHerramienta("Falta el correo de aprobación.")
      const evidencia = await escribirEvidencia(rutas(ctx).outCaso(args.caso), paquete.aprobacion, id)
      const quien = `analista (sesión ${ctx.sessionId})`
      const final = { ...orden, excepciones: orden.excepciones.map((e) => (e.confirmado_por === null ? { ...e, confirmado_por: quien } : e)) }
      const { numero_oc, fecha } = await sap.crearOrden(final)
      await registrarIntento(ctx, { ...base, resultado: "creada", numero_oc })
      return {
        data: { numero_oc, fecha, idempotente: false, retroactiva: v.retroactiva, ruta_evidencia: relativa(ctx, evidencia.txt), ruta_evidencia_pdf: relativa(ctx, evidencia.pdf) },
        resumen: `OC ${numero_oc} creada${v.retroactiva ? " (retroactiva)" : ""}`,
      }
    })
  },
})

export const leer_excel = definirHerramienta({
  description: "Lee un archivo .xlsx real (por ejemplo una solicitud sin normalizar) dentro de fixtures/ u out/ y devuelve sus filas con los encabezados de la primera fila.",
  args: {
    ruta: z.string().min(1).describe("Ruta relativa al proyecto, dentro de fixtures/ o out/, terminada en .xlsx"),
    hoja: z.string().optional().describe("Nombre de la hoja; por defecto la primera"),
  },
  async execute(args, ctx) {
    return ejecutar("oc_leer_excel", ctx, null, async () => {
      const raiz = resolve(ctx.directory)
      const destino = resolve(raiz, args.ruta)
      const permitida = [join(raiz, "fixtures"), join(raiz, "out")].some((b) => destino.startsWith(b + sep))
      if (!permitida || extname(destino).toLowerCase() !== ".xlsx") throw new ErrorHerramienta("Solo se pueden leer archivos .xlsx dentro de fixtures/ u out/.")
      const libro = new ExcelJS.Workbook()
      try {
        await libro.xlsx.readFile(destino)
      } catch {
        throw new ErrorHerramienta(`No se pudo leer el Excel "${args.ruta}" (¿existe y es un .xlsx válido?).`)
      }
      const hoja = args.hoja ? libro.getWorksheet(args.hoja) : libro.worksheets[0]
      if (!hoja) throw new ErrorHerramienta(`La hoja "${args.hoja}" no existe.`)
      const valor = (v: ExcelJS.CellValue): string | number | boolean | null => {
        if (v === null || v === undefined) return null
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        if (typeof v === "object" && "result" in v) return valor(v.result as ExcelJS.CellValue)
        if (typeof v === "object" && "text" in v) return String(v.text)
        return String(v)
      }
      const encabezados = (hoja.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => String(valor(v) ?? ""))
      const filas: Array<Record<string, string | number | boolean | null>> = []
      hoja.eachRow((fila, n) => {
        if (n === 1) return
        const celdas = (fila.values as ExcelJS.CellValue[]).slice(1)
        filas.push(Object.fromEntries(encabezados.map((e, i) => [e || `columna_${i + 1}`, valor(celdas[i])])))
      })
      return { data: { hoja: hoja.name, encabezados, filas }, resumen: `${filas.length} filas en "${hoja.name}"` }
    })
  },
})

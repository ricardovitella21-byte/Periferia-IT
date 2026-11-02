import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, extname, join, resolve, sep } from "node:path"
import { z } from "zod"
import {
  adjuntoContractual,
  cargarComerciales,
  leerAdjuntos,
  leerCorreo,
  leerProcesados,
  leerTextoArchivo,
  listarMensajes,
  type Procesados,
} from "./lib/buzon.ts"
import { alertasMd, calcularAlertas } from "./lib/alertas.ts"
import { ejecutar } from "./lib/ejecucion.ts"
import { CAMPOS, extraerContrato, type Extraccion } from "./lib/extraccion.ts"
import { esFechaIso, fechaReferencia } from "./lib/fechas.ts"
import { agregarHistorial, asegurarMaestro, escribirMaestro, leerHistorial, leerMaestro } from "./lib/maestro.ts"
import { reglas } from "./lib/reglas.ts"
import { relativa, rutas } from "./lib/rutas.ts"
import { definirHerramienta, ErrorHerramienta, type ContextoHerramienta } from "./lib/tipos.ts"
import { rutaSharepoint, validarContrato, type ContratoEnviado } from "./lib/validacion.ts"

// Cada export de este archivo es una herramienta: el modelo la ve como `contratos_<export>`.
// Las funciones auxiliares viven en ./lib para que este módulo exporte solo herramientas.

const mensajeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Usa el id del mensaje, por ejemplo msg-001")
  .describe("Id del mensaje en fixtures/reto-02/buzon/, por ejemplo msg-001")

const fecha = z.string().refine(esFechaIso, "Usa el formato YYYY-MM-DD")

const contratoArg = z
  .object({
    id_contrato: z.string().nullable().optional().describe("Número del contrato tal como aparece en el documento"),
    cliente: z.string().nullable().optional().describe("Razón social de la contraparte"),
    nit_cliente: z.string().nullable().optional().describe("Identificador tributario sin dígito de verificación ni puntos"),
    pais: z.string().nullable().optional().describe("CO, EC, PE, PA o HN"),
    objeto: z.string().nullable().optional().describe("Objeto del contrato, máximo 200 caracteres"),
    valor: z.number().nonnegative().nullable().optional().describe("Valor sin separadores; 0 si es por demanda o marco"),
    valor_indeterminado: z.boolean().optional().describe("true si el contrato no tiene valor determinado"),
    moneda: z.string().nullable().optional().describe("COP, USD, PEN, PAB o HNL"),
    fecha_inicio: fecha.nullable().optional().describe("YYYY-MM-DD"),
    fecha_fin: fecha.nullable().optional().describe("YYYY-MM-DD"),
    requiere_poliza: z.boolean().nullable().optional().describe("Si el contrato exige póliza"),
    tipo_poliza: z.string().nullable().optional().describe("Tipos separados por ;"),
    estado_poliza: z.enum(["vigente", "pendiente", "vencida", "no_aplica"]).nullable().optional().describe("Estado de la póliza"),
    comercial: z.string().nullable().optional().describe("Comercial resuelto desde comerciales.json"),
  })
  .describe("El objeto `contrato` que devolvió contratos_extraer, con las correcciones que la analista haya confirmado")

/** Validación de dominio que zod no cubre: monedas y países conocidos (HU-6). */
function validarValores(contrato: ContratoEnviado): void {
  if (contrato.moneda && !reglas.monedas.includes(contrato.moneda)) {
    throw new ErrorHerramienta(`Moneda desconocida "${contrato.moneda}". Monedas válidas: ${reglas.monedas.join(", ")}.`)
  }
  if (contrato.pais && !reglas.paises.includes(contrato.pais)) {
    throw new ErrorHerramienta(`País desconocido "${contrato.pais}". Países válidos: ${reglas.paises.join(", ")}.`)
  }
  for (const campo of ["fecha_inicio", "fecha_fin"] as const) {
    const valor = contrato[campo]
    if (valor && !esFechaIso(valor)) throw new ErrorHerramienta(`Fecha inválida en ${campo}: "${valor}". Usa YYYY-MM-DD.`)
  }
}

async function extraccionDe(ctx: ContextoHerramienta, id: string): Promise<{ ext: Extraccion; rutaAdjunto: string | null }> {
  const correo = await leerCorreo(ctx, id)
  const [comerciales, { adjuntos, problemas }] = await Promise.all([cargarComerciales(ctx), leerAdjuntos(ctx, correo)])
  const adjunto = adjuntoContractual(adjuntos) ?? adjuntos[0]
  const ext = extraerContrato(correo, adjunto, comerciales)
  ext.advertencias.push(...problemas)
  return { ext, rutaAdjunto: adjunto ? join(rutas(ctx).mensaje(id), adjunto.nombre) : null }
}

async function marcarProcesado(ctx: ContextoHerramienta, id: string, entrada: Omit<Procesados[string], "ts">): Promise<void> {
  const procesados = await leerProcesados(ctx)
  procesados[id] = { ...entrada, ts: new Date().toISOString() }
  await mkdir(rutas(ctx).out, { recursive: true })
  await writeFile(rutas(ctx).procesados, JSON.stringify(procesados, null, 2), "utf8")
}

async function archivar(ctx: ContextoHerramienta, origen: string, rutaRelativa: string): Promise<string> {
  const destino = join(rutas(ctx).sharepoint, ...rutaRelativa.split("/"))
  await mkdir(dirname(destino), { recursive: true })
  await copyFile(origen, destino)
  return relativa(ctx, destino)
}

export const leer_buzon = definirHerramienta({
  description:
    "Lista los mensajes del buzón de contratos que aún no se han procesado, con remitente, asunto, adjuntos y si traen contrato; los que no traen contrato salen como rechazados con motivo.",
  args: {},
  async execute(_args, ctx) {
    return ejecutar("contratos_leer_buzon", ctx, null, async () => {
      const procesados = await leerProcesados(ctx)
      const comerciales = await cargarComerciales(ctx)
      const todos = await listarMensajes(ctx)
      const mensajes = await Promise.all(
        todos
          .filter((id) => !procesados[id])
          .map(async (id) => {
            try {
              const correo = await leerCorreo(ctx, id)
              const { adjuntos, problemas } = await leerAdjuntos(ctx, correo)
              const contractual = adjuntoContractual(adjuntos)
              const comercial = comerciales.find((c) => c.email.toLowerCase() === correo.de.toLowerCase())
              return {
                id,
                de: correo.de,
                comercial: comercial?.nombre ?? null,
                asunto: correo.asunto,
                fecha: correo.fecha,
                adjuntos: correo.adjuntos,
                tiene_contrato: Boolean(contractual),
                tipo_documento: contractual?.tipo ?? adjuntos[0]?.tipo ?? "sin_adjunto",
                ...(contractual
                  ? {}
                  : {
                      clasificacion: "rechazado" as const,
                      motivo: adjuntos[0] ? `El adjunto no es un contrato: "${adjuntos[0].titulo}".` : correo.adjuntos.length ? `No se pudo leer el adjunto (${problemas.join("; ")}).` : "El correo no trae adjuntos.",
                    }),
              }
            } catch (e) {
              return { id, error: e instanceof Error ? e.message : String(e), tiene_contrato: false }
            }
          }),
      )
      return {
        data: { mensajes, pendientes: mensajes.length, procesados: Object.keys(procesados).length },
        resumen: `${mensajes.length} pendientes (${mensajes.filter((m) => m.tiene_contrato).length} con contrato) · ${Object.keys(procesados).length} ya procesados`,
      }
    })
  },
})

export const extraer = definirHerramienta({
  description:
    "Extrae del documento adjunto de un mensaje los datos del contrato (número, cliente, NIT, país, objeto, valor, moneda, fechas, póliza, comercial) con una confianza entre 0 y 1 por campo; lo ausente queda null con confianza 0.",
  args: { mensaje_id: mensajeId },
  async execute(args, ctx) {
    return ejecutar("contratos_extraer", ctx, args.mensaje_id, async () => {
      const { ext } = await extraccionDe(ctx, args.mensaje_id)
      const baja = CAMPOS.filter((c) => ext.confianza[c] < reglas.umbral_confianza && !(ext.tipo_documento === "otrosi" && ext.contrato[c] === null))
      return {
        data: { ...ext, campos_baja_confianza: baja },
        resumen: `${ext.tipo_documento}${ext.contrato.id_contrato ? ` ${ext.contrato.id_contrato}` : ""} · ${baja.length ? `baja confianza: ${baja.join(", ")}` : "todos los campos con confianza alta"}`,
      }
    })
  },
})

export const validar = definirHerramienta({
  description:
    "Clasifica un contrato extraído como nuevo, actualizacion, duplicado o rechazado comparándolo con el maestro, y lista los campos que requieren revisión humana (confianza < 0.8 o conflictos).",
  args: { mensaje_id: mensajeId, contrato: contratoArg },
  async execute(args, ctx) {
    return ejecutar("contratos_validar", ctx, args.mensaje_id, async () => {
      validarValores(args.contrato)
      const { ext } = await extraccionDe(ctx, args.mensaje_id)
      const v = validarContrato(ext, args.contrato, await leerMaestro(ctx), fechaReferencia())
      const { fila, ...resto } = v
      return {
        data: { ...resto, contrato_a_registrar: fila },
        resumen: `${v.clasificacion}${v.id_contrato ? ` ${v.id_contrato}` : ""}${v.requiere_revision.length ? ` · requiere revisión: ${v.requiere_revision.join(", ")}` : ""}`,
      }
    })
  },
})

export const registrar = definirHerramienta({
  description:
    "Registra el contrato validado: inserta o actualiza la fila del maestro en out/sharepoint, archiva el documento en Contratos/<año>/<cliente>/, agrega el historial y marca el mensaje como procesado; si hay campos en revisión exige confirmado=true.",
  args: {
    mensaje_id: mensajeId,
    contrato: contratoArg,
    confirmado: z.boolean().optional().describe("true solo si la analista confirmó explícitamente los campos en revisión en su último mensaje"),
  },
  async execute(args, ctx) {
    return ejecutar("contratos_registrar", ctx, args.mensaje_id, async () => {
      const procesados = await leerProcesados(ctx)
      const previo = procesados[args.mensaje_id]
      if (previo) throw new ErrorHerramienta(`El mensaje ${args.mensaje_id} ya fue procesado (${previo.clasificacion}, ${previo.accion}).`)
      validarValores(args.contrato)
      // El valor final siempre pasa por la misma validación (re-extrae del documento).
      const { ext, rutaAdjunto } = await extraccionDe(ctx, args.mensaje_id)
      const maestro = await leerMaestro(ctx)
      const v = validarContrato(ext, args.contrato, maestro, fechaReferencia())
      const ts = new Date().toISOString()

      if (v.clasificacion === "rechazado" || v.clasificacion === "duplicado") {
        await agregarHistorial(ctx, { ts, id_contrato: v.id_contrato, accion: v.clasificacion, cambios: {}, mensaje_id: args.mensaje_id })
        await marcarProcesado(ctx, args.mensaje_id, { clasificacion: v.clasificacion, accion: "sin_escritura", id_contrato: v.id_contrato })
        return {
          data: { id_contrato: v.id_contrato, accion: v.clasificacion, ruta_archivo: null, motivo: v.motivo },
          resumen: `${v.clasificacion}: sin escritura en el maestro`,
        }
      }
      if (v.requiere_revision.length > 0 && args.confirmado !== true) {
        throw new ErrorHerramienta(`requiere revisión: ${v.requiere_revision.join(", ")}`)
      }
      if (!v.fila || !v.id_contrato || !rutaAdjunto) throw new ErrorHerramienta("No hay datos suficientes para registrar.")
      await asegurarMaestro(ctx)
      const confirmado = v.requiere_revision.length > 0

      if (v.clasificacion === "nuevo") {
        const ruta = await archivar(ctx, rutaAdjunto, v.fila.ruta_sharepoint)
        await escribirMaestro(ctx, [...maestro, v.fila])
        await agregarHistorial(ctx, { ts, id_contrato: v.id_contrato, accion: "nuevo", cambios: v.fila, mensaje_id: args.mensaje_id, ...(confirmado ? { confirmado_por_analista: true } : {}) })
        await marcarProcesado(ctx, args.mensaje_id, { clasificacion: "nuevo", accion: "insertado", id_contrato: v.id_contrato })
        return { data: { id_contrato: v.id_contrato, accion: "insertado", ruta_archivo: ruta, campos_confirmados: v.requiere_revision }, resumen: `insertado ${v.id_contrato} → ${ruta}` }
      }

      const fila = v.fila
      const sufijo = ext.tipo_documento === "otrosi" ? `-otrosi-${ext.numero_otrosi ?? "1"}` : `-actualizacion-${args.mensaje_id}`
      const ruta = await archivar(ctx, rutaAdjunto, rutaSharepoint(fila.cliente, fila.id_contrato, fila.fecha_inicio.slice(0, 4) || fechaReferencia().slice(0, 4), ext.adjunto, sufijo))
      await escribirMaestro(ctx, maestro.map((f) => (f.id_contrato === fila.id_contrato ? fila : f)))
      const cambios = Object.fromEntries(v.diferencias.map((d) => [d.campo, { antes: d.antes, despues: d.despues }]))
      await agregarHistorial(ctx, { ts, id_contrato: v.id_contrato, accion: "actualizacion", cambios: { ...cambios, documento: ruta }, mensaje_id: args.mensaje_id, ...(confirmado ? { confirmado_por_analista: true } : {}) })
      await marcarProcesado(ctx, args.mensaje_id, { clasificacion: "actualizacion", accion: "actualizado", id_contrato: v.id_contrato })
      return {
        data: { id_contrato: v.id_contrato, accion: "actualizado", ruta_archivo: ruta, cambios },
        resumen: `actualizado ${v.id_contrato}: ${v.diferencias.map((d) => d.campo).join(", ") || "sin cambios"}`,
      }
    })
  },
})

export const alertas = definirHerramienta({
  description:
    "Genera out/alertas.md con los contratos que vencen en 60 días o menos, las pólizas exigidas que no están vigentes y los contratos registrados desde el corte del 2026-05-30, según la fecha de referencia dada.",
  args: { hoy: fecha.describe("Fecha de referencia para las alertas, YYYY-MM-DD") },
  async execute(args, ctx) {
    return ejecutar("contratos_alertas", ctx, null, async () => {
      if (!esFechaIso(args.hoy)) throw new ErrorHerramienta(`Fecha inválida: "${args.hoy}". Usa YYYY-MM-DD.`)
      const datos = calcularAlertas(await leerMaestro(ctx), await leerHistorial(ctx), args.hoy)
      await mkdir(rutas(ctx).out, { recursive: true })
      await writeFile(rutas(ctx).alertas, alertasMd(datos), "utf8")
      return {
        data: { ruta: relativa(ctx, rutas(ctx).alertas), ...datos },
        resumen: `${datos.vencen.length} vencen ≤ ${reglas.dias_alerta_vencimiento} días · ${datos.polizas_pendientes.length} pólizas pendientes · ${datos.registrados_desde_corte.length} registrados desde el corte`,
      }
    })
  },
})

export const leer_pdf = definirHerramienta({
  description: "Extrae el texto de un PDF nativo (no escaneado) del buzón o de out/, para leer contratos que lleguen en PDF.",
  args: { ruta: z.string().min(1).describe("Ruta relativa al proyecto, dentro de fixtures/ o out/, terminada en .pdf") },
  async execute(args, ctx) {
    return ejecutar("contratos_leer_pdf", ctx, null, async () => {
      const raiz = resolve(ctx.directory)
      const destino = resolve(raiz, args.ruta)
      const permitida = [join(raiz, "fixtures"), join(raiz, "out")].some((base) => destino.startsWith(base + sep))
      if (!permitida || extname(destino).toLowerCase() !== ".pdf") throw new ErrorHerramienta("Solo se pueden leer archivos .pdf dentro de fixtures/ o out/.")
      let texto: string
      try {
        texto = await leerTextoArchivo(destino)
      } catch {
        throw new ErrorHerramienta(`No se pudo leer el PDF "${args.ruta}" (¿existe y tiene texto nativo?).`)
      }
      if (!texto.trim()) throw new ErrorHerramienta("El PDF no tiene texto extraíble (puede ser escaneado; requiere OCR).")
      return { data: { ruta: args.ruta, texto, caracteres: texto.length }, resumen: `${texto.length} caracteres` }
    })
  },
})

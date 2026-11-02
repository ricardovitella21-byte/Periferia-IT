import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { ejecutar } from "./lib/ejecucion.ts"
import { fechaReferencia, esFechaIso, hoyIso } from "./lib/fechas.ts"
import { cargarCaso, cargarGlosario, cargarIndiceSoportes, cargarMaestro, listarCasos, type CasoCargado } from "./lib/fixtures.ts"
import { escribirPdf, escribirValoresPortal, escribirXlsx, resolverCampos, type CampoResuelto, type Encabezado } from "./lib/formularios.ts"
import { identificadoresPorConfirmar, mapearCampos, type ResultadoMapeo } from "./lib/mapeo.ts"
import { borradorCorreoMd, bloqueosDeFirma, checklistMd, evaluarSoportes } from "./lib/paquete.ts"
import { identificadorDePais, nombrePais, nombreSoporte, reglas } from "./lib/reglas.ts"
import { relativa, rutas } from "./lib/rutas.ts"
import { definirHerramienta, ErrorHerramienta, type ContextoHerramienta } from "./lib/tipos.ts"

// Cada export de este archivo es una herramienta: el modelo la ve como `proveedor_<export>`.
// Las funciones auxiliares viven en ./lib para que este módulo exporte solo herramientas.

const caso = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Usa el nombre de carpeta del caso, en minúsculas y con guiones")
  .describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo ec-corp-andina")

type Formato = "xlsx" | "pdf" | "portal"
const NOMBRES_FORMULARIO: Record<Formato, string> = { xlsx: "formulario.xlsx", pdf: "formulario.pdf", portal: "valores-portal.md" }

function formatoDe(cargado: CasoCargado): Formato {
  const formato = cargado.solicitud.formato
  if (formato === "xlsx" || formato === "pdf" || formato === "portal") return formato
  throw new ErrorHerramienta(
    `Formato no soportado: "${formato}". Formatos conocidos: ${reglas.formatos_conocidos.join(", ")}. Se puede seguir con el reporte de faltantes y el paquete de soportes.`,
  )
}

/** Mapeo determinista del caso: misma entrada, mismo resultado. Es la única fuente de valores. */
async function mapeoDelCaso(ctx: ContextoHerramienta, nombre: string) {
  const cargado = await cargarCaso(ctx, nombre)
  const [maestro, glosario] = await Promise.all([cargarMaestro(ctx), cargarGlosario(ctx)])
  const campos = cargado.plantilla?.campos ?? []
  const mapeo = mapearCampos(campos.map((c) => c.etiqueta), cargado.solicitud.pais, maestro, glosario)
  return { cargado, maestro, mapeo, campos: resolverCampos(campos, mapeo) }
}

function urlEnTexto(texto: string): string | null {
  return texto.match(/https?:\/\/[^\s)]+/)?.[0]?.replace(/[.,]$/, "") ?? null
}

async function escribirFormulario(ctx: ContextoHerramienta, nombre: string, cargado: CasoCargado, campos: CampoResuelto[]) {
  const formato = formatoDe(cargado)
  if (campos.length === 0) throw new ErrorHerramienta("La plantilla no tiene campos legibles: no se puede generar el formulario.")
  const dir = rutas(ctx).outCaso(nombre)
  await mkdir(dir, { recursive: true })
  const ruta = join(dir, NOMBRES_FORMULARIO[formato])
  const encabezado: Encabezado = { cliente: cargado.solicitud.cliente, caso: nombre, asunto: cargado.solicitud.asunto, fecha: hoyIso() }
  if (formato === "xlsx") await escribirXlsx(ruta, campos, encabezado)
  else if (formato === "pdf") await escribirPdf(ruta, campos, encabezado)
  else await escribirValoresPortal(ruta, campos, encabezado, urlEnTexto(cargado.solicitud.cuerpo), cargado.soportesExigidos.map(nombreSoporte))
  return { ruta, formato }
}

async function formularioExistente(ctx: ContextoHerramienta, nombre: string): Promise<string | null> {
  for (const archivo of Object.values(NOMBRES_FORMULARIO)) {
    const ruta = join(rutas(ctx).outCaso(nombre), archivo)
    if (await stat(ruta).then(() => true, () => false)) return ruta
  }
  return null
}

export const listar_casos = definirHerramienta({
  description: "Lista los casos de registro como proveedor disponibles en la carpeta de entrada, con cliente, país y formato pedido.",
  args: {},
  async execute(_args, ctx) {
    return ejecutar("proveedor_listar_casos", ctx, null, async () => {
      const casos = await Promise.all(
        (await listarCasos(ctx)).map(async (nombre) => {
          try {
            const { solicitud } = await cargarCaso(ctx, nombre)
            return { caso: nombre, cliente: solicitud.cliente, pais: solicitud.pais, formato: solicitud.formato, fecha: solicitud.fecha }
          } catch (e) {
            return { caso: nombre, error: e instanceof Error ? e.message : String(e) }
          }
        }),
      )
      return { data: { casos }, resumen: `${casos.length} casos` }
    })
  },
})

export const leer_solicitud = definirHerramienta({
  description:
    "Lee el correo y la plantilla de un caso de registro como proveedor: devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos.",
  args: { caso },
  async execute(args, ctx) {
    return ejecutar("proveedor_leer_solicitud", ctx, args.caso, async () => {
      const cargado = await cargarCaso(ctx, args.caso)
      const { solicitud, plantilla } = cargado
      const glosario = await cargarGlosario(ctx)
      const etiquetas = plantilla?.campos.map((c) => c.etiqueta) ?? []
      const advertencias = [...cargado.advertencias]
      if (!reglas.formatos_conocidos.includes(solicitud.formato)) advertencias.push(`Formato no soportado: "${solicitud.formato}".`)
      else if (!reglas.formatos_soportados.includes(solicitud.formato)) {
        advertencias.push(`Formato "${solicitud.formato}": no se llena automáticamente; se entregarán los valores para copiar.`)
      }
      const data = {
        caso: args.caso,
        pais: solicitud.pais,
        pais_nombre: nombrePais(solicitud.pais),
        identificador_tributario_del_pais: identificadorDePais(solicitud.pais),
        cliente: solicitud.cliente,
        remitente: solicitud.de,
        asunto: solicitud.asunto,
        fecha_solicitud: solicitud.fecha,
        formato: solicitud.formato,
        plantilla: plantilla?.archivo ?? null,
        campos: plantilla?.campos ?? [],
        soportes: cargado.soportesExigidos.map((tipo) => ({ tipo, descripcion: nombreSoporte(tipo) })),
        requiere_confirmacion: identificadoresPorConfirmar(etiquetas, solicitud.pais, glosario),
        advertencias,
      }
      return {
        data,
        resumen: `${solicitud.pais} · ${solicitud.formato} · ${etiquetas.length} campos · ${cargado.soportesExigidos.length} soportes${advertencias.length ? ` · ${advertencias.length} advertencias` : ""}`,
      }
    })
  },
})

export const mapear_campos = definirHerramienta({
  description:
    "Cruza las etiquetas de campos pedidas por el cliente con el repositorio maestro y el glosario; cada campo queda lleno (con ruta y valor), faltante o requiere_confirmacion.",
  args: {
    caso,
    campos: z.array(z.string().min(1)).min(1).describe("Etiquetas de los campos tal como aparecen en la plantilla (salida de proveedor_leer_solicitud)"),
  },
  async execute(args, ctx) {
    return ejecutar("proveedor_mapear_campos", ctx, args.caso, async () => {
      const cargado = await cargarCaso(ctx, args.caso)
      const [maestro, glosario] = await Promise.all([cargarMaestro(ctx), cargarGlosario(ctx)])
      const mapeo = mapearCampos(args.campos, cargado.solicitud.pais, maestro, glosario)
      const dir = rutas(ctx).outCaso(args.caso)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "mapeo.json"), JSON.stringify(mapeo, null, 2), "utf8")
      return {
        data: { ...mapeo, ruta_mapeo: relativa(ctx, join(dir, "mapeo.json")) },
        resumen: `${args.campos.length} campos: ${mapeo.llenos.length} llenos, ${mapeo.faltantes.length} faltantes, ${mapeo.requiere_confirmacion.length} por confirmar`,
      }
    })
  },
})

const mapeoArg = z
  .object({
    llenos: z.array(z.object({ etiqueta: z.string(), ruta: z.string() })).default([]).describe("Campos llenos de proveedor_mapear_campos"),
    requiere_confirmacion: z
      .array(z.object({ etiqueta: z.string(), ruta: z.string() }))
      .default([])
      .describe("Campos por confirmar de proveedor_mapear_campos"),
    faltantes: z.array(z.object({ etiqueta: z.string() })).default([]).describe("Campos faltantes de proveedor_mapear_campos"),
  })
  .describe("Resultado de proveedor_mapear_campos tal cual; los valores se releen del maestro, no se toman de aquí")

/** Detecta si el mapeo que envía el modelo se aparta del mapeo determinista. */
function discrepancias(enviado: z.infer<typeof mapeoArg>, real: ResultadoMapeo): string[] {
  const rutaReal = new Map([...real.llenos, ...real.requiere_confirmacion].map((c) => [c.etiqueta, c.ruta]))
  const avisos: string[] = []
  for (const c of [...enviado.llenos, ...enviado.requiere_confirmacion]) {
    const esperada = rutaReal.get(c.etiqueta)
    if (esperada === undefined) avisos.push(`"${c.etiqueta}" no tiene fuente en el maestro; se deja como faltante.`)
    else if (esperada !== c.ruta) avisos.push(`"${c.etiqueta}" se mapea a "${esperada}", no a "${c.ruta}".`)
  }
  return avisos
}

export const generar_formulario = definirHerramienta({
  description:
    "Genera el formulario lleno en el formato del cliente (out/<caso>/formulario.xlsx o formulario.pdf); si el formato es portal web, produce valores-portal.md y avisa que no está soportado.",
  args: { caso, mapeo: mapeoArg },
  async execute(args, ctx) {
    return ejecutar("proveedor_generar_formulario", ctx, args.caso, async () => {
      const { cargado, mapeo, campos } = await mapeoDelCaso(ctx, args.caso)
      const avisos = [...cargado.advertencias, ...discrepancias(args.mapeo, mapeo)]
      const { ruta, formato } = await escribirFormulario(ctx, args.caso, cargado, campos)
      const soportado = reglas.formatos_soportados.includes(formato)
      const data = {
        ruta: relativa(ctx, ruta),
        formato,
        soportado,
        ...(soportado ? {} : { aviso: "Formato no soportado: portal web. Se generaron los valores listos para copiar; el llenado del portal es humano." }),
        campos_escritos: campos.filter((c) => c.estado !== "faltante").length,
        por_confirmar: campos.filter((c) => c.estado === "requiere_confirmacion").map((c) => c.etiqueta),
        faltantes: campos.filter((c) => c.estado === "faltante").map((c) => c.etiqueta),
        advertencias: avisos,
      }
      return { data, resumen: `${formato}${soportado ? "" : " (no soportado)"} → ${data.ruta}` }
    })
  },
})

export const armar_paquete = definirHerramienta({
  description:
    "Arma out/<caso>/paquete/ con el formulario, copia de los soportes exigidos, checklist.md y borrador-correo.md, y calcula si está listo para firma según la vigencia de los soportes.",
  args: {
    caso,
    fecha_referencia: z
      .string()
      .refine(esFechaIso, "Usa el formato YYYY-MM-DD")
      .optional()
      .describe("Fecha contra la que se evalúa la vigencia de los soportes (YYYY-MM-DD). Si se omite, se usa la fecha de ejecución."),
  },
  async execute(args, ctx) {
    return ejecutar("proveedor_armar_paquete", ctx, args.caso, async () => {
      const fecha = fechaReferencia(args.fecha_referencia)
      const { cargado, maestro, campos } = await mapeoDelCaso(ctx, args.caso)
      const advertencias = [...cargado.advertencias]
      const r = rutas(ctx)

      let formulario = await formularioExistente(ctx, args.caso)
      if (!formulario && campos.length > 0) {
        try {
          formulario = (await escribirFormulario(ctx, args.caso, cargado, campos)).ruta
          advertencias.push("El formulario no existía y se generó automáticamente con el mapeo del maestro.")
        } catch (e) {
          advertencias.push(e instanceof Error ? e.message : String(e))
        }
      }

      const soportes = await evaluarSoportes(cargado.soportesExigidos, await cargarIndiceSoportes(ctx), r.soportes, fecha)
      const dirPaquete = r.paquete(args.caso)
      await rm(dirPaquete, { recursive: true, force: true })
      await mkdir(join(dirPaquete, "soportes"), { recursive: true })
      const nombreFormulario = formulario ? formulario.split(/[\\/]/).pop() ?? null : null
      if (formulario && nombreFormulario) await copyFile(formulario, join(dirPaquete, nombreFormulario))
      for (const s of soportes) {
        if (s.archivo && s.estado !== "ausente") await copyFile(join(r.soportes, s.archivo), join(dirPaquete, "soportes", s.archivo))
      }

      const bloqueos = bloqueosDeFirma(soportes, nombreFormulario)
      const listo = bloqueos.length === 0
      await writeFile(
        join(dirPaquete, "checklist.md"),
        checklistMd({ caso: args.caso, solicitud: cargado.solicitud, fecha, formulario: nombreFormulario, soportes, campos, bloqueos, advertencias }),
        "utf8",
      )
      await writeFile(join(dirPaquete, "borrador-correo.md"), borradorCorreoMd(cargado.solicitud, maestro, soportes, nombreFormulario, bloqueos), "utf8")

      const checklist = {
        soportes: soportes.map(({ tipo, descripcion, estado, archivo, vigencia_hasta, detalle }) => ({ tipo, descripcion, estado, archivo, vigencia_hasta, detalle })),
        campos_llenos: campos.filter((c) => c.estado === "lleno").length,
        campos_por_confirmar: campos.filter((c) => c.estado === "requiere_confirmacion").map((c) => ({ etiqueta: c.etiqueta, valor_propuesto: c.valor, nota: c.nota })),
        campos_faltantes: campos.filter((c) => c.estado === "faltante").map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio })),
        bloqueos,
      }
      const estado = { caso: args.caso, fecha_referencia: fecha, listo_para_firma: listo, bloqueos, formulario: nombreFormulario, destinatario: cargado.solicitud.de, asunto: cargado.solicitud.asunto }
      await writeFile(join(r.outCaso(args.caso), "estado-paquete.json"), JSON.stringify(estado, null, 2), "utf8")

      const data = {
        ruta: relativa(ctx, dirPaquete),
        listo_para_firma: listo,
        fecha_referencia: fecha,
        archivos: [
          ...(nombreFormulario ? [nombreFormulario] : []),
          ...soportes.filter((s) => s.archivo && s.estado !== "ausente").map((s) => `soportes/${s.archivo}`),
          "checklist.md",
          "borrador-correo.md",
        ],
        checklist,
        advertencias,
      }
      return { data, resumen: `${listo ? "listo para firma" : `NO listo (${bloqueos.length} bloqueos)`} · ${data.ruta}` }
    })
  },
})

const EstadoPaqueteSchema = z.object({
  caso: z.string(),
  fecha_referencia: z.string(),
  listo_para_firma: z.boolean(),
  bloqueos: z.array(z.string()),
  formulario: z.string().nullable(),
  destinatario: z.string(),
  asunto: z.string(),
})

export const simular_envio = definirHerramienta({
  description:
    "Simula el envío del paquete al cliente escribiendo out/<caso>/ENVIO-SIMULADO.md; solo procede con confirmado=true después de que la analista lo confirmó explícitamente.",
  args: {
    caso,
    confirmado: z.boolean().describe("true solo si la analista confirmó el envío de forma explícita en su último mensaje"),
  },
  async execute(args, ctx) {
    return ejecutar("proveedor_simular_envio", ctx, args.caso, async () => {
      if (!args.confirmado) throw new ErrorHerramienta("requiere confirmación explícita")
      const r = rutas(ctx)
      let estado: z.infer<typeof EstadoPaqueteSchema>
      try {
        estado = EstadoPaqueteSchema.parse(JSON.parse(await readFile(join(r.outCaso(args.caso), "estado-paquete.json"), "utf8")))
      } catch {
        throw new ErrorHerramienta(`No hay paquete armado para "${args.caso}". Primero usa proveedor_armar_paquete.`)
      }
      const ruta = join(r.outCaso(args.caso), "ENVIO-SIMULADO.md")
      const contenido = [
        `# Envío simulado · ${args.caso}`,
        "",
        "> Simulación: **no se envió ningún correo**. Este archivo registra lo que se habría enviado.",
        "",
        `- Fecha: ${new Date().toISOString()}`,
        `- Para: ${estado.destinatario}`,
        `- Asunto: RE: ${estado.asunto}`,
        `- Cuerpo: \`paquete/borrador-correo.md\``,
        `- Adjuntos: carpeta \`paquete/\``,
        `- Confirmado por la analista: sí (sesión ${ctx.sessionId})`,
        `- Estado del paquete: ${estado.listo_para_firma ? "listo para firma" : "NO listo para firma"} (fecha de referencia ${estado.fecha_referencia})`,
        ...(estado.bloqueos.length ? ["", "## Advertencia: se envió con bloqueos pendientes", "", ...estado.bloqueos.map((b) => `- ${b}`)] : []),
        "",
      ].join("\n")
      await writeFile(ruta, contenido, "utf8")
      return {
        data: { ruta: relativa(ctx, ruta), listo_para_firma: estado.listo_para_firma, bloqueos: estado.bloqueos },
        resumen: `envío simulado → ${relativa(ctx, ruta)}`,
      }
    })
  },
})

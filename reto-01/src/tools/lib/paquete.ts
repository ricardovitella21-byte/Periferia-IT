import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { Maestro, Solicitud, SoporteRepositorio } from "./fixtures.ts"
import type { CampoResuelto } from "./formularios.ts"
import { nombrePais, nombreSoporte } from "./reglas.ts"
import { celdaMd } from "./texto.ts"
import { valorPorRuta } from "./mapeo.ts"

export type EstadoSoporte = {
  tipo: string
  descripcion: string
  estado: "vigente" | "vencido" | "ausente"
  archivo: string | null
  vigencia_hasta: string | null
  detalle: string
}

/** RN3: vencido = vigencia_hasta anterior a la fecha de referencia; ausente = no está en el repositorio. */
export async function evaluarSoportes(
  exigidos: string[],
  indice: SoporteRepositorio[],
  dirSoportes: string,
  fecha: string,
): Promise<EstadoSoporte[]> {
  return Promise.all(
    exigidos.map(async (tipo): Promise<EstadoSoporte> => {
      const descripcion = nombreSoporte(tipo)
      const soporte = indice.find((s) => s.tipo === tipo)
      if (!soporte) {
        return { tipo, descripcion, estado: "ausente", archivo: null, vigencia_hasta: null, detalle: "No existe en el repositorio de soportes." }
      }
      const existe = await stat(join(dirSoportes, soporte.archivo)).then(() => true, () => false)
      if (!existe) {
        return { tipo, descripcion, estado: "ausente", archivo: soporte.archivo, vigencia_hasta: soporte.vigencia_hasta, detalle: "Está en el índice pero el archivo no existe." }
      }
      if (soporte.vigencia_hasta && soporte.vigencia_hasta < fecha) {
        return { tipo, descripcion, estado: "vencido", archivo: soporte.archivo, vigencia_hasta: soporte.vigencia_hasta, detalle: `Venció el ${soporte.vigencia_hasta}; hay que renovarlo.` }
      }
      return {
        tipo,
        descripcion,
        estado: "vigente",
        archivo: soporte.archivo,
        vigencia_hasta: soporte.vigencia_hasta,
        detalle: soporte.vigencia_hasta ? `Vigente hasta ${soporte.vigencia_hasta}.` : "No vence.",
      }
    }),
  )
}

export function bloqueosDeFirma(soportes: EstadoSoporte[], formulario: string | null): string[] {
  const bloqueos = soportes
    .filter((s) => s.estado !== "vigente")
    .map((s) => `Soporte ${s.estado}: ${s.descripcion} (${s.tipo}). ${s.detalle}`)
  if (!formulario) bloqueos.push("No hay formulario generado para firmar.")
  return bloqueos
}

type DatosChecklist = {
  caso: string
  solicitud: Solicitud
  fecha: string
  formulario: string | null
  soportes: EstadoSoporte[]
  campos: CampoResuelto[]
  bloqueos: string[]
  advertencias: string[]
}

const ICONO = { vigente: "✅ vigente", vencido: "⛔ vencido", ausente: "⛔ ausente" } as const

export function checklistMd(d: DatosChecklist): string {
  const listo = d.bloqueos.length === 0
  const porConfirmar = d.campos.filter((c) => c.estado === "requiere_confirmacion")
  const faltantes = d.campos.filter((c) => c.estado === "faltante")
  return [
    `# Checklist · paquete para firma · ${d.solicitud.cliente}`,
    "",
    `- Caso: \`${d.caso}\``,
    `- País del cliente: ${nombrePais(d.solicitud.pais)} (${d.solicitud.pais})`,
    `- Formato pedido: ${d.solicitud.formato}`,
    `- Fecha de referencia para vigencias: ${d.fecha}`,
    `- Formulario: ${d.formulario ?? "no generado"}`,
    "",
    listo ? "## Estado: ✅ LISTO PARA FIRMA" : "## Estado: ⛔ NO LISTO PARA FIRMA",
    "",
    ...(listo ? ["Todos los soportes exigidos están presentes y vigentes."] : d.bloqueos.map((b) => `- ${b}`)),
    "",
    "## Soportes exigidos",
    "",
    "| Soporte | Tipo | Estado | Archivo | Vigente hasta |",
    "|---|---|---|---|---|",
    ...d.soportes.map(
      (s) => `| ${celdaMd(s.descripcion)} | \`${s.tipo}\` | ${ICONO[s.estado]} | ${s.archivo ?? "—"} | ${s.vigencia_hasta ?? "no vence"} |`,
    ),
    "",
    "## Campos del formulario",
    "",
    `- Llenos: ${d.campos.filter((c) => c.estado === "lleno").length} de ${d.campos.length}`,
    `- Por confirmar: ${porConfirmar.length}`,
    ...porConfirmar.map((c) => `  - **${c.etiqueta}** → \`${c.valor}\`. ${c.nota ?? ""}`),
    `- Faltantes (no bloquean la firma, pero hay que completarlos): ${faltantes.length}`,
    ...faltantes.map((c) => `  - **${c.etiqueta}**${c.obligatorio ? " (obligatorio)" : ""}. ${c.nota ?? ""}`),
    ...(d.advertencias.length ? ["", "## Advertencias", "", ...d.advertencias.map((a) => `- ${a}`)] : []),
    "",
    "## Pasos humanos pendientes",
    "",
    ...(porConfirmar.length ? ["- [ ] Confirmar los campos marcados como por confirmar."] : []),
    ...(faltantes.length ? ["- [ ] Completar los campos faltantes."] : []),
    ...d.soportes.filter((s) => s.estado !== "vigente").map((s) => `- [ ] Conseguir o renovar: ${s.descripcion}.`),
    "- [ ] Firma del representante legal.",
    "- [ ] Envío al cliente (decisión humana).",
    "",
  ].join("\n")
}

/** RN2: el borrador nunca incluye datos bancarios. Solo usa datos de contacto del maestro. */
export function borradorCorreoMd(
  solicitud: Solicitud,
  maestro: Maestro,
  soportes: EstadoSoporte[],
  formulario: string | null,
  bloqueos: string[],
): string {
  const razonSocial = String(valorPorRuta(maestro, "razon_social") ?? "Periferia IT Group")
  const firmante = valorPorRuta(maestro, "contacto_financiero.nombre")
  const correo = valorPorRuta(maestro, "contacto_financiero.email")
  const adjuntos = [
    ...(formulario ? [`Formulario diligenciado y firmado por el representante legal (${formulario})`] : []),
    ...soportes.filter((s) => s.estado === "vigente").map((s) => `${s.descripcion} (${s.archivo})`),
  ]
  const aviso = bloqueos.length
    ? ["> ⚠️ **BORRADOR, NO ENVIAR TODAVÍA.** El paquete no está listo para firma:", ...bloqueos.map((b) => `> - ${b}`), ""]
    : []
  return [
    ...aviso,
    `**Para:** ${solicitud.de}`,
    `**Asunto:** RE: ${solicitud.asunto}`,
    "",
    `Buen día, equipo de ${solicitud.cliente}:`,
    "",
    `En respuesta a su solicitud del ${solicitud.fecha}, adjuntamos la documentación para el registro de ${razonSocial} como proveedor:`,
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    "Quedamos atentos a cualquier información adicional que requieran.",
    "",
    "Cordialmente,",
    "",
    ...(firmante ? [String(firmante)] : []),
    `Área Administrativa · ${razonSocial}`,
    ...(correo ? [String(correo)] : []),
    "",
  ].join("\n")
}

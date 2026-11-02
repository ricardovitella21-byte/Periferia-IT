/**
 * Verificación sin modelo (PRD 6.6): procesa los 6 mensajes del buzón en orden llamando
 * directamente a las herramientas. Imprime por mensaje la clasificación, los campos en revisión
 * y la acción tomada; luego confirma uno de los que quedaron en revisión y genera las alertas.
 *
 *   bun install && bun run demo.ts
 */
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as contratos from "./src/tools/contratos.ts"
import type { ContextoHerramienta } from "./src/tools/lib/tipos.ts"

// Fecha fija para que la demo sea determinista (fecha del PRD).
const HOY = "2026-09-03"
process.env.FECHA_REFERENCIA = HOY
const ctx: ContextoHerramienta = { directory: import.meta.dir, sessionId: "demo" }

type Respuesta = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
const parse = (s: string) => JSON.parse(s) as Respuesta
type Contrato = Parameters<typeof contratos.registrar.execute>[0]["contrato"]

async function copiarDirectorio(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const e of await readdir(origen, { withFileTypes: true })) {
    if (e.isDirectory()) await copiarDirectorio(join(origen, e.name), join(destino, e.name))
    else await copyFile(join(origen, e.name), join(destino, e.name))
  }
}

async function procesar(id: string, c: ContextoHerramienta = ctx): Promise<{ contrato: Contrato; revision: string[] } | null> {
  const ext = parse(await contratos.extraer.execute({ mensaje_id: id }, c))
  if (!ext.ok) return console.log(`  ${id}  ✗ extraer: ${ext.error}`), null
  const contrato = ext.data.contrato as Contrato
  const val = parse(await contratos.validar.execute({ mensaje_id: id, contrato }, c))
  if (!val.ok) return console.log(`  ${id}  ✗ validar: ${val.error}`), null
  const v = val.data as { clasificacion: string; id_contrato: string | null; requiere_revision: string[]; motivo: string | null; diferencias: Array<{ campo: string; antes: string; despues: string }>; advertencias: string[] }
  const reg = parse(await contratos.registrar.execute({ mensaje_id: id, contrato }, c))
  const accion = reg.ok ? `${String(reg.data.accion)}${reg.data.ruta_archivo ? ` → ${String(reg.data.ruta_archivo)}` : ""}` : `NO registrado (${reg.error})`
  console.log(`  ${id}  ${v.clasificacion.toUpperCase().padEnd(13)} ${v.id_contrato ?? "—"}`)
  console.log(`          revisión: ${v.requiere_revision.length ? v.requiere_revision.join(", ") : "ninguna"} · acción: ${accion}`)
  for (const d of v.diferencias) console.log(`          cambio: ${d.campo} ${d.antes} → ${d.despues}`)
  if (v.clasificacion === "rechazado" || v.clasificacion === "duplicado") console.log(`          motivo: ${v.motivo}`)
  for (const a of v.advertencias) console.log(`          ! ${a}`)
  return { contrato, revision: v.requiere_revision }
}

async function main() {
  await rm(join(ctx.directory, "out"), { recursive: true, force: true }) // determinismo: out/ limpio
  console.log(`Demo reto 02 · fecha de referencia ${HOY}\n`)

  const buzon = parse(await contratos.leer_buzon.execute({}, ctx))
  if (!buzon.ok) throw new Error(buzon.error)
  const mensajes = buzon.data.mensajes as Array<{ id: string; asunto: string; tiene_contrato: boolean }>
  console.log(`Buzón: ${mensajes.length} mensajes pendientes`)
  for (const m of mensajes) console.log(`  ${m.id}  ${m.tiene_contrato ? "contrato" : "SIN contrato"} · ${m.asunto}`)

  console.log("\n━━━ Primera pasada: se registra solo lo limpio ━━━")
  const pendientes = new Map<string, Contrato>()
  for (const m of mensajes) {
    const r = await procesar(m.id)
    if (r && r.revision.length) pendientes.set(m.id, r.contrato)
  }

  console.log("\n━━━ Segunda pasada: confirmación explícita de la analista ━━━")
  const msg006 = pendientes.get("msg-006")
  if (msg006) {
    console.log('  Analista: "confirmo el valor 0 y la fecha fin 2027-08-31"')
    const confirmado = { ...msg006, valor: 0, fecha_fin: "2027-08-31" }
    const r = parse(await contratos.registrar.execute({ mensaje_id: "msg-006", contrato: confirmado, confirmado: true }, ctx))
    console.log(`  msg-006  ${r.ok ? `${String(r.data.accion)} ${String(r.data.id_contrato)} → ${String(r.data.ruta_archivo)} (confirmados: ${(r.data.campos_confirmados as string[]).join(", ")})` : `✗ ${r.error}`}`)
  }

  console.log("\n━━━ Alertas ━━━")
  const alertas = parse(await contratos.alertas.execute({ hoy: HOY }, ctx))
  if (alertas.ok) {
    const a = alertas.data as { ruta: string; vencen: Array<{ id_contrato: string; fecha_fin: string; dias: number }>; polizas_pendientes: Array<{ id_contrato: string; estado_poliza: string }>; registrados_desde_corte: Array<{ id_contrato: string }> }
    console.log(`  ${a.ruta}`)
    console.log(`  Vencen ≤ 60 días: ${a.vencen.map((v) => `${v.id_contrato} (${v.fecha_fin}, ${v.dias} d)`).join(", ") || "ninguno"}`)
    console.log(`  Pólizas pendientes: ${a.polizas_pendientes.map((p) => `${p.id_contrato} (${p.estado_poliza})`).join(", ") || "ninguna"}`)
    console.log(`  Registrados desde el corte: ${a.registrados_desde_corte.map((r) => r.id_contrato).join(", ") || "ninguno"}`)
  } else console.log(`  ✗ ${alertas.error}`)

  const despues = parse(await contratos.leer_buzon.execute({}, ctx))
  console.log(`\nBuzón después del lote: ${despues.ok ? String(despues.data.pendientes) : "?"} pendientes`)

  console.log("\n━━━ Manejo de errores (HU-6) ━━━")
  const inexistente = parse(await contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx))
  console.log(`  Mensaje inexistente → ${inexistente.ok ? "✗ no falló" : inexistente.error}`)
  const moneda = parse(await contratos.validar.execute({ mensaje_id: "msg-002", contrato: { moneda: "EUR" } }, ctx))
  console.log(`  Moneda desconocida → ${moneda.ok ? "✗ no falló" : moneda.error}`)
  const fechaMala = parse(await contratos.alertas.execute({ hoy: "2026-02-31" }, ctx))
  console.log(`  Fecha inválida → ${fechaMala.ok ? "✗ no falló" : fechaMala.error}`)

  // Copia temporal de los fixtures con un contrato vacío (los fixtures originales no se tocan).
  const temporal = await mkdtemp(join(tmpdir(), "reto02-demo-"))
  try {
    await copiarDirectorio(join(ctx.directory, "fixtures"), join(temporal, "fixtures"))
    await writeFile(join(temporal, "fixtures/reto-02/buzon/msg-001/contrato.txt"), "CONTRATO DE PRESTACIÓN DE SERVICIOS\n", "utf8")
    const errores: ContextoHerramienta = { directory: temporal, sessionId: "demo-errores" }
    const vacio = parse(await contratos.extraer.execute({ mensaje_id: "msg-001" }, errores))
    if (vacio.ok) {
      const val = parse(await contratos.validar.execute({ mensaje_id: "msg-001", contrato: vacio.data.contrato as Contrato }, errores))
      console.log(`  Contrato sin partes ni objeto → ${val.ok ? `${String(val.data.clasificacion)}: ${String(val.data.motivo)}` : val.error}`)
    }
    await writeFile(join(temporal, "fixtures/reto-02/buzon/msg-001/contrato.txt"), "   \n", "utf8")
    const enBlanco = parse(await contratos.extraer.execute({ mensaje_id: "msg-001" }, errores))
    console.log(`  Texto vacío → ${enBlanco.ok ? "✗ no falló" : enBlanco.error}`)
    console.log("  El lote nunca se aborta: cada mensaje se procesa por separado.")
  } finally {
    await rm(temporal, { recursive: true, force: true })
  }

  console.log("\nResultados en out/sharepoint/ (maestro, Contratos/, historial.jsonl), out/procesados.json, out/alertas.md y out/log.jsonl")
}

await main()

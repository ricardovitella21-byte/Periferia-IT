/**
 * Verificación sin modelo (PRD 6.6): procesa los 6 casos llamando directamente a las herramientas.
 * Imprime por caso: apta, bloqueos, confirmaciones, retroactiva y número de OC o motivo.
 * Muestra la idempotencia (sol-001 dos veces) y una confirmación explícita (sol-004).
 *
 *   bun install && bun run demo.ts
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as oc from "./src/tools/oc.ts"
import type { OrdenCompra } from "./src/tools/lib/payload.ts"
import type { ContextoHerramienta } from "./src/tools/lib/tipos.ts"

// Fecha fija para que la demo sea determinista (fecha del PRD).
process.env.FECHA_REFERENCIA = "2026-09-03"
const ctx: ContextoHerramienta = { directory: import.meta.dir, sessionId: "demo" }

type Respuesta = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
type Hallazgo = { codigo: string; detalle: string; accion_sugerida: string }
const parse = (s: string) => JSON.parse(s) as Respuesta

async function copiarDirectorio(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const e of await readdir(origen, { withFileTypes: true })) {
    if (e.isDirectory()) await copiarDirectorio(join(origen, e.name), join(destino, e.name))
    else await copyFile(join(origen, e.name), join(destino, e.name))
  }
}

/** Flujo completo de un caso: leer → validar → construir → evidencia → crear. Devuelve el payload si se construyó. */
async function procesar(caso: string, c: ContextoHerramienta = ctx, confirmado = false): Promise<OrdenCompra | null> {
  const paquete = parse(await oc.leer_paquete.execute({ caso }, c))
  if (!paquete.ok) return console.log(`  ${caso}  ✗ ${paquete.error}`), null
  const val = parse(await oc.validar.execute({ caso, paquete: paquete.data as never }, c))
  if (!val.ok) return console.log(`  ${caso}  ✗ ${val.error}`), null
  const v = val.data as { solicitud_id: string; apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, { valor: string; fuente: string }>; retroactiva: boolean }
  console.log(`  ${caso} (${v.solicitud_id})  apta=${v.apta}  retroactiva=${v.retroactiva}`)
  for (const b of v.bloqueos) console.log(`     ⛔ ${b.codigo}: ${b.detalle}\n        → ${b.accion_sugerida}`)
  for (const k of v.confirmaciones) console.log(`     ❓ ${k.codigo}: ${k.detalle}`)
  for (const [campo, d] of Object.entries(v.derivados)) console.log(`     ↳ derivado ${campo} = ${d.valor} (${d.fuente})`)
  if (!v.apta) {
    const intento = parse(await oc.crear.execute({ caso, payload: {} as OrdenCompra }, c))
    console.log(`     OC: no creada (${intento.ok ? "?" : "bloqueada"})`)
    return null
  }
  const construido = parse(await oc.construir_payload.execute({ caso, paquete: paquete.data as never, derivados: v.derivados }, c))
  if (!construido.ok) return console.log(`     ✗ ${construido.error}`), null
  const orden = construido.data.orden as OrdenCompra
  const evidencia = parse(await oc.generar_evidencia.execute({ caso }, c))
  const p = orden.posiciones[0]
  console.log(`     Payload: ${orden.proveedor.codigo_sap} ${orden.proveedor.nombre} · ${p?.cantidad} ${p?.unidad} × ${p?.precio_unitario} · IVA ${p?.indicador_iva} · ${orden.condiciones_pago} · "${p?.descripcion}"`)
  console.log(`     Evidencia: ${evidencia.ok ? `${String(evidencia.data.ruta)} + .pdf (sha256 ${String(evidencia.data.sha256).slice(0, 16)}…)` : evidencia.error}`)
  const creada = parse(await oc.crear.execute({ caso, payload: orden, ...(confirmado ? { confirmado: true } : {}) }, c))
  console.log(`     OC: ${creada.ok ? `${String(creada.data.numero_oc)}${creada.data.idempotente ? " (idempotente: ya existía)" : ""}` : `no creada → ${creada.error.slice(0, 120)}${creada.error.length > 120 ? "…" : ""}`}`)
  return orden
}

async function main() {
  await rm(join(ctx.directory, "out"), { recursive: true, force: true }) // determinismo: out/ limpio
  console.log("Demo reto 03 · fecha de referencia 2026-09-03\n")

  console.log("━━━ Primera pasada: los 6 casos sin confirmar nada ━━━")
  const ordenes = new Map<string, OrdenCompra>()
  for (const caso of ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]) {
    const orden = await procesar(caso)
    if (orden) ordenes.set(caso, orden)
  }

  console.log("\n━━━ Idempotencia: sol-001 por segunda vez ━━━")
  const otraVez = parse(await oc.crear.execute({ caso: "sol-001", payload: ordenes.get("sol-001") as OrdenCompra }, ctx))
  console.log(`  sol-001 → ${otraVez.ok ? `OC ${String(otraVez.data.numero_oc)} · idempotente=${String(otraVez.data.idempotente)}` : otraVez.error}`)

  console.log("\n━━━ Confirmación explícita de la analista ━━━")
  for (const caso of ["sol-004", "sol-005"]) {
    console.log(`  Analista: "confirmo ${caso}"`)
    const r = parse(await oc.crear.execute({ caso, payload: ordenes.get(caso) as OrdenCompra, confirmado: true }, ctx))
    console.log(`  ${caso} → ${r.ok ? `OC ${String(r.data.numero_oc)}${r.data.retroactiva ? " · retroactiva=true" : ""} · evidencia ${String(r.data.ruta_evidencia)}` : r.error}`)
  }
  console.log("  sol-006 queda pendiente de confirmar el IVA derivado.")

  console.log("\n━━━ out/control.csv ━━━")
  console.log((await readFile(join(ctx.directory, "out/control.csv"), "utf8")).replace(/,20\d\d-[^\n]+/g, "").trim().split("\n").map((l) => `  ${l}`).join("\n"))

  console.log("\n━━━ Manejo de errores (HU-6) ━━━")
  const inexistente = parse(await oc.leer_paquete.execute({ caso: "sol-999" }, ctx))
  console.log(`  Caso inexistente → ${inexistente.ok ? "✗ no falló" : inexistente.error}`)
  const temporal = await mkdtemp(join(tmpdir(), "reto03-demo-"))
  try {
    await copiarDirectorio(join(ctx.directory, "fixtures"), join(temporal, "fixtures"))
    const errores: ContextoHerramienta = { directory: temporal, sessionId: "demo-errores" }
    const solicitud = join(temporal, "fixtures/reto-03/solicitudes/sol-001/solicitud.json")
    const original = JSON.parse(await readFile(solicitud, "utf8")) as Record<string, unknown>
    await writeFile(solicitud, JSON.stringify({ ...original, valor_total: "once millones" }), "utf8")
    const noNumerico = parse(await oc.leer_paquete.execute({ caso: "sol-001" }, errores))
    console.log(`  Monto no numérico → ${noNumerico.ok ? "✗ no falló" : noNumerico.error}`)
    await writeFile(solicitud, "{ esto no es json", "utf8")
    const malformado = parse(await oc.leer_paquete.execute({ caso: "sol-001" }, errores))
    console.log(`  JSON malformado → ${malformado.ok ? "✗ no falló" : malformado.error}`)
    await rm(join(temporal, "fixtures/reto-03/solicitudes/sol-002/aprobacion.json"))
    await rm(join(temporal, "fixtures/reto-03/solicitudes/sol-002/cotizacion.txt"))
    const incompleto = parse(await oc.leer_paquete.execute({ caso: "sol-002" }, errores))
    console.log(`  Paquete incompleto → ${incompleto.ok ? `faltan: ${(incompleto.data.faltantes as string[]).join(", ")} (cotizacion=null, aprobacion=null)` : incompleto.error}`)
  } finally {
    await rm(temporal, { recursive: true, force: true })
  }

  console.log("\nResultados en out/<caso>/ (payload, trazabilidad, evidencia), out/sap/ordenes.jsonl, out/control.csv y out/log.jsonl")
}

await main()

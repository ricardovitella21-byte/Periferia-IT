/**
 * Verificación sin modelo (PRD 6.6): ejecuta todos los casos llamando directamente
 * a las herramientas e imprime un resumen por caso. No necesita clave de ningún proveedor.
 *
 *   bun install && bun run demo.ts
 */
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as proveedor from "./src/tools/proveedor.ts"
import { listarCasos } from "./src/tools/lib/fixtures.ts"
import type { ContextoHerramienta } from "./src/tools/lib/tipos.ts"

// Fecha fija para que la demo sea determinista (fecha del PRD).
const FECHA = "2026-09-03"
const ctx: ContextoHerramienta = { directory: import.meta.dir, sessionId: "demo" }

type Respuesta = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
const parse = (s: string) => JSON.parse(s) as Respuesta

async function copiarDirectorio(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const entrada of await readdir(origen, { withFileTypes: true })) {
    const [o, d] = [join(origen, entrada.name), join(destino, entrada.name)]
    if (entrada.isDirectory()) await copiarDirectorio(o, d)
    else await copyFile(o, d)
  }
}
const lista = (v: unknown) => (Array.isArray(v) && v.length ? v.map((x) => (typeof x === "string" ? x : (x as { etiqueta: string }).etiqueta)).join(", ") : "ninguno")

async function procesar(caso: string, c: ContextoHerramienta = ctx): Promise<void> {
  console.log(`\n━━━ ${caso} ━━━`)
  const solicitud = parse(await proveedor.leer_solicitud.execute({ caso }, c))
  if (!solicitud.ok) return void console.log(`  ✗ leer_solicitud: ${solicitud.error}`)
  const s = solicitud.data as { pais: string; cliente: string; formato: string; campos: Array<{ etiqueta: string }>; soportes: unknown[]; advertencias: string[] }
  console.log(`  Cliente: ${s.cliente} (${s.pais}) · formato ${s.formato} · ${s.campos.length} campos · ${s.soportes.length} soportes`)
  for (const a of s.advertencias) console.log(`  ! ${a}`)

  if (s.campos.length) {
    const mapeo = parse(await proveedor.mapear_campos.execute({ caso, campos: s.campos.map((x) => x.etiqueta) }, c))
    if (!mapeo.ok) return void console.log(`  ✗ mapear_campos: ${mapeo.error}`)
    const m = mapeo.data as { llenos: unknown[]; faltantes: unknown[]; requiere_confirmacion: unknown[] }
    console.log(`  Llenos: ${m.llenos.length} · Faltantes: ${lista(m.faltantes)} · Por confirmar: ${lista(m.requiere_confirmacion)}`)
    const form = parse(
      await proveedor.generar_formulario.execute(
        { caso, mapeo: m as { llenos: Array<{ etiqueta: string; ruta: string }>; requiere_confirmacion: Array<{ etiqueta: string; ruta: string }>; faltantes: Array<{ etiqueta: string }> } },
        c,
      ),
    )
    console.log(form.ok ? `  Formulario: ${form.data.ruta}${form.data.soportado ? "" : `  (${form.data.aviso})`}` : `  ✗ generar_formulario: ${form.error}`)
  }

  const paquete = parse(await proveedor.armar_paquete.execute({ caso, fecha_referencia: FECHA }, c))
  if (!paquete.ok) return void console.log(`  ✗ armar_paquete: ${paquete.error}`)
  const p = paquete.data as { ruta: string; listo_para_firma: boolean; checklist: { soportes: Array<{ tipo: string; estado: string }>; bloqueos: string[] } }
  console.log(`  Paquete: ${p.ruta} · ${p.listo_para_firma ? "✅ LISTO PARA FIRMA" : "⛔ NO LISTO PARA FIRMA"}`)
  console.log(`  Soportes: ${p.checklist.soportes.map((x) => `${x.tipo}=${x.estado}`).join(", ")}`)
  for (const b of p.checklist.bloqueos) console.log(`    · ${b}`)
}

async function main() {
  await rm(join(ctx.directory, "out"), { recursive: true, force: true }) // determinismo: out/ limpio
  console.log(`Demo reto 01 · fecha de referencia ${FECHA}`)

  for (const caso of await listarCasos(ctx)) await procesar(caso)

  console.log("\n━━━ Confirmación humana (RN4) ━━━")
  const sinConfirmar = parse(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: false }, ctx))
  console.log(`  Sin confirmar → ${sinConfirmar.ok ? "✗ se envió (no debería)" : `bloqueado: "${sinConfirmar.error}"`}`)
  const confirmado = parse(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: true }, ctx))
  console.log(`  Con confirmación → ${confirmado.ok ? `escrito ${confirmado.data.ruta}` : `✗ ${confirmado.error}`}`)

  console.log("\n━━━ Manejo de errores (HU-5) ━━━")
  const inexistente = parse(await proveedor.leer_solicitud.execute({ caso: "no-existe" }, ctx))
  console.log(`  Caso inexistente → ${inexistente.ok ? "✗ no falló" : inexistente.error}`)

  // Copia temporal de los fixtures con una plantilla dañada (los fixtures originales no se tocan).
  const temporal = await mkdtemp(join(tmpdir(), "reto01-demo-"))
  try {
    await copiarDirectorio(join(ctx.directory, "fixtures"), join(temporal, "fixtures"))
    await writeFile(join(temporal, "fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json"), "{ esto no es json", "utf8")
    await procesar("co-industrias-delta", { directory: temporal, sessionId: "demo-errores" })
  } finally {
    await rm(temporal, { recursive: true, force: true })
  }

  console.log(`\nResultados en out/ · log de herramientas en out/log.jsonl y out/<caso>/log.jsonl`)
}

await main()

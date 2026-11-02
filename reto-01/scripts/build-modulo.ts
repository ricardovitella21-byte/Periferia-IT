/**
 * Genera modulo/ (bonus, PRD 9.4) a partir de las MISMAS fuentes que usa la aplicación:
 *   agent/prompt.md                    → modulo/agent.md
 *   src/knowledge/registro-proveedor.md → modulo/skill/registro-proveedor/SKILL.md
 *   src/tools/{proveedor,agente}.ts    → modulo/tools/*.ts (reexportan, no copian)
 *
 *   bun run modulo           escribe modulo/
 *   bun run modulo --check   falla si modulo/ no está sincronizado
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const RAIZ = join(import.meta.dir, "..")

export async function contenidoModulo(): Promise<Record<string, string>> {
  const prompt = (await readFile(join(RAIZ, "agent", "prompt.md"), "utf8")).trim()
  const conocimiento = (await readFile(join(RAIZ, "src", "knowledge", "registro-proveedor.md"), "utf8")).trim()
  const reexporta = (archivo: string) =>
    `// Mismas herramientas que usa la aplicación: este archivo solo las reexporta.\nexport * from "../../src/tools/${archivo}.ts"\n`
  return {
    "agent.md": [
      "---",
      "description: Prepara el registro de Periferia IT Group como proveedor ante clientes (formulario, soportes y paquete para firma) y pide confirmación antes de cualquier envío.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt,
      "",
    ].join("\n"),
    "skill/registro-proveedor/SKILL.md": [
      "---",
      "name: registro-proveedor",
      "description: Conocimiento del proceso de registro como proveedor. Estados de un campo, identificador tributario por país (NIT, RUC, RTN), soportes y vigencias, y formatos de salida. Úsalo al procesar una solicitud de registro de proveedor.",
      "---",
      "",
      conocimiento,
      "",
    ].join("\n"),
    "tools/proveedor.ts": reexporta("proveedor"),
    "tools/agente.ts": reexporta("agente"),
  }
}

if (import.meta.main) {
  const verificar = process.argv.includes("--check")
  const desincronizados: string[] = []
  for (const [ruta, contenido] of Object.entries(await contenidoModulo())) {
    const destino = join(RAIZ, "modulo", ruta)
    if (verificar) {
      const actual = await readFile(destino, "utf8").catch(() => null)
      if (actual?.replace(/\r\n/g, "\n") !== contenido) desincronizados.push(ruta)
      continue
    }
    await mkdir(dirname(destino), { recursive: true })
    await writeFile(destino, contenido, "utf8")
    console.log(`escrito modulo/${ruta}`)
  }
  if (desincronizados.length) {
    console.error(`modulo/ no está sincronizado: ${desincronizados.join(", ")}. Ejecuta: bun run modulo`)
    process.exit(1)
  }
  if (verificar) console.log("modulo/ sincronizado con las fuentes de la aplicación")
}

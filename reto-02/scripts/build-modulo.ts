/**
 * Genera modulo/ (bonus, PRD 9.4) a partir de las MISMAS fuentes que usa la aplicación:
 *   agent/prompt.md                     → modulo/agent.md
 *   src/knowledge/registro-contratos.md → modulo/skill/registro-contratos/SKILL.md
 *   src/tools/{contratos,agente}.ts     → modulo/tools/*.ts (reexportan, no copian)
 *
 *   bun run modulo           escribe modulo/
 *   bun run modulo --check   falla si modulo/ no está sincronizado
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const RAIZ = join(import.meta.dir, "..")

export async function contenidoModulo(): Promise<Record<string, string>> {
  const prompt = (await readFile(join(RAIZ, "agent", "prompt.md"), "utf8")).trim()
  const conocimiento = (await readFile(join(RAIZ, "src", "knowledge", "registro-contratos.md"), "utf8")).trim()
  const reexporta = (archivo: string) =>
    `// Mismas herramientas que usa la aplicación: este archivo solo las reexporta.\nexport * from "../../src/tools/${archivo}.ts"\n`
  return {
    "agent.md": [
      "---",
      "description: Punto único de recepción de contratos. Lee el buzón, extrae y valida cada contrato, alimenta el maestro con historial y genera alertas de vencimientos y pólizas; pide confirmación antes de registrar algo dudoso.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt,
      "",
    ].join("\n"),
    "skill/registro-contratos/SKILL.md": [
      "---",
      "name: registro-contratos",
      "description: Conocimiento del proceso de registro de contratos vigentes. Clasificación (nuevo, actualización, duplicado, rechazado), revisión humana por confianza, esquema del maestro, otrosíes, contratos marco y alertas. Úsalo al procesar el buzón de contratos.",
      "---",
      "",
      conocimiento,
      "",
    ].join("\n"),
    "tools/contratos.ts": reexporta("contratos"),
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

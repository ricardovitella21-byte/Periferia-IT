import { z } from "zod"
import { ejecutar } from "./lib/ejecucion.ts"
import { definirHerramienta } from "./lib/tipos.ts"

// Herramienta del propio agente (no del proceso de negocio): el modelo la ve como `agente_pedir_confirmacion`.

export const pedir_confirmacion = definirHerramienta({
  description:
    "Registra que el turno termina con una pregunta de confirmación a la analista antes de una acción externa (envío, firma, carga a portal); el chat la resalta y solo se procede si la respuesta siguiente confirma.",
  args: {
    accion: z.string().min(3).describe("Acción que requiere confirmación, por ejemplo: simular el envío del paquete al cliente"),
    caso: z.string().optional().describe("Caso al que aplica la acción, si corresponde"),
    pregunta: z.string().min(5).describe("Pregunta explícita que verá la analista, terminada en signo de interrogación"),
  },
  async execute(args, ctx) {
    return ejecutar("agente_pedir_confirmacion", ctx, args.caso ?? null, async () => ({
      data: {
        registrada: true,
        instruccion: "Termina el turno ahora: resume lo hecho y cierra con la pregunta. No ejecutes la acción hasta que la analista confirme.",
      },
      resumen: `confirmación pedida: ${args.accion}`,
    }))
  },
})

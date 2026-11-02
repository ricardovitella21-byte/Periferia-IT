import DOMPurify from "dompurify"
import { marked } from "marked"

type LlamadaVisible = { id: string; nombre: string; argumentos: unknown; ok: boolean; resumen: string; duracionMs: number; archivos: string[] }
type Entrada = { rol: "usuario" | "asistente"; texto: string; toolCalls?: LlamadaVisible[]; needsConfirmation?: boolean; error?: string | null }
type RespuestaChat = { sessionId: string; reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error: string | null; tokensSesion: { entrada: number; salida: number } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const mensajes = $<HTMLElement>("mensajes")
const formulario = $<HTMLFormElement>("formulario")
const texto = $<HTMLTextAreaElement>("texto")
const enviar = $<HTMLButtonElement>("enviar")
const pensando = $<HTMLElement>("pensando")
const pensandoTexto = $<HTMLElement>("pensando-texto")
const pie = $<HTMLElement>("pie")
const bienvenida = $<HTMLElement>("bienvenida")

// localStorage puede fallar (modo privado): solo es una comodidad.
const guardado = {
  leer: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  escribir: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      /* sin almacenamiento */
    }
  },
}

let sessionId = guardado.leer("reto02.sesion")
let claveAcceso = guardado.leer("reto02.clave")
let ocupado = false

async function api(ruta: string, init: RequestInit = {}, reintento = true): Promise<Response> {
  const headers = new Headers(init.headers)
  if (claveAcceso) headers.set("x-clave-acceso", claveAcceso)
  const res = await fetch(ruta, { ...init, headers })
  if (res.status === 401 && reintento) {
    claveAcceso = window.prompt("Este agente está protegido. Ingresa la clave de acceso:")?.trim() || null
    guardado.escribir("reto02.clave", claveAcceso)
    if (claveAcceso) return api(ruta, init, false)
  }
  return res
}

function markdown(contenido: string): string {
  return DOMPurify.sanitize(marked.parse(contenido, { async: false, gfm: true }))
}

function bajar() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
}

function enlaceArchivo(ruta: string): HTMLAnchorElement {
  const a = document.createElement("a")
  const url = `/api/archivos/${ruta.replace(/^out\//, "").split("/").map(encodeURIComponent).join("/")}`
  a.href = url
  a.textContent = ruta.replace(/^out\//, "")
  a.target = "_blank"
  a.rel = "noopener"
  if (claveAcceso) {
    // Con clave de acceso, la descarga necesita el encabezado: se pide con fetch.
    a.addEventListener("click", async (ev) => {
      ev.preventDefault()
      const res = await api(url)
      if (!res.ok) return void alert("No se pudo abrir el archivo.")
      window.open(URL.createObjectURL(await res.blob()), "_blank")
    })
  }
  return a
}

function tarjetaHerramienta(l: LlamadaVisible): HTMLElement {
  const d = document.createElement("details")
  d.className = `tool${l.ok ? "" : " fallo"}`
  const s = document.createElement("summary")
  const partes: Array<[string, string]> = [
    ["tool-nombre", l.nombre],
    [`tool-estado ${l.ok ? "ok" : "fallo"}`, l.ok ? "✓ ok" : "✗ error"],
    ["tool-resumen", l.resumen],
    ["tool-ms", `${l.duracionMs} ms`],
  ]
  for (const [clase, contenido] of partes) {
    const span = document.createElement("span")
    span.className = clase
    span.textContent = contenido
    s.append(span)
  }
  const pre = document.createElement("pre")
  pre.textContent = `argumentos: ${JSON.stringify(l.argumentos, null, 2)}`
  d.append(s, pre)
  if (l.archivos.length) {
    const div = document.createElement("div")
    div.className = "archivos"
    for (const ruta of l.archivos) div.append(enlaceArchivo(ruta))
    d.append(div)
  }
  return d
}

function quitarAvisosConfirmacion() {
  for (const el of mensajes.querySelectorAll(".aviso-confirmacion")) el.remove()
}

function pintar(entrada: Entrada, esUltima: boolean) {
  bienvenida.hidden = true
  const div = document.createElement("article")
  if (entrada.rol === "usuario") {
    div.className = "mensaje usuario"
    div.textContent = entrada.texto
    mensajes.append(div)
    return
  }
  div.className = `mensaje asistente${entrada.error ? " error" : ""}${entrada.needsConfirmation ? " confirmacion" : ""}`
  if (entrada.toolCalls?.length) {
    const lista = document.createElement("div")
    lista.className = "herramientas"
    for (const l of entrada.toolCalls) lista.append(tarjetaHerramienta(l))
    div.append(lista)
  }
  const cuerpo = document.createElement("div")
  cuerpo.className = "markdown"
  cuerpo.innerHTML = markdown(entrada.texto)
  div.append(cuerpo)
  if (entrada.needsConfirmation && esUltima) {
    const aviso = document.createElement("div")
    aviso.className = "aviso-confirmacion"
    const titulo = document.createElement("strong")
    titulo.textContent = "⚠ El agente espera tu confirmación antes de continuar."
    const si = document.createElement("button")
    si.type = "button"
    si.textContent = "Sí, confirmo"
    si.onclick = () => void mandar("Sí, confirmo.")
    const no = document.createElement("button")
    no.type = "button"
    no.className = "secundario"
    no.textContent = "No, todavía no"
    no.onclick = () => void mandar("No, todavía no.")
    aviso.append(titulo, si, no)
    div.append(aviso)
  }
  mensajes.append(div)
}

function actualizarPie(tokens?: { entrada: number; salida: number }) {
  pie.textContent = sessionId
    ? `Sesión ${sessionId.slice(0, 8)}…${tokens ? ` · tokens: ${tokens.entrada.toLocaleString("es-CO")} entrada / ${tokens.salida.toLocaleString("es-CO")} salida` : ""}`
    : "Sesión nueva"
}

function marcarOcupado(si: boolean) {
  ocupado = si
  enviar.disabled = si
  pensando.hidden = !si
  if (!si) return
  const inicio = Date.now()
  const timer = setInterval(() => {
    if (!ocupado) return clearInterval(timer)
    pensandoTexto.textContent = `El agente está trabajando… ${Math.round((Date.now() - inicio) / 1000)} s`
  }, 1000)
  pensandoTexto.textContent = "El agente está pensando…"
}

async function mandar(mensaje: string) {
  if (ocupado || !mensaje.trim()) return
  quitarAvisosConfirmacion()
  pintar({ rol: "usuario", texto: mensaje }, true)
  texto.value = ""
  marcarOcupado(true)
  bajar()
  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId ?? undefined, message: mensaje }),
    })
    const datos = (await res.json()) as RespuestaChat | { ok: false; error: string }
    if (!res.ok || !("reply" in datos)) {
      const err = "error" in datos ? datos.error : `Error ${res.status}`
      if (res.status === 404) {
        sessionId = null
        guardado.escribir("reto02.sesion", null)
      }
      pintar({ rol: "asistente", texto: `⚠️ ${err}`, error: err }, true)
      return
    }
    sessionId = datos.sessionId
    guardado.escribir("reto02.sesion", sessionId)
    pintar({ rol: "asistente", texto: datos.reply, toolCalls: datos.toolCalls, needsConfirmation: datos.needsConfirmation, error: datos.error }, true)
    actualizarPie(datos.tokensSesion)
  } catch {
    pintar({ rol: "asistente", texto: "⚠️ No hay conexión con el servidor. Revisa que esté en marcha e intenta de nuevo.", error: "red" }, true)
  } finally {
    marcarOcupado(false)
    bajar()
    texto.focus()
  }
}

async function iniciar() {
  try {
    const salud = (await (await fetch("/api/health")).json()) as { provider: string; model: string }
    $<HTMLElement>("proveedor").textContent = `${salud.provider} · ${salud.model}`
  } catch {
    $<HTMLElement>("proveedor").textContent = "servidor no disponible"
  }

  const atajos: Array<[string, string]> = [
    [
      "Procesar el buzón (2026-09-03)",
      "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.",
    ],
    ["Ver alertas (2026-09-03)", "Genera el reporte de alertas con fecha de hoy 2026-09-03."],
  ]
  for (const [etiqueta, mensaje] of atajos) {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "secundario"
    b.textContent = etiqueta
    b.onclick = () => void mandar(mensaje)
    $<HTMLElement>("casos").append(b)
  }
  try {
    const res = await api("/api/buzon")
    const datos = (await res.json()) as { ok: boolean; data?: { pendientes: number; procesados: number } }
    if (datos.data) $<HTMLElement>("estado-buzon").textContent = `Buzón: ${datos.data.pendientes} mensajes pendientes · ${datos.data.procesados} procesados.`
  } catch {
    /* el estado del buzón es solo informativo */
  }

  if (sessionId) {
    const res = await api(`/api/sessions/${encodeURIComponent(sessionId)}`)
    if (res.ok) {
      const datos = (await res.json()) as { historial: Entrada[]; tokens: { entrada: number; salida: number } }
      datos.historial.forEach((e, i) => pintar(e, i === datos.historial.length - 1))
      actualizarPie(datos.tokens)
      bajar()
    } else {
      sessionId = null
      guardado.escribir("reto02.sesion", null)
    }
  }
  actualizarPie()
}

formulario.addEventListener("submit", (ev) => {
  ev.preventDefault()
  void mandar(texto.value)
})
texto.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault()
    void mandar(texto.value)
  }
})
$<HTMLButtonElement>("nueva").addEventListener("click", () => {
  sessionId = null
  guardado.escribir("reto02.sesion", null)
  mensajes.replaceChildren()
  bienvenida.hidden = false
  actualizarPie()
})

void iniciar()

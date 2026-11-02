# Periferia IT · Retos técnicos IA (Perxia 2.0)

Tres retos independientes. Cada carpeta es un proyecto completo (backend, chat web, herramientas, `demo.ts`, pruebas, módulo reutilizable y documentación) con su propio `package.json`, y se puede levantar y entregar por separado.

| Carpeta | Reto | Link de prueba | Documentación |
|---|---|---|---|
| [`reto-01/`](reto-01/) | Agente "Registro como Proveedor" | <https://periferia-reto-01-proveedor-zsrc.onrender.com> | [README](reto-01/README.md) · [SOLUCION](reto-01/SOLUCION.md) · [PRD](reto-01/PRD.md) |
| [`reto-02/`](reto-02/) | Agente "Registro de Contratos Vigentes" | <https://periferia-reto-02-contratos-kn54.onrender.com> | [README](reto-02/README.md) · [SOLUCION](reto-02/SOLUCION.md) · [PRD](reto-02/PRD.md) |
| [`reto-03/`](reto-03/) | Agente "Órdenes de Compra SAP" | <https://periferia-reto-03-ordenes-compra-hkje.onrender.com> | [README](reto-03/README.md) · [SOLUCION](reto-03/SOLUCION.md) · [PRD](reto-03/PRD.md) |

Los links son públicos, sin clave de acceso. Están en Render (plan gratis), desplegados con el Blueprint [`render.yaml`](render.yaml): si un servicio lleva 15 minutos sin uso, tarda alrededor de un minuto en despertar.

Cada reto trae su enunciado en `PRD.md` y sus datos de prueba en `fixtures/` (entregados por Periferia, no se modifican).

Requisitos: [Bun](https://bun.sh) 1.1+ y una API key de Anthropic para el chat (`demo.ts`, las pruebas y el modo sin modelo funcionan sin clave).

## Verificación rápida (sin clave)

Desde la carpeta de cada reto:

```bash
bun install
bun run demo.ts
bun test
```

El historial de commits de cada reto está en su rama (`feat/reto-01-registro-proveedor`, `feat/reto-02-contratos`, `feat/reto-03-ordenes-compra`), unida a `main` con un commit de merge por reto.

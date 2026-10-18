# Figuras 97 y 98 — Diagramas de clases y BD

Fuente editable (PlantUML). Abre en https://www.plantuml.com/plantuml o en VS Code con la extensión PlantUML.

| Figura | Archivo | Vista |
|--------|---------|--------|
| **97** Diagrama de clases | [`figura97-diagrama-clases.puml`](./figura97-diagrama-clases.puml) | Dominio por paquetes IAM, Billing, Profiles, Team, Finances, Communications, SocialSpaces, Incidents |
| **98** Diagrama de BD | [`figura98-diagrama-bd.puml`](./figura98-diagrama-bd.puml) | Tablas con UUID PK/FK, VARCHAR, DECIMAL, DATETIME |

## Cómo exportar PNG

```bash
# Con plantuml instalado:
plantuml -tpng figura97-diagrama-clases.puml
plantuml -tpng figura98-diagrama-bd.puml
```

O pega el `.puml` en https://www.plantuml.com/plantuml/uml y descarga la imagen.

## Notas (alineación informe)

- Título: **BuildingFlex**
- `Subscription` vive en el paquete **Billing** (contexto aparte, igual que `src/billing` y `BuildingFex.Api.Billing`).
- `Announcement`, `Folder` / `Document` = paquete **Communications** (antes Information + Import), igual que en C4.
- `Conversation` / `Message` están bajo Team en la figura original; en C4 y en código (`src/residentCare`, `BuildingFex.Api.ResidentCare`) viven en Resident Care.

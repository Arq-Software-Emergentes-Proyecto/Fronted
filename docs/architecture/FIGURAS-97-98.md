# Figuras 97 y 98 — Diagramas de clases y BD

Fuente editable (PlantUML). Abre en https://www.plantuml.com/plantuml o en VS Code con la extensión PlantUML.

| Figura | Archivo | Vista |
|--------|---------|--------|
| **97** Diagrama de clases | [`figura97-diagrama-clases.puml`](./figura97-diagrama-clases.puml) | Dominio por paquetes IAM, Profiles, Team, Finances, Information, Import, SocialSpaces, Incidents |
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
- `Subscription` aparece en el paquete IAM (como en la captura). Si en el informe Billing es contexto aparte, mueve la clase `Subscription` al paquete Billing en el `.puml`.
- `Folder` / `Document` = módulo Import en la figura; en C4 ya se documentan como Communications.
- `Conversation` / `Message` están bajo Team en la figura original; en C4 viven en Resident Care.

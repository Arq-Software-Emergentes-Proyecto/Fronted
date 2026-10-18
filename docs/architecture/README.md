# BuildingFlex — Diagramas C4 (Structurizr DSL)

Archivo principal: [`workspace.dsl`](./workspace.dsl)  
Módulo documentos: [`import-workspace.dsl`](./import-workspace.dsl) (vista Communications)

## 9 contextos (todos los diagramas C4 los referencian)

1. IAM  
2. Profiles  
3. Finances  
4. Billing  
5. Spaces  
6. Incidents  
7. Communications  
8. Resident Care  
9. Team  

## Vistas a exportar / actualizar en el informe

| Punto | Vista Structurizr | Archivo |
|-------|-------------------|--------|
| Diagramas: 9 contextos | `SystemLandscape`, `SystemContext`, `Containers`, `NineContexts`, `ApiComponents` | `workspace.dsl` |
| 4.3.3 Billing | `ApiComponents` / `NineContexts` — grupo **4. Billing** | `workspace.dsl` |
| 4.3.4 Deployment | `DeploymentProduction` — nota S/ 450 = tope | `workspace.dsl` |
| Communications (docs) | `CommunicationsContainerView` | `import-workspace.dsl` |

## Cómo usarlo

1. Abre https://structurizr.com/dsl  
2. Pega el contenido de `workspace.dsl`  
3. Exporta cada vista y reemplaza las figuras del informe  

## 4.3.4 — texto sugerido bajo el diagrama de deploy

> Despliegue productivo: **Vercel** (SPA + Edge Mercado Pago) → **Railway** (BuildingFlex.Api + **MySQL**) + Firebase Auth/Storage + Gemini.  
> Los **S/ 450** de infraestructura en el análisis de costos son un **tope de presupuesto** (escenario de referencia tipo Render/PostgreSQL), **no** el costo exacto de este stack.

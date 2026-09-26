# BuildingFex — Diagramas C4 (Structurizr DSL)

Archivo: [`workspace.dsl`](./workspace.dsl)

## Vistas

| Nivel | Key | Qué muestra |
|-------|-----|-------------|
| **4.3.1 Landscape** | `SystemLandscape` | Todas las personas + BuildingFex + Firebase Auth/Storage, Gemini, Mercado Pago (vista de paisaje) |
| **C1** | `SystemContext` | Mismo foco centrado en BuildingFex (contexto del sistema) |
| **C2** | `Containers` | SPA, Edge MP (2º camino), API (1º camino), MySQL + externos |
| **C3 SPA** | `SpaShellIam` | Shell + IAM + apiClient + mock |
| **C3 SPA** | `SpaDomain` | Dominio autenticado + `GuestInviteView` pública |
| **C3 SPA** | `SpaImportSupport` | Import (Storage) + Soporte (SignalR) |
| **C3 API** | `ApiComponents` | Shared Kernel + módulos BC |
| **C4** | `DeploymentProduction` | Vercel → Railway + Firebase + Gemini + MP |
| **C4** | `DeploymentDevLocal` | Vite + API/MySQL local (excluyente) |
| **C4** | `DeploymentDevProxy` | Vite → Railway staging (excluyente) |

## Cómo usarlo

[Structurizr DSL Playground](https://structurizr.com/dsl) — pega todo `workspace.dsl`.

```bash
docker run -it --rm -p 8080:8080 \
  -v "$(pwd)/docs/architecture:/usr/local/structurizr" \
  structurizr/lite
```

## Decisiones (código real)

| Tema | Realidad |
|------|----------|
| Personas C1 | Solo Admin, Residente, Invitado de residente |
| Auth | Firebase idToken + custom claims. Sin App JWT |
| Guest | Componente SPA propio (`guestInviteUi`); sin shell ni Bearer |
| Mercado Pago | **Dos caminos reales**: 1º `/api/v1/payments\|subscription` (token en API); 2º `/mp/*` Edge si falla. Deuda consciente; no colapsado en el diagrama |
| Import | URL firmada V4 → PUT Storage → confirm |
| Soporte | API + SignalR; Gemini solo servidor |
| Dev | Dos entornos excluyentes: local vs proxy |

## Flujos

```
Admin:     Firebase → SPA (idToken) → API → MySQL
Residente: Invite → Google → claims → getIdToken(true) → API
Pago:      SPA → API checkout; si falla → Edge /mp → Mercado Pago
Import:    signed-url → PUT Storage → confirm → RAG worker
Soporte:   REST/SignalR → API → Gemini (+ RAG) → MySQL
Invitado:  /invite/:token → GET reservations?guestInviteToken= (anon)
```

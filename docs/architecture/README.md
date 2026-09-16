# BuildingFex — Diagramas C4 (Structurizr DSL)

Archivo listo para pegar / cargar: [`workspace.dsl`](./workspace.dsl)

## Vistas

| Nivel C4 | Key en Structurizr | Qué muestra |
|----------|--------------------|-------------|
| **C1 Contexto** | `SystemContext` | Personas (Visitante, Admin, Residente, Invitado) + BuildingFex + Firebase Auth, Firestore, RTDB, Gemini, Mercado Pago |
| **C2 Contenedores** | `Containers` | SPA Vue 3, Edge MP, BuildingFex.Api (.NET 10), MySQL + externos |
| **C3 SPA** | `SpaComponents` | Shell, IAM, dashboards, finanzas, espacios, incidencias, import, soporte (RTDB+Gemini), settings, apiClient, mock DEV |
| **C3 API** | `ApiComponents` | Shared Kernel, IAM/JWT+Firebase, Users, Subscription, Payments, Finances Compat, Spaces, Incidents, Announcements, Import, Team, Support legacy |
| **C4 Deploy prod** | `DeploymentProduction` | Vercel (SPA + rewrites + `/api/mp`) → Railway (API + MySQL) + Google/Firebase + MP |
| **C4 Deploy dev** | `DeploymentDevelopment` | Vite mock-first, API local u Railway, mismos SaaS |

## Cómo usarlo en Structurizr

### Opción A — DSL Playground (pegar)
1. Abre https://structurizr.com/dsl
2. Borra el ejemplo
3. Pega **todo** el contenido de `workspace.dsl`
4. Renderiza y elige cada vista en el menú

### Opción B — Structurizr Lite (archivo)
1. Docker: `docker run -it --rm -p 8080:8080 -v $(pwd)/docs/architecture:/usr/local/structurizr structurizr/lite`
2. Abre http://localhost:8080
3. El workspace carga `workspace.dsl` de esa carpeta

## Decisiones reflejadas (actualizadas 2026)

| Tema | Realidad en código |
|------|--------------------|
| Núcleo de negocio | **BuildingFex.Api** + **MySQL** (Railway), no Firebase como backend de dominio |
| Auth admin | Firebase email/password → **Firebase ID token** como Bearer; API valida JWKS + upsert `/users` con uid |
| Auth residente | Google → `sign-in-google` / `complete-google` → **JWT propio** de la API |
| Multi-tenancy | Query `ownerAdminId` + claims JWT |
| Superficie API | `/api/v1/*` (auth, subscription, payments) + **Compat flat** (`/users`, `/incidents`, …) |
| Soporte | **Firebase RTDB** (mensajes) + **Gemini** (IA). `/supportChats` = legacy |
| Pagos | API MercadoPago SDK **y/o** edge Vercel `/mp/*` |
| Dev | Vite **mock-first** (el proxy a Railway suele quedar opacado por el mock) |
| Deploy front | Vercel rewrites Compat + `/api/v1` → `backend-production-*.up.railway.app` |

## Flujos clave (para narrar el diagrama)

```
Admin:     Browser → Firebase Auth → SPA (ID token) → API [Authorize Firebase|JWT] → MySQL
Residente: Browser → Google/Firebase → SPA → POST sign-in-google → API JWT → MySQL
Soporte:   Browser → Gemini + RTDB (sin pasar por MySQL para el chat en vivo)
Pago:      SPA → API /api/v1/.../checkout  (fallback → Vercel /mp → Mercado Pago)
Huésped:   Browser → /invite/:token → GET /reservations?guestInviteToken= (AllowAnonymous)
```

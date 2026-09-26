workspace "BuildingFex" "Plataforma multi-tenant de gestión de condominios: cobros, áreas comunes, incidencias, comunicados, importaciones, suscripciones y soporte (IA + SignalR) entre administración y residentes." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        # ═══════════════════════════════════════════
        # Personas (solo estas tres)
        # ═══════════════════════════════════════════
        admin = person "Administrador" "Junta/admin del edificio. Login/registro Firebase; gestiona residentes, finanzas, espacios, incidencias, comunicados, importaciones, equipo y ayuda a residentes."
        resident = person "Residente" "Habitante de una unidad. Invite Google → idToken; cuotas, pagos, reservas, incidencias y soporte IA."
        guest = person "Invitado de residente" "Externo invitado a una reserva. Abre /invite/:token (QR) sin cuenta ni Bearer."

        # ═══════════════════════════════════════════
        # Sistemas externos
        # ═══════════════════════════════════════════
        group "Google / Firebase" {
            firebaseAuth = softwareSystem "Firebase Authentication" "Identidad única: admin email/password; residente Google. idToken + custom claims (role, ownerAdminId). RevokeRefreshTokens al dar de baja." "External"
            firebaseStorage = softwareSystem "Firebase Storage" "Objetos de importación. SPA PUT con URL firmada V4; API firma y confirma con getMetadata." "External"
            gemini = softwareSystem "Google Gemini API" "Embeddings (RAG import) y generateContent (soporte). Solo desde BuildingFex.Api." "External"
        }

        mercadoPago = softwareSystem "Mercado Pago" "Checkout Pro: suscripción admin y cuotas residente. Preferencias, init_point, webhooks." "External"

        # ═══════════════════════════════════════════
        # Sistema BuildingFex
        # ═══════════════════════════════════════════
        buildingFex = softwareSystem "BuildingFex" "Web multi-tenant. Dominio en BuildingFex.Api + MySQL; identidad Firebase; archivos Storage; pagos MP; IA Gemini en servidor." {

            spa = container "BuildingFex Web SPA" "Paneles admin/residente, auth, vista pública de invitado. Prod: Vercel + rewrites Railway. Dev: Vite mock-first o proxy." "Vue 3.5, Vite 6, Vue Router 4, PrimeVue 4, Axios, Firebase JS SDK" {

                shellUi = component "App Shell & Router" "Nav por rol, guards de sesión (Firebase idToken en localStorage), i18n es/en. App.vue, AppShellView." "Vue 3 SFC"
                iamUi = component "IAM / Auth UI" "Admin: Firebase → profiles. Residente: invite 128-bit → Google → complete-google → getIdToken(true). AuthView, sessionStore, authApi." "Vue 3 SFC"
                dashboardUi = component "Dashboard UI" "Admin: KPI, deuda, incidencias, espacios. Residente: resumen financiero, comunicados, reservas. AppDashboardView, AppResidentDashboardView." "Vue 3 SFC"
                residentsUi = component "Residentes & Gestión avanzada UI" "Alta residentes, InviteToken, espacios CRUD autenticado. AppAdvancedManagementView, residentsApi, spacesApi." "Vue 3 SFC"
                financesUi = component "Finanzas & Cobros UI" "Admin: recibos, settings, late fees. Residente: por pagar + historial. AppFinanceView, AppResidentFinanceView." "Vue 3 SFC"
                spacesUi = component "Espacios & Generación UI" "Reservas autenticadas admin/residente, solapes, lista invitados (máx 5), genera QR. AppGenerationView, reservationsApi." "Vue 3 SFC"
                guestInviteUi = component "Invitación pública de reserva" "Ruta AllowAnonymous /invite/:token. Sin shell ni Bearer. GuestInviteView." "Vue 3 SFC"
                incidentsUi = component "Incidencias & Proveedores UI" "Tablero open/in-progress/resolved; catálogo serviceProviders. AppIncidentsView, incidentsApi." "Vue 3 SFC"
                informationUi = component "Información / Comunicados UI" "Announcements (prioridad, vigencia). AppInformationView, announcementsApi." "Vue 3 SFC"
                importUi = component "Importaciones UI" "Carpetas + signed-url → PUT Storage → confirm. AppImportView, importUploadsApi." "Vue 3 SFC"
                supportUi = component "Soporte UI (IA + SignalR)" "Chat IA REST + hub /hubs/support. Sin Gemini en browser. AppResidentSupportView, AppAdminResidentHelpView, supportApi." "Vue 3 SFC"
                settingsUi = component "Ajustes & Suscripción UI" "Perfil /api/v1/profiles; planes free/essential/standard/scale. AppSettingsView, subscriptionApi." "Vue 3 SFC"
                teamUi = component "Equipo UI" "CRUD teamWorkers. AppTeamView, teamWorkersApi." "Vue 3 SFC"
                apiClientComp = component "API Client & Multi-tenancy" "Axios Bearer Firebase idToken; withOwnerParams(ownerAdminId). apiClient.js, ownerQuery." "Axios"
                mpClientComp = component "Mercado Pago Client" "Intenta /api/v1/payments|subscription; si falla → fetch /mp/* (Edge). Dual path real en mercadoPagoService / subscriptionApi." "Fetch / Axios"
                mockDevComp = component "Vite Preview Mock (solo DEV)" "Emula Compat + /api/v1 sobre .local-mock-db.json (mock-first). previewMockApiPlugin." "Vite plugin"
            }

            # Dual path real: API (.NET SDK) y Edge (Vercel/Vite) ambos tienen MP_ACCESS_TOKEN.
            mpEdge = container "Mercado Pago Edge" "Serverless checkout/consulta. Prod: Vercel /api/mp. Dev: Vite plugin. Camino 2 si falla el checkout de la API." "Node.js — Vercel Serverless / Vite plugin"

            api = container "BuildingFex.Api" "Modular monolith. Auth Firebase Bearer + claims. /api/v1 + Compat. Workers RAG + orphan. SignalR SupportHub. Camino 1 de checkout MP." "ASP.NET Core 10, EF Core, MySQL, Firebase Admin, MercadoPago SDK" {

                sharedKernel = component "Shared Kernel" "AppDbContext, UnitOfWork, Result, RailwayHosting, SchemaUpgrade, snake_case, /health." "ASP.NET Core / EF Core"
                authMod = component "IAM — Authentication" "Invite 128-bit, complete-google, sign-in-google. SetCustomUserClaims. Sin App JWT." "ASP.NET Core"
                usersMod = component "IAM — Users & Residents" "/api/v1/users: CRUD residentes, tenancy por claims, delete+revoke. InviteToken. Plan solo en admin." "ASP.NET Core"
                profilesMod = component "Profiles" "/api/v1/profiles: name, dni, company, ruc, address. First-user-wins admin." "ASP.NET Core"
                subscriptionMod = component "Subscriptions & Plans" "GET/PATCH plan; checkout/confirm MP. Límites 9/15/40/80." "ASP.NET Core"
                paymentsMod = component "Payments (Mercado Pago)" "preference, checkout, confirm, webhook cuotas. Reconcilia receipts/fees." "ASP.NET Core"
                financesMod = component "Finances Compat" "receipts, fees, financeSettings, kpi, expenses, utilities, extras, payouts." "ASP.NET Core"
                spacesMod = component "Social Spaces & Reservations" "socialSpaces; reservations + overlap; GET público guestInviteToken AllowAnonymous." "ASP.NET Core"
                incidentsMod = component "Incidents & Service Providers" "CRUD incidents; CRUD serviceProviders." "ASP.NET Core"
                announcementsMod = component "Information / Announcements" "CRUD announcements por ownerAdminId." "ASP.NET Core"
                importMod = component "Import Documents" "signed-url V4 + confirm getMetadata; pending_upload; orphan cleanup; RAG index worker." "ASP.NET Core"
                teamMod = component "Team Workers" "CRUD teamWorkers." "ASP.NET Core"
                supportMod = component "Support (IA + SignalR)" "/api/v1/support + SupportHub. Gemini en servidor. RAG. Escalado = 2da fila admin ligada." "ASP.NET Core"
            }

            database = container "MySQL Database" "users, profiles, finances, social_spaces/reservations, incidents, announcements, import_*, ai_context_chunks, support_chats/messages, team_workers." "MySQL 8.x" {
                tags "Database"
            }
        }

        # Personas → contenedor SPA (Structurizr infiere → software system)
        admin -> buildingFex.spa "Login/registro y /app/*" "HTTPS"
        resident -> buildingFex.spa "Invite/Google y /app/resident/*" "HTTPS"
        guest -> buildingFex.spa "Abre /invite/:token (sin login)" "HTTPS"

        # Contenedores
        buildingFex.spa -> buildingFex.api "REST + SignalR (Bearer Firebase idToken)" "HTTPS / WSS"
        buildingFex.spa -> firebaseAuth "signIn / createUser / Google popup / getIdToken" "HTTPS"
        buildingFex.spa -> firebaseStorage "PUT objeto con URL firmada" "HTTPS"
        buildingFex.spa -> buildingFex.mpEdge "2º camino: /mp/checkout si falla API" "HTTPS"

        buildingFex.mpEdge -> mercadoPago "Preferencias y payments (token en Edge)" "HTTPS"

        buildingFex.api -> buildingFex.database "EF Core + SchemaUpgrade" "SQL/TCP"
        buildingFex.api -> mercadoPago "1º camino: checkout/confirm + webhook (token en API)" "HTTPS"
        buildingFex.api -> firebaseAuth "JWKS + Admin SDK (claims, revoke)" "HTTPS"
        buildingFex.api -> firebaseStorage "Firma V4 + getObject/getMetadata/delete" "HTTPS"
        buildingFex.api -> gemini "generateContent + embeddings" "HTTPS"

        # Componentes SPA — personas
        admin -> buildingFex.spa.shellUi "Navega admin"
        admin -> buildingFex.spa.iamUi "Login / registro"
        resident -> buildingFex.spa.shellUi "Navega residente"
        resident -> buildingFex.spa.iamUi "Invite / Google login"
        guest -> buildingFex.spa.guestInviteUi "GuestInviteView (sin shell)"

        buildingFex.spa.shellUi -> buildingFex.spa.dashboardUi "Dashboard"
        buildingFex.spa.shellUi -> buildingFex.spa.residentsUi "Gestión avanzada"
        buildingFex.spa.shellUi -> buildingFex.spa.financesUi "Finanzas"
        buildingFex.spa.shellUi -> buildingFex.spa.spacesUi "Espacios autenticados"
        buildingFex.spa.shellUi -> buildingFex.spa.incidentsUi "Incidencias"
        buildingFex.spa.shellUi -> buildingFex.spa.informationUi "Información"
        buildingFex.spa.shellUi -> buildingFex.spa.importUi "Import"
        buildingFex.spa.shellUi -> buildingFex.spa.supportUi "Soporte"
        buildingFex.spa.shellUi -> buildingFex.spa.settingsUi "Ajustes"
        buildingFex.spa.shellUi -> buildingFex.spa.teamUi "Equipo"
        buildingFex.spa.shellUi -> buildingFex.spa.iamUi "Sesión inválida → login"
        # guestInviteUi NO cuelga del shell (ruta pública)

        buildingFex.spa.spacesUi -> buildingFex.spa.guestInviteUi "Genera URL/QR /invite/:token"

        buildingFex.spa.iamUi -> firebaseAuth "Auth SDK" "HTTPS"
        buildingFex.spa.iamUi -> buildingFex.spa.apiClientComp "invite, complete-google, profiles, users"

        buildingFex.spa.dashboardUi -> buildingFex.spa.apiClientComp "KPI, incidents, spaces"
        buildingFex.spa.residentsUi -> buildingFex.spa.apiClientComp "/api/v1/users, socialSpaces"
        buildingFex.spa.financesUi -> buildingFex.spa.apiClientComp "receipts, fees, settings"
        buildingFex.spa.financesUi -> buildingFex.spa.mpClientComp "Pago cuotas (API→Edge)"
        buildingFex.spa.spacesUi -> buildingFex.spa.apiClientComp "socialSpaces, reservations (auth)"
        buildingFex.spa.guestInviteUi -> buildingFex.spa.apiClientComp "GET reservations?guestInviteToken= (anon)"
        buildingFex.spa.incidentsUi -> buildingFex.spa.apiClientComp "incidents, serviceProviders"
        buildingFex.spa.informationUi -> buildingFex.spa.apiClientComp "announcements"
        buildingFex.spa.importUi -> buildingFex.spa.apiClientComp "signed-url + confirm"
        buildingFex.spa.importUi -> firebaseStorage "PUT firmado" "HTTPS"
        buildingFex.spa.teamUi -> buildingFex.spa.apiClientComp "teamWorkers"
        buildingFex.spa.settingsUi -> buildingFex.spa.apiClientComp "profiles + subscription"
        buildingFex.spa.settingsUi -> buildingFex.spa.mpClientComp "Checkout plan (API→Edge)"
        buildingFex.spa.supportUi -> buildingFex.spa.apiClientComp "REST support + SignalR"

        buildingFex.spa.apiClientComp -> buildingFex.api "Compat + /api/v1 + /hubs/support" "HTTPS/WSS"
        buildingFex.spa.mpClientComp -> buildingFex.api "1º /api/v1/payments|subscription" "HTTPS"
        buildingFex.spa.mpClientComp -> buildingFex.mpEdge "2º /mp/* si API falla" "HTTPS"
        buildingFex.spa.mockDevComp -> buildingFex.spa.apiClientComp "DEV mock-first"

        # Componentes API
        buildingFex.spa.apiClientComp -> buildingFex.api.authMod "Auth + invites"
        buildingFex.spa.apiClientComp -> buildingFex.api.usersMod "/api/v1/users"
        buildingFex.spa.apiClientComp -> buildingFex.api.profilesMod "/api/v1/profiles"
        buildingFex.spa.apiClientComp -> buildingFex.api.subscriptionMod "subscription"
        buildingFex.spa.apiClientComp -> buildingFex.api.paymentsMod "payments"
        buildingFex.spa.apiClientComp -> buildingFex.api.financesMod "finanzas"
        buildingFex.spa.apiClientComp -> buildingFex.api.spacesMod "espacios + guest token"
        buildingFex.spa.apiClientComp -> buildingFex.api.incidentsMod "incidencias"
        buildingFex.spa.apiClientComp -> buildingFex.api.announcementsMod "comunicados"
        buildingFex.spa.apiClientComp -> buildingFex.api.importMod "import"
        buildingFex.spa.apiClientComp -> buildingFex.api.teamMod "equipo"
        buildingFex.spa.apiClientComp -> buildingFex.api.supportMod "support + hub"

        buildingFex.api.authMod -> buildingFex.api.sharedKernel "Db / Result"
        buildingFex.api.usersMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.profilesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.financesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.spacesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.incidentsMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.announcementsMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.importMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.teamMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.supportMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.subscriptionMod -> buildingFex.api.sharedKernel "Users + planes"
        buildingFex.api.paymentsMod -> buildingFex.api.sharedKernel "Receipts"

        buildingFex.api.sharedKernel -> buildingFex.database "ORM / SQL"
        buildingFex.api.authMod -> firebaseAuth "JWKS + claims"
        buildingFex.api.importMod -> firebaseStorage "Firma + metadata + delete"
        buildingFex.api.importMod -> gemini "Embeddings RAG"
        buildingFex.api.supportMod -> gemini "generateContent + retrieve RAG"
        buildingFex.api.subscriptionMod -> mercadoPago "Checkout plan (token API)"
        buildingFex.api.paymentsMod -> mercadoPago "Checkout cuotas + webhook (token API)"

        # ═══════════════════════════════════════════
        # Deployment: Production
        # ═══════════════════════════════════════════
        deploymentEnvironment "Production" {
            deploymentNode "Dispositivo del usuario" "Browser" {
                browserInstance = containerInstance buildingFex.spa
            }

            deploymentNode "Vercel" "CDN + Static + Serverless. Rewrites /api/v1/* y Compat → Railway; /mp/* → /api/mp." {
                deploymentNode "Edge / Static Hosting" {
                    spaProd = containerInstance buildingFex.spa
                }
                deploymentNode "Serverless Functions" "Node.js — 2º camino MP" {
                    mpProd = containerInstance buildingFex.mpEdge
                }
            }

            deploymentNode "Railway" "PaaS. Docker ASP.NET. Env: Firebase, MYSQL_*, MercadoPago__* (1º camino), Gemini." {
                deploymentNode "Web Service — BuildingFex.Api" "net10.0 / Docker" {
                    apiProd = containerInstance buildingFex.api
                }
                deploymentNode "MySQL Plugin / Managed DB" {
                    dbProd = containerInstance buildingFex.database
                }
            }

            deploymentNode "Google Cloud / Firebase" {
                firebaseAuthProd = softwareSystemInstance firebaseAuth
                storageProd = softwareSystemInstance firebaseStorage
                geminiProd = softwareSystemInstance gemini
            }

            deploymentNode "Mercado Pago Cloud" {
                mpCloudProd = softwareSystemInstance mercadoPago
            }
        }

        # ═══════════════════════════════════════════
        # Development (local) — excluyente de proxy
        # ═══════════════════════════════════════════
        deploymentEnvironment "Development (local)" {
            deploymentNode "Developer Machine" {
                deploymentNode "Vite Dev Server" "localhost:5173 — mock-first + viteMercadoPagoPlugin" {
                    spaDevLocal = containerInstance buildingFex.spa
                    mpDevLocal = containerInstance buildingFex.mpEdge
                }
                deploymentNode "Local API + MySQL" "dotnet run + Docker MySQL 8.4" {
                    apiDevLocal = containerInstance buildingFex.api
                    dbDevLocal = containerInstance buildingFex.database
                }
            }

            deploymentNode "External SaaS (dev keys)" {
                firebaseAuthDevLocal = softwareSystemInstance firebaseAuth
                storageDevLocal = softwareSystemInstance firebaseStorage
                geminiDevLocal = softwareSystemInstance gemini
                mpDevCloudLocal = softwareSystemInstance mercadoPago
            }
        }

        # ═══════════════════════════════════════════
        # Development (proxy) — excluyente de local API
        # ═══════════════════════════════════════════
        deploymentEnvironment "Development (proxy)" {
            deploymentNode "Developer Machine" {
                deploymentNode "Vite Dev Server" "localhost:5173 — proxy VITE_API_PROXY_TARGET (mock puede opacarlo)" {
                    spaDevProxy = containerInstance buildingFex.spa
                    mpDevProxy = containerInstance buildingFex.mpEdge
                }
            }

            deploymentNode "Railway (API staging)" {
                apiDevRemote = containerInstance buildingFex.api
                dbDevRemote = containerInstance buildingFex.database
            }

            deploymentNode "External SaaS (dev keys)" {
                firebaseAuthDevProxy = softwareSystemInstance firebaseAuth
                storageDevProxy = softwareSystemInstance firebaseStorage
                geminiDevProxy = softwareSystemInstance gemini
                mpDevCloudProxy = softwareSystemInstance mercadoPago
            }
        }
    }

    views {
        # C0 / 4.3.1 — Landscape: todas las personas y sistemas (BuildingFex + externos)
        systemLandscape "SystemLandscape" {
            include *
            autoLayout lr 500 380
            description "4.3.1 System Landscape — Personas (Admin, Residente, Invitado) y sistemas: BuildingFex + Firebase Auth, Storage, Gemini, Mercado Pago."
        }

        systemContext buildingFex "SystemContext" {
            include *
            autoLayout lr 450 350
            description "C1 — Administrador, Residente, Invitado de residente ↔ BuildingFex. Externos: Firebase Auth, Storage, Gemini, Mercado Pago."
        }

        container buildingFex "Containers" {
            include *
            autoLayout lr 500 380
            description "C2 — SPA, Edge MP (2º camino), API (1º camino MP), MySQL + Auth/Storage/Gemini/MP. Dual checkout documentado, no colapsado."
        }

        # C3 SPA partido (legibilidad) — ids jerárquicos: buildingFex.spa.*
        component buildingFex.spa "SpaShellIam" {
            include buildingFex.spa.shellUi buildingFex.spa.iamUi buildingFex.spa.apiClientComp buildingFex.spa.mockDevComp firebaseAuth admin resident
            autoLayout lr 480 360
            description "C3 SPA — Shell + IAM. Admin/residente autenticados; mock DEV."
        }

        component buildingFex.spa "SpaDomain" {
            include buildingFex.spa.shellUi buildingFex.spa.dashboardUi buildingFex.spa.residentsUi buildingFex.spa.financesUi buildingFex.spa.spacesUi buildingFex.spa.guestInviteUi buildingFex.spa.incidentsUi buildingFex.spa.informationUi buildingFex.spa.settingsUi buildingFex.spa.teamUi buildingFex.spa.apiClientComp buildingFex.spa.mpClientComp guest
            autoLayout lr 500 380
            description "C3 SPA — Dominio autenticado + GuestInviteView pública (sin shell)."
        }

        component buildingFex.spa "SpaImportSupport" {
            include buildingFex.spa.shellUi buildingFex.spa.importUi buildingFex.spa.supportUi buildingFex.spa.apiClientComp firebaseStorage
            autoLayout lr 480 360
            description "C3 SPA — Import (signed PUT Storage) + Soporte (REST/SignalR, sin Gemini en browser)."
        }

        component buildingFex.api "ApiComponents" {
            include *
            autoLayout lr 500 400
            description "C3 API — Shared Kernel + IAM Firebase-only + Profiles + dominio + Import firmado + Support SignalR/RAG."
        }

        deployment buildingFex "Production" "DeploymentProduction" {
            include *
            autoLayout tb 450 350
            description "C4 Prod — Browser → Vercel (SPA + Edge MP) → Railway (API + MySQL) + Firebase + Gemini + MP."
        }

        deployment buildingFex "Development (local)" "DeploymentDevLocal" {
            include *
            autoLayout tb 450 350
            description "C4 Dev local — Vite + API/MySQL en máquina. Excluyente del modo proxy."
        }

        deployment buildingFex "Development (proxy)" "DeploymentDevProxy" {
            include *
            autoLayout tb 450 350
            description "C4 Dev proxy — Vite → Railway staging. Excluyente del modo local."
        }

        styles {
            element "Person" {
                shape Person
                background #0b3d5c
                color #ffffff
                fontSize 22
            }
            element "Software System" {
                background #1a6aa8
                color #ffffff
            }
            element "External" {
                background #7a7a7a
                color #ffffff
            }
            element "Container" {
                background #3d8fd1
                color #ffffff
            }
            element "Component" {
                background #9ec9ef
                color #000000
            }
            element "Database" {
                shape Cylinder
                background #2f6f9f
                color #ffffff
            }
            relationship "Relationship" {
                routing Orthogonal
                color #555555
                fontSize 18
            }
        }
    }
}

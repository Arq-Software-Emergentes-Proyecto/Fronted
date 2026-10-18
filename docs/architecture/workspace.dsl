workspace "BuildingFlex" "Plataforma multi-tenant de gestión de condominios: cobros, áreas comunes, incidencias, comunicados, importaciones, suscripciones y atención al residente (Resident Care)." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        # ═══════════════════════════════════════════
        # Personas (solo estas tres)
        # ═══════════════════════════════════════════
        admin = person "Administrador" "Junta o admin del edificio."
        resident = person "Residente" "Habitante de una unidad. Cuotas, pagos, reservas, incidencias y atención al residente (Resident Care)."
        guest = person "Invitado de residente" "Externo invitado a una reserva. Sin cuenta."

        # ═══════════════════════════════════════════
        # Sistemas externos
        # ═══════════════════════════════════════════
        group "Google / Firebase" {
            firebaseAuth = softwareSystem "Firebase Authentication" "Identidad única: admin email/password; residente Google. idToken + custom claims (role, ownerAdminId). RevokeRefreshTokens al dar de baja." "External"
            firebaseStorage = softwareSystem "Firebase Storage" "Documentos del edificio (reglamentos y actas) y archivos Excel de importación. SPA PUT con URL firmada V4; API firma y confirma con getMetadata." "External"
            gemini = softwareSystem "Google Gemini API" "Embeddings y generateContent para Resident Care e Incidents (vía gateway de IA)." "External"
        }

        mercadoPago = softwareSystem "Mercado Pago" "Checkout Pro: suscripción admin y cuotas residente. Preferencias, init_point, webhooks." "External"

        # ═══════════════════════════════════════════
        # Sistema BuildingFex
        # ═══════════════════════════════════════════
        buildingFex = softwareSystem "BuildingFlex" "Gestión de condominios." {

            spa = container "BuildingFlex Web SPA" "Paneles admin/residente, auth, vista pública de invitado. Prod: Vercel + rewrites Railway. Dev: Vite mock-first o proxy." "Vue 3.5, Vite 6, Vue Router 4, PrimeVue 4, Axios, Firebase JS SDK" {

                shellUi = component "App Shell & Router" "Nav por rol, guards de sesión (Firebase idToken en localStorage), i18n es/en. App.vue, AppShellView." "Vue 3 SFC"
                iamUi = component "IAM / Auth UI" "Admin: Firebase → profiles. Residente: invite 128-bit → Google → complete-google → getIdToken(true). AuthView, sessionStore, authApi." "Vue 3 SFC"
                dashboardUi = component "Dashboard UI" "Admin: KPI, deuda, incidencias, espacios. Residente: resumen financiero, comunicados, reservas. AppDashboardView, AppResidentDashboardView." "Vue 3 SFC"
                residentsUi = component "Residentes & Gestión avanzada UI" "Alta residentes, InviteToken, espacios CRUD autenticado. AppAdvancedManagementView, residentsApi, spacesApi." "Vue 3 SFC"
                financesUi = component "Finanzas & Cobros UI" "Admin: recibos, settings, late fees. Residente: por pagar + historial. AppFinanceView, AppResidentFinanceView." "Vue 3 SFC"
                spacesUi = component "Espacios & Generación UI" "Reservas autenticadas admin/residente, solapes, lista invitados (máx 5), genera QR. AppGenerationView, reservationsApi." "Vue 3 SFC"
                guestInviteUi = component "Invitación pública de reserva" "Ruta AllowAnonymous /invite/:token. Sin shell ni Bearer. GuestInviteView." "Vue 3 SFC"
                incidentsUi = component "Incidencias & Proveedores UI" "Tablero open/in-progress/resolved; catálogo serviceProviders. AppIncidentsView, incidentsApi." "Vue 3 SFC"
                announcementsUi = component "Communications — Comunicados UI" "Announcements (prioridad, vigencia). AppInformationView, announcementsApi." "Vue 3 SFC"
                documentsUi = component "Communications — vista Documentos" "Carpetas + signed-url → PUT Storage → confirm. AppImportView, importUploadsApi." "Vue 3 SFC"
                residentCareUi = component "Resident Care UI (IA + SignalR)" "Chat IA REST + hub /hubs/support. Sin Gemini en browser. AppResidentSupportView, AppAdminResidentHelpView, supportApi." "Vue 3 SFC"
                settingsUi = component "Ajustes (Profiles) & Billing UI" "Perfil /api/v1/profiles; planes free/essential/standard/scale. AppSettingsView, subscriptionApi." "Vue 3 SFC"
                teamUi = component "Equipo UI" "CRUD teamWorkers. AppTeamView, teamWorkersApi." "Vue 3 SFC"
                apiClientComp = component "API Client & Multi-tenancy" "Axios Bearer Firebase idToken; withOwnerParams(ownerAdminId). apiClient.js, ownerQuery." "Axios"
                mpClientComp = component "Mercado Pago Client" "Intenta /api/v1/payments|subscription; si falla → fetch /mp/* (Edge). Dual path real en mercadoPagoService / subscriptionApi." "Fetch / Axios"
                mockDevComp = component "Vite Preview Mock (solo DEV)" "Emula Compat + /api/v1 sobre .local-mock-db.json (mock-first). previewMockApiPlugin." "Vite plugin"
            }

            # Dual path real: API (.NET SDK) y Edge (Vercel/Vite) ambos tienen MP_ACCESS_TOKEN.
            mpEdge = container "Mercado Pago Edge" "Serverless checkout/consulta. Prod: Vercel /api/mp. Dev: Vite plugin. Camino 2 si falla el checkout de la API." "Node.js — Vercel Serverless / Vite plugin"

            api = container "BuildingFlex.Api" "Modular monolith con 9 contextos: IAM, Profiles, Finances, Billing, Spaces, Incidents, Communications, Resident Care, Team. Auth Firebase. SignalR Resident Care. Workers de indexación. Camino 1 checkout MP." "ASP.NET Core 10, EF Core, MySQL, Firebase Admin, MercadoPago SDK" {

                sharedKernel = component "Shared Kernel" "AppDbContext, UnitOfWork, Result, RailwayHosting, SchemaUpgrade, snake_case, /health." "ASP.NET Core / EF Core"

                group "1. IAM" {
                    authMod = component "IAM — Authentication" "Invite 128-bit, complete-google, sign-in-google. SetCustomUserClaims." "ASP.NET Core"
                    usersMod = component "IAM — Users & Residents" "/api/v1/users: CRUD residentes, tenancy por claims, delete+revoke." "ASP.NET Core"
                }

                group "2. Profiles" {
                    profilesMod = component "Profiles" "/api/v1/profiles: name, dni, company, ruc, address. First-user-wins admin." "ASP.NET Core"
                }

                group "3. Finances" {
                    financesMod = component "Finances" "receipts, fees, financeSettings, kpi, expenses, utilities, extras, payouts." "ASP.NET Core"
                    paymentsMod = component "Payments (cuotas MP)" "preference, checkout, confirm, webhook de mantenimiento." "ASP.NET Core"
                }

                group "4. Billing" {
                    billingMod = component "Billing — Suscripción" "Agregado Suscripción: plan, paidUntil. Actualizar suscripción. Eventos SuscripciónActivada, PruebaVencida, PlanCambiado, CobroSuscripciónFallido. /api/v1/subscription." "ASP.NET Core"
                }

                group "5. Spaces" {
                    spacesMod = component "Spaces & Reservations" "socialSpaces; reservations + overlap; guestInviteToken AllowAnonymous." "ASP.NET Core"
                }

                group "6. Incidents" {
                    incidentsMod = component "Incidents & Service Providers" "CRUD incidents; CRUD serviceProviders." "ASP.NET Core"
                }

                group "7. Communications" {
                    announcementsMod = component "Announcements" "CRUD announcements por ownerAdminId." "ASP.NET Core"
                    documentController = component "Document Controller" "Carpetas y documentos: signed-url y confirm." "ASP.NET Core"
                    documentService = component "Document Service" "Cuota, MIME, pending/confirmed. import_folders, import_uploads." "ASP.NET Core"
                }

                group "8. Resident Care" {
                    residentCareMod = component "Resident Care Chat" "REST + SignalR /hubs/support. Escalado = 2da fila admin ligada." "ASP.NET Core"
                    indexingWorker = component "Indexing Worker" "Tras confirm, embebe documento → ai_context_chunks." "HostedService"
                    ragAccess = component "RAG chunks" "Lectura de ai_context_chunks para el asistente." "ASP.NET Core"
                }

                group "9. Team" {
                    teamMod = component "Team Workers" "CRUD teamWorkers." "ASP.NET Core"
                }

                group "Infraestructura compartida" {
                    fileStorage = component "File Storage" "URL firmada V4 y limpieza de huérfanos (pending_upload)." "ASP.NET Core"
                    notificationMod = component "Notification" "Aviso en vivo vía SignalR de Resident Care." "ASP.NET Core"
                    auditMod = component "Audit" "CreatedAt y UpdatedAt (IAuditableEntity)." "ASP.NET Core"
                    aiGateway = component "Gateway de IA" "Único acceso a Gemini: generateContent y embeddings." "ASP.NET Core"
                }
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
        buildingFex.spa.shellUi -> buildingFex.spa.announcementsUi "Comunicados"
        buildingFex.spa.shellUi -> buildingFex.spa.documentsUi "Documentos"
        buildingFex.spa.shellUi -> buildingFex.spa.residentCareUi "Resident Care"
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
        buildingFex.spa.announcementsUi -> buildingFex.spa.apiClientComp "announcements"
        buildingFex.spa.documentsUi -> buildingFex.spa.apiClientComp "signed-url + confirm"
        buildingFex.spa.documentsUi -> firebaseStorage "PUT firmado" "HTTPS"
        buildingFex.spa.teamUi -> buildingFex.spa.apiClientComp "teamWorkers"
        buildingFex.spa.settingsUi -> buildingFex.spa.apiClientComp "profiles + subscription"
        buildingFex.spa.settingsUi -> buildingFex.spa.mpClientComp "Checkout plan (API→Edge)"
        buildingFex.spa.residentCareUi -> buildingFex.spa.apiClientComp "REST support + SignalR"

        buildingFex.spa.apiClientComp -> buildingFex.api "Compat + /api/v1 + /hubs/support" "HTTPS/WSS"
        buildingFex.spa.mpClientComp -> buildingFex.api "1º /api/v1/payments|subscription" "HTTPS"
        buildingFex.spa.mpClientComp -> buildingFex.mpEdge "2º /mp/* si API falla" "HTTPS"
        buildingFex.spa.mockDevComp -> buildingFex.spa.apiClientComp "DEV mock-first"

        # Componentes API
        buildingFex.spa.apiClientComp -> buildingFex.api.authMod "Auth + invites"
        buildingFex.spa.apiClientComp -> buildingFex.api.usersMod "/api/v1/users"
        buildingFex.spa.apiClientComp -> buildingFex.api.profilesMod "/api/v1/profiles"
        buildingFex.spa.apiClientComp -> buildingFex.api.billingMod "subscription / Billing"
        buildingFex.spa.apiClientComp -> buildingFex.api.paymentsMod "payments"
        buildingFex.spa.apiClientComp -> buildingFex.api.financesMod "finanzas"
        buildingFex.spa.apiClientComp -> buildingFex.api.spacesMod "espacios + guest token"
        buildingFex.spa.apiClientComp -> buildingFex.api.incidentsMod "incidencias"
        buildingFex.spa.apiClientComp -> buildingFex.api.announcementsMod "comunicados"
        buildingFex.spa.apiClientComp -> buildingFex.api.documentController "carpetas y documentos"
        buildingFex.spa.apiClientComp -> buildingFex.api.teamMod "equipo"
        buildingFex.spa.apiClientComp -> buildingFex.api.residentCareMod "Resident Care + hub"

        buildingFex.api.authMod -> buildingFex.api.sharedKernel "Db / Result"
        buildingFex.api.usersMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.profilesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.financesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.spacesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.incidentsMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.announcementsMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.documentController -> buildingFex.api.documentService "carpetas y documentos"
        buildingFex.api.documentService -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.documentController -> buildingFex.api.fileStorage "firma y confirm"
        buildingFex.api.documentController -> buildingFex.api.indexingWorker "encola"
        buildingFex.api.indexingWorker -> buildingFex.api.aiGateway "embeddings"
        buildingFex.api.indexingWorker -> buildingFex.api.ragAccess "escribe chunks"
        buildingFex.api.ragAccess -> buildingFex.api.sharedKernel "ai_context_chunks"
        buildingFex.api.residentCareMod -> buildingFex.api.ragAccess "recupera contexto"
        buildingFex.api.residentCareMod -> buildingFex.api.aiGateway "generateContent"
        buildingFex.api.residentCareMod -> buildingFex.api.sharedKernel "chats"
        buildingFex.api.fileStorage -> buildingFex.api.sharedKernel "estado upload"
        buildingFex.api.teamMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.billingMod -> buildingFex.api.sharedKernel "Users + planes"
        buildingFex.api.paymentsMod -> buildingFex.api.sharedKernel "Receipts"

        buildingFex.api.sharedKernel -> buildingFex.database "ORM / SQL"
        buildingFex.api.authMod -> firebaseAuth "JWKS + claims"
        buildingFex.api.fileStorage -> firebaseStorage "URL firmada, getMetadata, delete huérfanos"
        buildingFex.api.aiGateway -> gemini "generateContent + embeddings"
        buildingFex.api.billingMod -> mercadoPago "Checkout plan (token API)"
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
                deploymentNode "Web Service — BuildingFlex.Api" "net10.0 / Docker" {
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
        # C0 — solo personas y BuildingFlex (el detalle de proveedores va en el contexto)
        systemLandscape "SystemLandscape" {
            include admin resident guest buildingFex
            exclude firebaseAuth firebaseStorage gemini mercadoPago
            autoLayout lr 420 280
            description "4.3.1 Landscape — BuildingFlex. Internamente: 9 contextos (IAM, Profiles, Finances, Billing, Spaces, Incidents, Communications, Resident Care, Team)."
        }

        systemContext buildingFex "SystemContext" {
            include *
            autoLayout lr 450 350
            description "C1 — BuildingFlex (9 contextos internos) + Firebase Auth, Storage, Gemini, Mercado Pago."
        }

        container buildingFex "Containers" {
            include *
            autoLayout lr 500 380
            description "C2 — SPA, Edge MP, BuildingFlex.Api (9 BC), MySQL + externos. Los 9: IAM, Profiles, Finances, Billing, Spaces, Incidents, Communications, Resident Care, Team."
        }

        # C3 SPA partido (legibilidad) — ids jerárquicos: buildingFex.spa.*
        component buildingFex.spa "SpaShellIam" {
            include buildingFex.spa.shellUi buildingFex.spa.iamUi buildingFex.spa.apiClientComp buildingFex.spa.mockDevComp firebaseAuth admin resident
            autoLayout lr 480 360
            description "C3 SPA — Shell + IAM/Profiles. Admin/residente autenticados."
        }

        component buildingFex.spa "SpaDomain" {
            include buildingFex.spa.shellUi buildingFex.spa.dashboardUi buildingFex.spa.residentsUi buildingFex.spa.financesUi buildingFex.spa.spacesUi buildingFex.spa.guestInviteUi buildingFex.spa.incidentsUi buildingFex.spa.announcementsUi buildingFex.spa.settingsUi buildingFex.spa.teamUi buildingFex.spa.apiClientComp buildingFex.spa.mpClientComp guest
            autoLayout lr 500 380
            description "C3 SPA — Finances, Billing (settings/suscripción), Spaces, Incidents, Communications (anuncios), Team."
        }

        component buildingFex.spa "SpaCommunicationsResidentCare" {
            include buildingFex.spa.shellUi buildingFex.spa.documentsUi buildingFex.spa.residentCareUi buildingFex.spa.apiClientComp firebaseStorage
            autoLayout lr 480 360
            description "C3 SPA — Communications (vista Documentos) + Resident Care."
        }

        component buildingFex.api "ApiComponents" {
            include *
            autoLayout lr 520 420
            description "4.3.3 — 9 contextos: IAM, Profiles, Finances, Billing (Suscripción), Spaces, Incidents, Communications, Resident Care, Team + infraestructura."
        }

        component buildingFex.api "NineContexts" {
            include buildingFex.api.authMod buildingFex.api.usersMod buildingFex.api.profilesMod buildingFex.api.financesMod buildingFex.api.paymentsMod buildingFex.api.billingMod buildingFex.api.spacesMod buildingFex.api.incidentsMod buildingFex.api.announcementsMod buildingFex.api.documentController buildingFex.api.documentService buildingFex.api.residentCareMod buildingFex.api.indexingWorker buildingFex.api.ragAccess buildingFex.api.teamMod
            autoLayout tb 480 360
            description "Los 9 contextos del monolito (sin Shared Kernel ni infra). Incluye Billing separado de Finances."
        }

        deployment buildingFex "Production" "DeploymentProduction" {
            include *
            autoLayout tb 450 350
            description "4.3.4 Prod real: Browser → Vercel (SPA + Edge MP) → Railway (API + MySQL) + Firebase + Gemini + MP. Los S/ 450 de infra en el informe son un TOPE de presupuesto (referencia Render/PostgreSQL), no el costo exacto de este stack."
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

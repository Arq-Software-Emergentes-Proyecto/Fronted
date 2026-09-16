workspace "BuildingFex" "Plataforma multi-tenant de gestión de condominios: cobros, áreas comunes, incidencias, comunicados, importaciones, suscripciones y soporte (IA + tiempo real) entre administración y residentes." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        # ═══════════════════════════════════════════
        # Personas
        # ═══════════════════════════════════════════
        visitor = person "Visitante" "Persona sin sesión que llega a login/registro o a la URL de acceso."
        admin = person "Administrador" "Junta o administrador del edificio. Gestiona residentes, finanzas, espacios, incidencias, comunicados, importaciones, proveedores, equipo y ayuda a residentes."
        resident = person "Residente" "Habitante de una unidad (departamento). Consulta cuotas, paga, reserva áreas comunes, reporta incidencias y usa el asistente de soporte."
        guest = person "Invitado de reserva" "Persona externa que abre /invite/:token (QR) para ver una reserva y hacer check-in de invitados, sin cuenta."

        # ═══════════════════════════════════════════
        # Sistemas externos
        # ═══════════════════════════════════════════
        group "Google / Firebase" {
            firebaseAuth = softwareSystem "Firebase Authentication" "Identidad: admin con email/contraseña; residente con Google Sign-In (popup). Emite ID tokens (JWT RS256) usados por la SPA como Bearer hacia BuildingFex.Api (admins)." "External"
            firestore = softwareSystem "Cloud Firestore" "Perfil documental del administrador (users/{uid}: name, dni, company, ruc, address) tras registro/login Firebase." "External"
            firebaseRtdb = softwareSystem "Firebase Realtime Database" "Chats en tiempo real: AI chats del residente y chats admin↔residente (escalamiento). Paths owners/{ownerId}/aiChats|adminChats." "External"
            gemini = softwareSystem "Google Gemini API" "Modelo generativo (generateContent) para el asistente de soporte técnico del residente y títulos de chat. Invocado desde el browser con API key." "External"
        }

        mercadoPago = softwareSystem "Mercado Pago" "Checkout Pro: (1) suscripción de planes BuildingFex del admin, (2) pago de cuotas/mantenimiento del residente. Preferencias, init_point y webhooks." "External"

        # ═══════════════════════════════════════════
        # Sistema BuildingFex
        # ═══════════════════════════════════════════
        buildingFex = softwareSystem "BuildingFex" "Solución web multi-tenant para la operación de condominios. Núcleo de negocio en BuildingFex.Api (MySQL); identidad y chats en Firebase; pagos en Mercado Pago; IA de soporte en Gemini." {

            # —— Contenedores ——
            spa = container "BuildingFex Web SPA" "SPA Vue 3: paneles admin/residente, auth, invitación de huésped. En prod se sirve desde Vercel (same-origin) y reescribe rutas API hacia Railway. En dev: Vite + mock in-process o proxy." "Vue 3.5, Vite 6, Vue Router 4, PrimeVue 4, vue-i18n, Axios, Chart.js, Firebase JS SDK" {

                shellUi = component "App Shell & Router" "App.vue + AppShellView: navegación por rol (admin vs resident), guards de sesión (JWT/Firebase token en localStorage buildingfex.session), i18n es/en." "vue-router, AppShellView"
                iamUi = component "IAM / Auth UI" "Login admin (Firebase email/password), registro admin (Firebase + seed financeSettings/kpi + POST /users), login residente Google, invite code → complete-google." "AuthView, sessionStore, firebaseAuth, googleIdentity, authApi, residentsApi"
                dashboardUi = component "Dashboard UI" "Admin: KPI, deuda, incidencias, espacios. Residente: resumen financiero, comunicados, reservas." "AppDashboardView, AppResidentDashboardView"
                residentsUi = component "Residentes & Gestión avanzada UI" "Alta de residentes (código/departamento, billFromNextMonth, límite de plan), espacios sociales CRUD." "AppAdvancedManagementView, residentsApi, spacesApi"
                financesUi = component "Finanzas & Cobros UI" "Admin: recibos, settings, late fees, cargos extra, gastos de gestión, servicios compartidos (agua/luz), montos fijos. Residente: por pagar + historial + checkout MP." "AppFinanceView, AppResidentFinanceView, AppCollectionsManagementExpensesView, financesStore"
                spacesUi = component "Espacios, Generación & Invitados UI" "Reservas admin/residente, solapes, lista de invitados (máx 5), QR/token guestInviteToken, GuestInviteView pública." "AppGenerationView, AppResidentGenerationView, AppResidentServicesView, GuestInviteView, reservationsApi"
                incidentsUi = component "Incidencias & Proveedores UI" "Tablero open/in-progress/resolved; catálogo serviceProviders (plomería, etc.)." "AppIncidentsView, AppResidentIncidentsView, incidentsApi, serviceProvidersApi"
                informationUi = component "Información / Comunicados UI" "Publicación y lectura de announcements (prioridad, vigencia)." "AppInformationView, announcementsApi"
                importUi = component "Importaciones UI" "Carpetas (importFolders, home folder) y uploads con dataUrl / folderId." "AppImportView, importFoldersApi, importUploadsApi"
                supportUi = component "Soporte UI (IA + tiempo real)" "Residente: chat Gemini + persistencia RTDB. Escalamiento a adminChat. Admin: bandeja AppAdminResidentHelpView. FAQs locales. HTTP /supportChats legacy (casi no usado)." "AppResidentSupportView, AppAdminResidentHelpView, realtimeSupportDb, geminiApi"
                settingsUi = component "Ajustes & Suscripción UI" "Perfil, planes free/essential/standard/scale, checkout/confirm de suscripción vía API + fallback /mp." "AppSettingsView, subscriptionApi"
                teamUi = component "Equipo UI" "CRUD teamWorkers (ruta /app/team; no siempre en sidebar)." "AppTeamView, teamWorkersApi"
                apiClientComp = component "API Client & Multi-tenancy" "Axios apiClient: Bearer token, timeout, error.code; withOwnerParams(ownerAdminId) desde sesión admin.id o resident.ownerAdminId." "apiClient.js, ownerQuery, envConfig"
                mpClientComp = component "Mercado Pago Client" "Intenta /api/v1/payments|subscription en API; fallback fetch /mp/checkout y /mp/payment (edge Vercel)." "mercadoPagoCheckoutClient, mercadoPago*"
                geminiClientComp = component "Gemini Client" "Lista modelos + generateContent hacia generativelanguage.googleapis.com." "geminiApi.js"
                mockDevComp = component "Vite Preview Mock (solo DEV)" "Middleware in-process que emula Compat + /api/v1 auth/subscription/payments sobre .local-mock-db.json; intercepta antes del proxy Railway." "previewMockApiPlugin, mockAdapter"
            }

            mpEdge = container "Mercado Pago Edge" "Serverless que crea preferencias Checkout Pro y consulta estado de pago sin exponer MP_ACCESS_TOKEN al browser. Prod: Vercel /api/mp (rewrite /mp/*). Dev: Vite plugin." "Node.js — Vercel Serverless / Vite plugin"

            api = container "BuildingFex.Api" "API REST modular monolith (.NET 10). Dual surface: /api/v1 (auth, subscription, payments, KPI) + Compat flat estilo json-server (/users, /incidents, …). Auth: App JWT HS256 y/o Firebase ID token. Tenancy por ownerAdminId. SchemaUpgrade + EnsureCreated + seed db.json." "ASP.NET Core 10, EF Core, MySQL, JWT, BCrypt, MercadoPago SDK, Swagger" {

                sharedKernel = component "Shared Kernel" "AppDbContext, UnitOfWork, BaseRepository, Result pattern, RailwayHosting, SchemaUpgrade (ALTER/CREATE IF NOT EXISTS), snake_case naming, /health." "Shared/"
                authMod = component "IAM — Authentication" "sign-in, register-admin, sign-in-google, residents/invite, complete-google, set-credentials. Emite JWT (sub=ExternalId, role, ownerAdminId). Valida Firebase Bearer para admins." "AuthenticationController, UserCommandService, TokenService, DualJwt"
                usersMod = component "IAM — Users & Residents" "Compat /users: list/filter, create resident (plan limit), upsert Firebase admin, PATCH billFromNextMonth, delete. Campos googleSub, authProvider, hasCredentials." "UsersCompatController, User aggregate"
                subscriptionMod = component "Subscriptions & Plans" "GET/PATCH plan; checkout/confirm Mercado Pago. Planes free(9)/essential(15)/standard(40)/scale(80). Enforce límites al crear residente." "SubscriptionController, SubscriptionPlans"
                paymentsMod = component "Payments (Mercado Pago)" "preference, checkout, confirm, process, webhook de cuotas de mantenimiento. Reconcilia receipts/fees." "MercadoPagoController, MercadoPagoService"
                financesMod = component "Finances Compat" "receipts, fees, payments history, financeSettings, kpi (computed), adminManagementExpenses, sharedUtilityServices, fixedPayoutRecipients, residentExtraCharges + DELETEs." "Finances/* Compat controllers"
                spacesMod = component "Social Spaces & Reservations" "CRUD socialSpaces; reservations con overlap; GET público por guestInviteToken (AllowAnonymous)." "SocialSpacesCompat, ReservationsCompat"
                incidentsMod = component "Incidents & Service Providers" "CRUD incidents (PUT update); CRUD serviceProviders." "IncidentsCompat, ServiceProvidersCompat"
                announcementsMod = component "Information / Announcements" "CRUD announcements por ownerAdminId." "AnnouncementsCompatController"
                importMod = component "Import Documents" "importFolders + importUploads (PATCH fileName/folderId, dataUrl LONGTEXT)." "ImportFoldersCompat, ImportUploadsCompat"
                teamMod = component "Team Workers" "CRUD ligero teamWorkers (name, phone, dni, salary, photoUrl)." "TeamWorkersCompatController"
                supportLegacyMod = component "Support Chats (legacy)" "CRUD /supportChats en MySQL (messages JSON). La UI productiva usa Firebase RTDB + Gemini; este módulo queda por compatibilidad." "SupportChatsCompatController"
            }

            database = container "MySQL Database" "Persistencia transaccional: users (admin/resident + subscription), finances, social_spaces/reservations, incidents, announcements, import_*, team_workers, service_providers, resident_extra_charges, support_chats (legacy)." "MySQL 8.x (Railway managed / Docker local)" {
                tags "Database"
            }
        }

        # ═══════════════════════════════════════════
        # Relaciones: Personas → Sistema / SPA
        # ═══════════════════════════════════════════
        visitor -> buildingFex "Accede a login/registro" "HTTPS"
        visitor -> buildingFex.spa "Abre /login o /register" "HTTPS"

        admin -> buildingFex "Opera el condominio" "HTTPS"
        admin -> buildingFex.spa "Usa /app/* (panel admin)" "HTTPS"

        resident -> buildingFex "Usa portal de unidad" "HTTPS"
        resident -> buildingFex.spa "Usa /app/resident/*" "HTTPS"

        guest -> buildingFex "Consulta invitación de reserva" "HTTPS"
        guest -> buildingFex.spa "Abre /invite/:token (sin login)" "HTTPS"

        # ═══════════════════════════════════════════
        # Relaciones: Contenedores
        # ═══════════════════════════════════════════
        buildingFex.spa -> buildingFex.api "REST JSON multi-tenant (Bearer App JWT o Firebase ID token)" "HTTPS"
        buildingFex.spa -> firebaseAuth "Login admin email/password; Google Sign-In residente" "HTTPS"
        buildingFex.spa -> firestore "Lee/escribe perfil admin users/{uid}" "HTTPS"
        buildingFex.spa -> firebaseRtdb "Chats soporte en tiempo real (aiChats, adminChats)" "WSS/HTTPS"
        buildingFex.spa -> gemini "generateContent del asistente de soporte" "HTTPS"
        buildingFex.spa -> buildingFex.mpEdge "Fallback checkout/consulta pago /mp/*" "HTTPS"

        buildingFex.mpEdge -> mercadoPago "Crea preferencias y consulta payments" "HTTPS"

        buildingFex.api -> buildingFex.database "EF Core (EnsureCreated + SchemaUpgrade + seed)" "SQL/TCP"
        buildingFex.api -> mercadoPago "Checkout/confirm suscripción y cuotas + webhook" "HTTPS"
        buildingFex.api -> firebaseAuth "Valida ID tokens Firebase (Authority securetoken.google.com/{projectId})" "HTTPS JWKS"

        # ═══════════════════════════════════════════
        # Componentes SPA — navegación y datos
        # ═══════════════════════════════════════════
        admin -> buildingFex.spa.shellUi "Navega módulos admin"
        resident -> buildingFex.spa.shellUi "Navega módulos residente"
        guest -> buildingFex.spa.spacesUi "GuestInviteView"
        visitor -> buildingFex.spa.iamUi "Login / registro"

        buildingFex.spa.shellUi -> buildingFex.spa.dashboardUi "Enruta dashboard"
        buildingFex.spa.shellUi -> buildingFex.spa.residentsUi "Enruta gestión avanzada"
        buildingFex.spa.shellUi -> buildingFex.spa.financesUi "Enruta finanzas / cobros"
        buildingFex.spa.shellUi -> buildingFex.spa.spacesUi "Enruta generación / servicios"
        buildingFex.spa.shellUi -> buildingFex.spa.incidentsUi "Enruta incidencias"
        buildingFex.spa.shellUi -> buildingFex.spa.informationUi "Enruta información"
        buildingFex.spa.shellUi -> buildingFex.spa.importUi "Enruta import"
        buildingFex.spa.shellUi -> buildingFex.spa.supportUi "Enruta soporte / ayuda residente"
        buildingFex.spa.shellUi -> buildingFex.spa.settingsUi "Enruta ajustes"
        buildingFex.spa.shellUi -> buildingFex.spa.teamUi "Enruta equipo (opcional)"
        buildingFex.spa.shellUi -> buildingFex.spa.iamUi "Redirect si sesión inválida"

        buildingFex.spa.iamUi -> firebaseAuth "createUser / signIn / Google popup" "HTTPS"
        buildingFex.spa.iamUi -> firestore "Perfil admin" "HTTPS"
        buildingFex.spa.iamUi -> buildingFex.spa.apiClientComp "sign-in-google, complete-google, POST /users, seed settings"

        buildingFex.spa.dashboardUi -> buildingFex.spa.apiClientComp "KPI, incidents, spaces, announcements"
        buildingFex.spa.residentsUi -> buildingFex.spa.apiClientComp "/users, /socialSpaces"
        buildingFex.spa.financesUi -> buildingFex.spa.apiClientComp "receipts, fees, settings, extras, expenses, utilities, payouts"
        buildingFex.spa.financesUi -> buildingFex.spa.mpClientComp "Pago de cuotas"
        buildingFex.spa.spacesUi -> buildingFex.spa.apiClientComp "/socialSpaces, /reservations (+ guest token)"
        buildingFex.spa.incidentsUi -> buildingFex.spa.apiClientComp "/incidents, /serviceProviders"
        buildingFex.spa.informationUi -> buildingFex.spa.apiClientComp "/announcements"
        buildingFex.spa.importUi -> buildingFex.spa.apiClientComp "/importFolders, /importUploads"
        buildingFex.spa.teamUi -> buildingFex.spa.apiClientComp "/teamWorkers"
        buildingFex.spa.settingsUi -> buildingFex.spa.apiClientComp "/api/v1/subscription*"
        buildingFex.spa.settingsUi -> buildingFex.spa.mpClientComp "Checkout de plan"

        buildingFex.spa.supportUi -> firebaseRtdb "watch/append aiChats y adminChats" "WSS"
        buildingFex.spa.supportUi -> buildingFex.spa.geminiClientComp "Respuestas IA"
        buildingFex.spa.geminiClientComp -> gemini "Generative Language API" "HTTPS"

        buildingFex.spa.apiClientComp -> buildingFex.api "Compat + /api/v1" "HTTPS/JSON"
        buildingFex.spa.mpClientComp -> buildingFex.mpEdge "/mp/checkout, /mp/payment" "HTTPS"
        buildingFex.spa.mpClientComp -> buildingFex.api "/api/v1/payments|subscription" "HTTPS/JSON"

        buildingFex.spa.mockDevComp -> buildingFex.spa.apiClientComp "En DEV intercepta mismas rutas (mock-first)"

        # ═══════════════════════════════════════════
        # Componentes API — consumo y persistencia
        # ═══════════════════════════════════════════
        buildingFex.spa.apiClientComp -> buildingFex.api.authMod "Auth Google residente + invites"
        buildingFex.spa.apiClientComp -> buildingFex.api.usersMod "/users"
        buildingFex.spa.apiClientComp -> buildingFex.api.subscriptionMod "/api/v1/subscription"
        buildingFex.spa.apiClientComp -> buildingFex.api.paymentsMod "/api/v1/payments"
        buildingFex.spa.apiClientComp -> buildingFex.api.financesMod "Colecciones financieras"
        buildingFex.spa.apiClientComp -> buildingFex.api.spacesMod "Espacios y reservas"
        buildingFex.spa.apiClientComp -> buildingFex.api.incidentsMod "Incidencias y proveedores"
        buildingFex.spa.apiClientComp -> buildingFex.api.announcementsMod "Comunicados"
        buildingFex.spa.apiClientComp -> buildingFex.api.importMod "Import folders/uploads"
        buildingFex.spa.apiClientComp -> buildingFex.api.teamMod "Team workers"
        buildingFex.spa.apiClientComp -> buildingFex.api.supportLegacyMod "Legacy /supportChats (opcional)"

        buildingFex.api.authMod -> buildingFex.api.sharedKernel "DbContext / Result / JWT infra"
        buildingFex.api.usersMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.financesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.spacesMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.incidentsMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.announcementsMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.importMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.teamMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.supportLegacyMod -> buildingFex.api.sharedKernel "Persistencia"
        buildingFex.api.subscriptionMod -> buildingFex.api.sharedKernel "Users + planes"
        buildingFex.api.paymentsMod -> buildingFex.api.sharedKernel "Receipts/fees"

        buildingFex.api.sharedKernel -> buildingFex.database "ORM / SQL"
        buildingFex.api.authMod -> firebaseAuth "Validación JWKS Firebase"
        buildingFex.api.subscriptionMod -> mercadoPago "Checkout plan"
        buildingFex.api.paymentsMod -> mercadoPago "Checkout cuotas + webhook"

        # ═══════════════════════════════════════════
        # Deployment: Production
        # ═══════════════════════════════════════════
        deploymentEnvironment "Production" {
            deploymentNode "Dispositivo del usuario" "Browser" {
                browserInstance = containerInstance buildingFex.spa
            }

            deploymentNode "Vercel" "CDN + Static + Serverless. vercel.json reescribe /api/v1/* y rutas Compat flat hacia Railway; /mp/* → /api/mp; SPA fallback index.html." {
                deploymentNode "Edge / Static Hosting" {
                    spaProd = containerInstance buildingFex.spa
                }
                deploymentNode "Serverless Functions" "Node.js" {
                    mpProd = containerInstance buildingFex.mpEdge
                }
            }

            deploymentNode "Railway" "PaaS. Docker ASP.NET (PORT), healthcheck /health. Env: TokenSettings__Secret, Firebase__ProjectId, MYSQL_*, MercadoPago__*." {
                deploymentNode "Web Service — BuildingFex.Api" "net10.0 / Docker" {
                    apiProd = containerInstance buildingFex.api
                }
                deploymentNode "MySQL Plugin / Managed DB" {
                    dbProd = containerInstance buildingFex.database
                }
            }

            deploymentNode "Google Cloud / Firebase" {
                firebaseAuthProd = softwareSystemInstance firebaseAuth
                firestoreProd = softwareSystemInstance firestore
                rtdbProd = softwareSystemInstance firebaseRtdb
                geminiProd = softwareSystemInstance gemini
            }

            deploymentNode "Mercado Pago Cloud" {
                mpCloudProd = softwareSystemInstance mercadoPago
            }
        }

        # ═══════════════════════════════════════════
        # Deployment: Development
        # ═══════════════════════════════════════════
        deploymentEnvironment "Development" {
            deploymentNode "Developer Machine" {
                deploymentNode "Vite Dev Server" "localhost:5173 — previewMockApiPlugin (mock-first) + viteMercadoPagoPlugin; proxy opcional VITE_API_PROXY_TARGET" {
                    spaDev = containerInstance buildingFex.spa
                    mpDev = containerInstance buildingFex.mpEdge
                }
                deploymentNode "Optional local API" "dotnet run :5001 + Docker MySQL 8.4 (docker-compose)" {
                    apiDevLocal = containerInstance buildingFex.api
                    dbDevLocal = containerInstance buildingFex.database
                }
            }

            deploymentNode "Railway (API staging / shared)" "A menudo el proxy apunta aquí aunque el mock lo opaque" {
                apiDevRemote = containerInstance buildingFex.api
                dbDevRemote = containerInstance buildingFex.database
            }

            deploymentNode "External SaaS (dev keys)" {
                firebaseAuthDev = softwareSystemInstance firebaseAuth
                firestoreDev = softwareSystemInstance firestore
                rtdbDev = softwareSystemInstance firebaseRtdb
                geminiDev = softwareSystemInstance gemini
                mpDevCloud = softwareSystemInstance mercadoPago
            }
        }
    }

    views {
        systemContext buildingFex "SystemContext" {
            include *
            autoLayout lr
            description "C1 — Contexto: Visitante, Administrador, Residente e Invitado interactúan con BuildingFex. Externos: Firebase Auth, Firestore, RTDB, Gemini y Mercado Pago. El núcleo de dominio es BuildingFex.Api + MySQL."
        }

        container buildingFex "Containers" {
            include *
            autoLayout lr
            description "C2 — Contenedores: SPA Vue 3, Edge Mercado Pago, BuildingFex.Api (.NET), MySQL; más Firebase Auth/Firestore/RTDB, Gemini y Mercado Pago."
        }

        component buildingFex.spa "SpaComponents" {
            include *
            autoLayout tb
            description "C3 — SPA: shell por rol, bounded contexts de UI, apiClient multi-tenant, clientes MP/Gemini, mock DEV. Soporte = RTDB + Gemini (no MySQL)."
        }

        component buildingFex.api "ApiComponents" {
            include *
            autoLayout tb
            description "C3 — API: Shared Kernel + IAM (JWT/Firebase) + Compat por dominio. SupportChats marcado legacy. Superficie /api/v1 + rutas flat."
        }

        deployment buildingFex "Production" "DeploymentProduction" {
            include *
            autoLayout tb
            description "C4 — Producción: Browser → Vercel (SPA + /api/mp, rewrites a Railway) → BuildingFex.Api + MySQL; Firebase suite; Mercado Pago; Gemini."
        }

        deployment buildingFex "Development" "DeploymentDevelopment" {
            include *
            autoLayout tb
            description "C4 — Desarrollo: Vite mock-first (+ edge MP local), API local opcional o Railway, mismos SaaS con claves de desarrollo."
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

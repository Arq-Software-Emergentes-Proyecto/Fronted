workspace "BuildingFex — Resident Care (corregido)" "MySQL = verdad. Gemini solo en API. AuthZ por tenant. Escalado = 2da fila ligada. SignalR para tiempo real." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        resident = person "Residente" "Chat IA y, tras escalar, admin."
        admin = person "Administrador" "Bandeja de chats humanos."

        firebaseAuth = softwareSystem "Firebase Authentication" "idToken + custom claims (role, ownerAdminId)." "External"
        gemini = softwareSystem "Google Gemini API" "generateContent. Key solo en servidor." "External"

        buildingFex = softwareSystem "BuildingFex" {

            spa = container "SPA Vue" "REST + SignalR hub /hubs/support. Sin key Gemini. Sin RTDB." "Vue 3"

            api = container "BuildingFex.Api" "SupportController + SupportHub. Valida Bearer. AuthZ tenant. Gemini + rate limit. Escalado 1 TX." "ASP.NET Core" {
                tags "API"
            }

            residentCareMod = container "Resident Care module" "support_chats + support_messages. Escalado: NO cambia kind; crea 2da fila kind=admin y linked_chat_id bidireccional." "BC Resident Care"

            db = container "MySQL" "support_chats (cabecera) + support_messages (filas, FK chat_id)." "MySQL" {
                tags "Database"
            }
        }

        resident -> buildingFex.spa "Usa /app/resident/support"
        admin -> buildingFex.spa "Usa /app/resident-help"

        buildingFex.spa -> buildingFex.api "REST /api/v1/support/* + SignalR" "HTTPS + Bearer"
        buildingFex.api -> firebaseAuth "Valida idToken (JWKS)" "HTTPS"
        buildingFex.api -> buildingFex.residentCareMod "AuthZ + CRUD chats/messages + escalate TX"
        buildingFex.api -> gemini "generateContent (solo si chat AI no escalado)" "HTTPS"
        buildingFex.residentCareMod -> buildingFex.db "SQL" "SQL"
    }

    views {
        container buildingFex "ResidentCareCorrecto" {
            include *
            autoLayout tb
            description "Resident Care: (1) Gemini sale de la API, no de la tabla. (2) Firebase Auth valida Bearer. (3) Dos tablas chats+messages. (4) Escalado = nueva fila admin ligada, kind del AI no cambia. (5) SignalR reemplaza polling ciego. Layout tb para legibilidad."
        }

        styles {
            element "Person" {
                shape Person
                background #0b3d5c
                color #ffffff
            }
            element "Software System" {
                background #1a6aa8
                color #ffffff
            }
            element "External" {
                background #888888
                color #ffffff
            }
            element "Container" {
                background #3d8fd1
                color #ffffff
            }
            element "API" {
                background #1f7a4d
                color #ffffff
            }
            element "Database" {
                shape Cylinder
                background #2f6f9f
                color #ffffff
            }
            relationship "Relationship" {
                routing Orthogonal
                color #333333
            }
        }
    }
}

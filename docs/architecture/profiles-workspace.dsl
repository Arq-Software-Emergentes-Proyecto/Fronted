workspace "BuildingFex — Profiles (objetivo)" "Auth vs Perfil separados. Rol por first-user-wins en servidor. User+Profile en una transaccion. Recuperacion si Auth existe sin perfil." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        admin = person "Administrador" "Se autentica con Firebase. El perfil de negocio vive solo en BuildingFex.Api."

        firebaseAuth = softwareSystem "Firebase Authentication" "SOLO identidad: email/password, uid, idToken. Sin DNI/empresa/RUC/direccion. Sin role de negocio." "External"

        buildingFex = softwareSystem "BuildingFex" "Una fuente de verdad del perfil: API + MySQL. IAM User y Profiles.Profile son tablas distintas unidas por FK." {

            spa = container "SPA Vue" "Registro, login y completar-perfil. Lee perfil solo con GET /api/v1/profiles/me. Si 404 → no entra al panel; completa perfil." "Vue 3"

            api = container "BuildingFex.Api" "Valida idToken. POST /api/v1/profiles: first-user-wins + UNA transaccion (User + Profile). Role NUNCA del body." "ASP.NET Core" {
                tags "API"
            }

            iam = container "IAM — users" "Tabla users: ExternalId=uid, Email, Role (servidor). Persistencia en MySQL." "MySQL users"

            profiles = container "Profiles — profiles" "Agregado Profile / tabla profiles: name, dni, company, ruc, address. FK unica user_external_id → users.external_id." "MySQL profiles"

            db = container "MySQL" "Misma base: users (IAM) + profiles (Profiles), FK 1:1 por external_id/uid." "MySQL" {
                tags "Database"
            }
        }

        # Flujo feliz
        admin -> buildingFex.spa "Registro / login / completar perfil"
        buildingFex.spa -> firebaseAuth "1. createUser o signIn → uid + idToken" "HTTPS"
        buildingFex.spa -> buildingFex.api "2. POST /api/v1/profiles (Bearer) body: name,dni,company,ruc,address — SIN role; opcional invitation futura" "HTTPS/JSON"
        buildingFex.spa -> buildingFex.api "3. GET /api/v1/profiles/me (Bearer) unica lectura" "HTTPS/JSON"

        buildingFex.api -> firebaseAuth "Valida idToken (JWKS), obtiene uid/email" "HTTPS"
        buildingFex.api -> buildingFex.iam "TX: asegura User(uid,email); Role=admin solo si first-user-wins o ya es admin; si no → 409"
        buildingFex.api -> buildingFex.profiles "TX: upsert Profile(uid, datos de negocio)"
        buildingFex.iam -> buildingFex.db "INSERT/UPDATE users" "SQL"
        buildingFex.profiles -> buildingFex.db "INSERT/UPDATE profiles (FK → users.external_id)" "SQL"

        # Recuperacion: Auth ok, perfil ausente
        buildingFex.spa -> buildingFex.api "Login: si GET /api/v1/profiles/me = 404 PROFILE_NOT_FOUND → UI completar perfil (POST /api/v1/profiles) antes de entrar al panel" "HTTPS/JSON"
    }

    views {
        container buildingFex "ProfilesCorrecto" {
            include *
            autoLayout tb
            description "Profiles: (1) IAM users y Profiles profiles ambos persisten en MySQL. (2) role=admin por first-user-wins en servidor, nunca del cliente; luego 409. (3) POST en una TX User+Profile. (4) FK profiles.user_external_id → users.external_id. (5) Auth sin perfil → 404 → completar perfil."
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

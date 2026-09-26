workspace "BuildingFex — IAM" "Un solo emisor: Firebase idToken + custom claims (role, ownerAdminId). Sin App JWT / DualJwt." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        admin = person "Administrador" "Firebase email/password + perfil API."
        resident = person "Residente" "Invite token → Google → idToken con claims."

        group "Auth (derecha)" {
            firebaseAuth = softwareSystem "Firebase Auth" "idToken + custom claims + revokeRefreshTokens." "External"
            googleId = softwareSystem "Google Identity" "Popup → Firebase user." "External"
        }

        buildingFex = softwareSystem "BuildingFex" {

            spa = container "SPA IAM" "AuthView. Admin SDK login. Resident: invite→Google." "Vue 3"
            api = container "IAM API" "/api/v1/authentication + /api/v1/profiles + /api/v1/users. Solo Firebase Bearer." "ASP.NET Core" {
                tags "API"
            }
            users = container "IAM users" "users: ExternalId, Role, GoogleSub, OwnerAdminId. Plan solo en admin." "BC IAM"
            db = container "MySQL" "Tabla users (+ profiles)." "MySQL" {
                tags "Database"
            }
        }

        admin -> buildingFex.spa "Login / registro"
        resident -> buildingFex.spa "Invite / Google"

        # Admin (SPA → Firebase primero; flecha no sale de IAM API)
        buildingFex.spa -> firebaseAuth "1a. signIn / createUser" "SDK"
        buildingFex.spa -> buildingFex.api "1b. Bearer idToken → profiles" "HTTPS"
        buildingFex.api -> firebaseAuth "JWKS + SetCustomUserClaims" "HTTPS"
        buildingFex.api -> buildingFex.users "Rol DB; claims sync"
        buildingFex.users -> buildingFex.db "SQL"

        # Resident — Google popup no se encima con 1a
        buildingFex.spa -> buildingFex.api "2a. GET invite (token 128-bit)" "HTTPS"
        buildingFex.spa -> googleId "2b. Google popup" "SDK"
        googleId -> firebaseAuth "idToken"
        buildingFex.spa -> buildingFex.api "2c. complete-google + idToken" "HTTPS"
        buildingFex.api -> firebaseAuth "Verifica + claims role/ownerAdminId" "HTTPS"
        buildingFex.api -> buildingFex.users "Activa GoogleSub; consume invite"
        buildingFex.spa -> firebaseAuth "2d. getIdToken(true)" "SDK"

        # Admin gestiona residentes
        buildingFex.spa -> buildingFex.api "3. /api/v1/users (owner=claims)" "HTTPS"
    }

    views {
        container buildingFex "IamContainerView" {
            include *
            autoLayout lr 550 420
            description "IAM Firebase-only. Invite 128-bit single-use+expiry+email. Plan en admin. Sin DualJwt."
        }

        styles {
            element "Person" {
                shape Person
                background #0b3d5c
                color #ffffff
                width 320
                height 200
            }
            element "Software System" {
                background #1a6aa8
                color #ffffff
                width 260
            }
            element "External" {
                background #888888
                color #ffffff
                width 240
            }
            element "Container" {
                background #3d8fd1
                color #ffffff
                width 280
            }
            element "API" {
                background #1f7a4d
                color #ffffff
                width 300
            }
            element "Database" {
                shape Cylinder
                background #2f6f9f
                color #ffffff
            }
            relationship "Relationship" {
                routing Orthogonal
                color #333333
                fontSize 18
            }
        }
    }
}

workspace "BuildingFlex — Communications" "Documentos del edificio. File Storage firma y limpia huérfanos. El worker de indexación es de Resident Care." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        admin = person "Administrador" "Publica reglamentos, actas y documentos."

        group "Cloud (derecha)" {
            firebaseAuth = softwareSystem "Firebase Auth" "JWKS." "External"
            firebaseStorage = softwareSystem "Firebase Storage" "Documentos del edificio." "External"
            gemini = softwareSystem "Gemini" "Embeddings vía gateway de IA." "External"
        }

        buildingFex = softwareSystem "BuildingFlex" {

            spa = container "SPA – vista Documentos" "signed-url → PUT → confirm." "Vue 3"
            api = container "Document API (Communications)" "Document Controller. Cuota, MIME y estado." "ASP.NET Core" {
                tags "API"
            }
            fileStorage = container "File Storage (infraestructura compartida)" "URL firmada V4 y limpieza de huérfanos." "ASP.NET Core" {
                tags "Infra"
            }
            documents = container "Document Service (Communications)" "Carpetas y documentos. import_folders, import_uploads." "BC Communications"
            residentCare = container "Indexing Worker (Resident Care)" "Embebe el documento tras confirm." "HostedService" {
                tags "Worker"
            }
            rag = container "RAG chunks (Resident Care)" "ai_context_chunks. Los lee el asistente." "MySQL" {
                tags "RagStore"
            }
            db = container "MySQL" "Metadata de documentos." "MySQL" {
                tags "Database"
            }
        }

        admin -> buildingFex.spa "Usa"

        buildingFex.spa -> buildingFex.api "1. signed-url"
        buildingFex.api -> firebaseAuth "JWKS"
        buildingFex.api -> buildingFex.documents "2. pending"
        buildingFex.documents -> buildingFex.db "SQL"

        buildingFex.spa -> firebaseStorage "3. PUT"
        buildingFex.spa -> buildingFex.api "4. confirm"

        buildingFex.api -> buildingFex.fileStorage "firma V4"
        buildingFex.fileStorage -> firebaseStorage "delete huérfanos"

        buildingFex.api -> buildingFex.residentCare "5. encola"
        buildingFex.residentCare -> firebaseStorage "getObject"
        buildingFex.residentCare -> gemini "embed"
        buildingFex.residentCare -> buildingFex.rag "chunks"
        buildingFex.rag -> buildingFex.db "SQL"
    }

    views {
        container buildingFex "CommunicationsContainerView" {
            include *
            autoLayout lr 550 420
            description "Communications (contexto 7 de 9). File Storage = infra. Indexing Worker y RAG = Resident Care (contexto 8)."
        }

        styles {
            element "Person" {
                shape Person
                background #0b3d5c
                color #ffffff
                width 360
                height 220
                fontSize 22
            }
            element "Software System" {
                background #1a6aa8
                color #ffffff
                width 260
                height 140
            }
            element "External" {
                background #888888
                color #ffffff
                width 240
                height 130
            }
            element "Container" {
                background #3d8fd1
                color #ffffff
                width 280
                height 150
            }
            element "API" {
                background #1f7a4d
                color #ffffff
                width 300
                height 160
            }
            element "Infra" {
                background #6b5b4b
                color #ffffff
                width 280
                height 150
            }
            element "Worker" {
                background #2a6f8f
                color #ffffff
                width 300
                height 150
            }
            element "Database" {
                shape Cylinder
                background #2f6f9f
                color #ffffff
                width 220
                height 160
            }
            element "RagStore" {
                shape RoundedBox
                background #3d8fd1
                color #ffffff
                width 260
                height 140
            }
            element "Boundary" {
                color #333333
                stroke #333333
                strokeWidth 2
            }
            relationship "Relationship" {
                routing Orthogonal
                color #333333
                fontSize 20
                thickness 2
            }
        }
    }
}

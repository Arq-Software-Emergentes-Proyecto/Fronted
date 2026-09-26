workspace "BuildingFex — Import" "URLs firmadas V4. Confirm getMetadata. Orphan libera cuota." {

    !identifiers hierarchical

    model {
        properties {
            "structurizr.groupSeparator" "/"
        }

        admin = person "Administrador" "Gestiona importaciones."

        # Externos juntos (columna derecha en layout lr)
        group "Cloud (derecha)" {
            firebaseAuth = softwareSystem "Firebase Auth" "JWKS." "External"
            firebaseStorage = softwareSystem "Firebase Storage" "GCS firmado." "External"
            gemini = softwareSystem "Gemini" "Embeddings." "External"
        }

        # Support cerca de RAG (abajo)
        supportSys = softwareSystem "Support" "Lee RAG." "External"

        buildingFex = softwareSystem "BuildingFex" {

            spa = container "SPA Import" "signed-url → PUT → confirm." "Vue 3"
            api = container "Import API" "Cuota/MIME/size. Firma V4. getMetadata." "ASP.NET Core" {
                tags "API"
            }
            indexer = container "Indexing worker" "Admin SDK + embed." "HostedService" {
                tags "Worker"
            }
            orphanCleanup = container "Orphan cleanup" "DELETE pending → libera cuota." "HostedService" {
                tags "Worker"
            }
            importMod = container "Import module" "storage_path + upload_status." "BC Import"
            rag = container "RAG chunks" "ai_context_chunks." "MySQL" {
                tags "RagStore"
            }
            db = container "MySQL" "Metadata import_*." "MySQL" {
                tags "Database"
            }
        }

        admin -> buildingFex.spa "Usa"

        # Secuencia numerada (etiquetas cortas)
        buildingFex.spa -> buildingFex.api "1. signed-url"
        buildingFex.api -> firebaseAuth "JWKS"
        buildingFex.api -> buildingFex.importMod "2. pending+firma"
        buildingFex.importMod -> buildingFex.db "SQL"

        buildingFex.spa -> firebaseStorage "3. PUT"
        buildingFex.spa -> buildingFex.api "4. confirm"

        buildingFex.api -> buildingFex.indexer "5. encola"
        buildingFex.indexer -> firebaseStorage "getObject"
        buildingFex.indexer -> gemini "embed"
        buildingFex.indexer -> buildingFex.rag "chunks"
        buildingFex.rag -> buildingFex.db "SQL"

        buildingFex.orphanCleanup -> buildingFex.importMod "libera cuota"
        buildingFex.orphanCleanup -> firebaseStorage "delete"

        supportSys -> buildingFex.rag "retrieve" {
            tags "Dashed"
        }
    }

    views {
        container buildingFex "ImportContainerView" {
            include *
            # lr: internos izquierda→centro, cloud a la derecha, Support abajo con RAG
            autoLayout lr 550 420
            description "Import firmado. Paso 5 = encola indexado. Orphan libera cuota."
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
            relationship "Dashed" {
                style dashed
                color #666666
                fontSize 20
            }
        }
    }
}

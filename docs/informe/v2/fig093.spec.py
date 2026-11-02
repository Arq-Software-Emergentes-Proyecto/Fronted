# Fig. 93 - Componentes del módulo Communications (documentos)
WRAP = 22
LABELWRAP = 16
NODESEP = 0.14
TITLE = 'BuildingFex.Api - módulo Communications: documentos (azul claro: componentes del módulo; gris: otros)'
TITLEWRAP = 55
NODES = [
 ('admin','person','Administrador','','Publica reglamentos, actas y documentos.'),
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz web para administradores y residentes.'),
 ('folderCtrl','component','ImportFoldersController','API Controller','/api/v1/import/folders: carpetas del condominio (inicio y carpeta de contexto del asistente).'),
 ('uploadCtrl','component','ImportUploadsController','API Controller','/api/v1/import/uploads: signed-url, confirm, download-url, publish, archive y delete; controla tamaño (5 MB), cupo (100 archivos), tipo MIME, versión y vigencia.'),
 ('cleanup','component','ImportOrphanCleanup','Infrastructure','Borra los archivos que quedaron sin confirmar (job import-cleanup cada 30 min; en local, ImportOrphanCleanupWorker).'),
 ('fileStorage','extcomp','File Storage','S3StorageService (IFirebaseStorageService)','URL prefirmadas PUT/GET de 10 min (máx. 15), metadatos reales y borrado. Sin BF_FILES_BUCKET se usa FirebaseStorageService.'),
 ('residentCare','extcomp','Módulo Resident Care','IAiContextIndexingQueue y AiContextIndexer','Encola la indexación (en AWS invoca el job ai-index de forma asíncrona) y retira los fragmentos del documento archivado o reemplazado.'),
 ('s3','db','Almacenamiento de archivos','Amazon S3','Bucket privado y cifrado: reglamentos, actas e importaciones.'),
 ('db','db','TiDB Cloud','MySQL compatible','import_folders e import_uploads.'),
]
ROWS = [['admin'],['spa'],['folderCtrl','uploadCtrl','cleanup'],['residentCare','fileStorage'],['db','s3']]
EDGES = [
 ('admin','spa','Sube documentos'),
 ('spa','folderCtrl','JSON/HTTPS'),
 ('spa','uploadCtrl','1. Pide URL prefirmada / 3. Confirma'),
 ('spa','s3','2. Sube el archivo (PUT prefirmado)'),
 ('uploadCtrl','fileStorage','Firma, verifica metadatos y borra'),
 ('uploadCtrl','residentCare','EnqueueAsync / RemoveUploadAsync'),
 ('cleanup','fileStorage','Borra huérfanos'),
 ('fileStorage','s3','Prefirma URL, lee metadatos y borra (AWS SDK)'),
 ('folderCtrl','db','AppDbContext'),
 ('uploadCtrl','db','AppDbContext'),
 ('cleanup','db','Lee y borra pendientes'),
]

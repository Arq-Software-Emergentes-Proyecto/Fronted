# Fig. 123 - Component Level Diagram: bounded context Communications
WRAP = 19
LABELWRAP = 14
NODESEP = 0.10
TITLE = 'BuildingFex.Api - bounded context Communications (azul claro: componentes; gris: otros módulos)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores y residentes.'),
 ('jobs','job','Función de jobs','AWS Lambda + EventBridge Scheduler','Job import-cleanup en AWS.'),
 ('annCtrl','component','AnnouncementsCompat Controller','REST Controller','GET y POST /announcements; PUT y DELETE /announcements/{id}.'),
 ('uplCtrl','component','ImportUploadsController','REST Controller','/api/v1/import/uploads: signed-url, confirm, download-url, publish, archive, PATCH y DELETE.'),
 ('fldCtrl','component','ImportFoldersController','REST Controller','GET y POST /api/v1/import/folders; PATCH y DELETE .../{id}.'),
 ('svc','component','AnnouncementCommand / QueryService','Application Services','Crean, editan, eliminan y listan comunicados (vigentes por prioridad y fecha).'),
 ('dm','component','Domain Model','Domain Layer','Announcement, ImportUpload, ImportFolder.'),
 ('cleanup','component','ImportOrphanCleanup / Worker','Background Job','Borra cargas pending_upload sin confirmar tras 2 h (worker cada 30 min fuera de Lambda).'),
 ('repo','component','AnnouncementRepository','Repository (EF Core)','Implementa IAnnouncementRepository.'),
 ('ctx','component','AppDbContext','EF Core (compartido)','import_uploads e import_folders se leen y escriben directamente.'),
 ('storage','component','S3StorageService / FirebaseStorageService','Adapter (IFirebaseStorageService)','URL firmadas de subida y descarga (10 min, máx. 15), metadatos y borrado.'),
 ('iam','extcomp','Módulo IAM','BuildingFex.Api','IUserRepository: resuelve el administrador del condominio.'),
 ('rc','extcomp','Módulo Resident Care','BuildingFex.Api','IAiContextIndexingQueue e IAiContextIndexer: indexa los documentos de la carpeta Contexto IA.'),
 ('db','db','TiDB Cloud','MySQL compatible','announcements, import_uploads, import_folders.'),
 ('s3','ext','Amazon S3 / Firebase Storage','','Bucket privado con los archivos de los documentos.'),
]
ROWS = [['spa','jobs'],['annCtrl','fldCtrl','uplCtrl'],['svc','dm','cleanup','rc'],['iam','repo','storage'],['ctx','s3'],['db']]
EDGES = [
 ('spa','annCtrl',''),('spa','uplCtrl','JSON/HTTPS'),('spa','fldCtrl',''),
 ('spa','s3','PUT / GET con URL firmada (HTTPS)'),
 ('annCtrl','svc','Comandos y consultas'),
 ('svc','dm','Reglas'),('svc','repo','Persiste'),('svc','iam','Resuelve administrador'),
 ('uplCtrl','dm','Confirm, Publish, Supersede, Archive'),
 ('uplCtrl','ctx','Lee y escribe'),('fldCtrl','ctx',''),
 ('uplCtrl','storage','Firma y verifica'),
 ('uplCtrl','rc','Encola indexado / retira fragmentos'),
 ('repo','ctx',''),('cleanup','ctx','Borra pendientes'),('cleanup','storage','Borra objetos'),
 ('jobs','cleanup','import-cleanup'),
 ('ctx','db','EF Core'),('storage','s3','Firma, consulta y borra (AWS SDK / GCS)'),
]

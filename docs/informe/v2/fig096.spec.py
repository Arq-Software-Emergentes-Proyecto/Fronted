# Fig. 96 - Componentes del módulo Profiles (BuildingFex.Api)
WRAP = 20
NODES = [
 ('admin','person','Administrador','','Dueño de la cuenta (junta o empresa administradora).'),
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz web para administradores y residentes.'),
 ('profCtrl','component','ProfilesController','API Controller','/api/v1/profiles: registra y consulta el perfil (nombre, correo, DNI, empresa, RUC, dirección) y asegura la cuenta en IAM.'),
 ('bldCtrl','component','BuildingsController','API Controller','/api/v1/buildings: registra y edita el edificio y lista sus residentes.'),
 ('portCtrl','component','PortfolioController','API Controller','/api/v1/me/buildings y /api/v1/portfolio/buildings: edificios accesibles, resumen y alta de edificios (plan Portafolio).'),
 ('impCtrl','component','ResidentImportController','API Controller','/api/v1/residents/import: padrón y plantilla; ExcelRosterReader (.xlsx o .csv).'),
 ('impSvc','component','ResidentRosterImportService','Application Service','Valida las filas y crea los residentes con el comando de IAM, dentro del tope del plan.'),
 ('bldRepo','component','BuildingRepository','EF Core Repository','Acceso a los edificios.'),
 ('iam','extcomp','Módulo IAM','UserCommand/ QueryService, UserRepository, CallerContext Accessor','Cuentas, residentes, edificio activo y rol.'),
 ('billing','extcomp','Módulo Billing','SubscriptionService y SubscriptionPlans','Plan efectivo, tope de departamentos y vínculo del edificio a la suscripción.'),
 ('db','db','TiDB Cloud','MySQL compatible','profiles (FK user_external_id → users) y buildings.'),
]
CLUSTERS = {}
TITLE = 'BuildingFex.Api - módulo Profiles (azul claro: componentes del módulo; gris: otros módulos)'
ROWS = [['admin'],['spa'],['profCtrl','portCtrl'],['bldCtrl','impCtrl'],['bldRepo','impSvc'],['iam','db','billing']]
LABELWRAP = 14
NODESEP = 0.12
EDGES = [
 ('admin','spa','Perfil y edificio'),
 ('spa','profCtrl',''),('spa','bldCtrl','JSON/HTTPS'),
 ('spa','portCtrl','Cambia o agrega edificios'),
 ('spa','impCtrl','Sube el padrón (multipart)'),
 ('impCtrl','impSvc',''),
 ('bldCtrl','bldRepo','IUnitOfWork'),
 ('profCtrl','iam','UpsertFirebase AdminCommand'),
 ('bldCtrl','iam','Busca residentes'),
 ('portCtrl','iam','Edificios y rol'),
 ('impSvc','iam','CreateResident Command'),
 ('bldCtrl','billing','LinkBuildingAsync'),
 ('impSvc','billing','CheckRoster GrowthAsync'),
 ('portCtrl','billing','Exige plan Portafolio'),
 ('bldRepo','db','EF Core'),
 ('profCtrl','db','profiles'),
 ('portCtrl','db','Crea cuenta y edificio'),
]

# Fig. 108 - Component Level Diagram: bounded context Profiles
WRAP = 19
LABELWRAP = 14
NODESEP = 0.12
TITLE = 'BuildingFex.Api - bounded context Profiles (azul claro: componentes; gris: otros módulos e infraestructura)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores, junta directiva y residentes. Envía X-Building-Id.'),
 ('bldCtrl','component','BuildingsController','REST Controller','POST /api/v1/buildings, GET .../mine, GET y PUT .../{id}, GET .../{id}/residents.'),
 ('profCtrl','component','ProfilesController','REST Controller','POST /api/v1/profiles, GET .../me y GET .../{userId}.'),
 ('impCtrl','component','ResidentImportController','REST Controller','POST /api/v1/residents/import (Excel o CSV, todo o nada) y GET .../template.'),
 ('portCtrl','component','PortfolioController','REST Controller','GET /api/v1/me/buildings; GET y POST /api/v1/portfolio/buildings.'),
 ('imp','component','ResidentRosterImportService','Application Service','Valida todas las filas y registra a los residentes en una sola transacción (RosterImportResult, RosterRowError).'),
 ('xls','component','ExcelRosterReader','Adapter','Lee en memoria el Excel o CSV (RosterSheet, RosterRawRow) y genera la plantilla.'),
 ('dm','component','Domain Model','Domain Layer','Building, Profile; IBuildingRepository.'),
 ('repo','component','BuildingRepository','Repository (EF Core)','IBuildingRepository sobre la tabla buildings.'),
 ('iam','extcomp','Módulo IAM','BuildingFex.Api','UserCommandService (CreateResident, UpsertFirebaseAdmin), UserQueryService, IUserRepository, CallerContextAccessor.'),
 ('billing','extcomp','Módulo Billing','BuildingFex.Api','ISubscriptionService: límite del plan y vínculo del edificio con la suscripción.'),
 ('dbctx','extcomp','AppDbContext','Infraestructura compartida (EF Core)','DbContext único de BuildingFex.Api.'),
 ('db','db','TiDB Cloud','MySQL compatible','buildings, profiles.'),
]
ROWS = [['spa'],['bldCtrl','profCtrl'],['dm','repo','portCtrl'],['impCtrl','billing'],['xls','imp'],['iam','dbctx'],['db']]
EDGES = [
 ('spa','bldCtrl','JSON/HTTPS'),('spa','profCtrl',''),('spa','impCtrl',''),('spa','portCtrl',''),
 ('bldCtrl','dm','Register / Update'),('bldCtrl','repo','Lee y persiste'),
 ('bldCtrl','iam','Residentes del edificio'),('bldCtrl','billing','LinkBuilding Async'),
 ('profCtrl','iam','UpsertFirebase AdminCommand'),('profCtrl','dbctx','profiles'),
 ('impCtrl','xls','Lee el archivo'),('impCtrl','imp','ImportAsync'),
 ('imp','iam','CreateResident Command'),('imp','billing','CheckRoster GrowthAsync'),('imp','dbctx','Transacción'),
 ('portCtrl','iam','Edificios y rol'),('portCtrl','dbctx','buildings y cuentas del Portafolio'),
 ('repo','dbctx','EF Core'),('dbctx','db','MySQL'),
]

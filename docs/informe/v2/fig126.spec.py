# Fig. 126 - Component Level Diagram: bounded context Team
WRAP = 22
LABELWRAP = 16
NODESEP = 0.14
TITLE = 'BuildingFex.Api - bounded context Team (azul claro: componentes; gris: otros módulos)'
TITLEWRAP = 50
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores y residentes.'),
 ('staffCtrl','component','TeamWorkersCompat Controller','REST Controller','GET y POST /api/v1/staff; PATCH .../{id}, .../{id}/deactivate, .../{id}/reactivate; DELETE .../{id} (también /teamWorkers).'),
 ('taskCtrl','component','TasksController','REST Controller','GET y POST /api/v1/tasks; GET .../{id}; PATCH .../{id}/start, .../complete y .../reassign.'),
 ('shiftCtrl','component','ShiftsController','REST Controller','GET y POST /api/v1/shifts; GET, PUT/PATCH y DELETE .../{id}.'),
 ('svc','component','TeamWorker / MaintenanceTask / Shift CommandService','Application Services','Registran, desactivan y reasignan trabajadores; crean, inician, completan y reasignan tareas; gestionan turnos sin cruces.'),
 ('dm','component','Domain Model','Domain Layer','TeamWorker, MaintenanceTask, Shift, WorkloadPolicy.'),
 ('repo','component','TeamWorker / MaintenanceTask / Shift Repository','Repository (EF Core)','Implementan los repositorios sobre TiDB Cloud.'),
 ('inc','extcomp','Módulo Incidents','BuildingFex.Api','IIncidentRepository (valida la incidencia ligada) e IIncidentCommandService (ResolveIncidentCommand).'),
 ('db','db','TiDB Cloud','MySQL compatible','team_workers, maintenance_tasks, shifts.'),
]
ROWS = [['spa'],['staffCtrl','taskCtrl','shiftCtrl'],['svc'],['dm','repo','inc'],['db']]
EDGES = [
 ('spa','staffCtrl',''),('spa','taskCtrl','JSON/HTTPS'),('spa','shiftCtrl',''),
 ('staffCtrl','svc','Llama'),('taskCtrl','svc','Llama'),('shiftCtrl','svc','Llama'),
 ('svc','dm','Reglas del dominio'),('svc','repo','Persiste'),
 ('svc','inc','Valida incidencia; TareaCompletada'),
 ('repo','db','EF Core'),
]

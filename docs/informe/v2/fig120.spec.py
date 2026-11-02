# Fig. 120 - Component Level Diagram: bounded context Incidents
WRAP = 19
LABELWRAP = 14
NODESEP = 0.10
TITLE = 'BuildingFex.Api - bounded context Incidents (azul claro: componentes; gris: otros módulos)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores y residentes.'),
 ('rc','extcomp','Módulo Resident Care','BuildingFex.Api','SupportController reporta incidencias desde el chat; IncidentResolutionNotifier recibe IncidenteResuelto.'),
 ('team','extcomp','Módulo Team','BuildingFex.Api','MaintenanceTaskCommandService resuelve la incidencia al completarse su última tarea ligada.'),
 ('jobs','job','Función de jobs','AWS Lambda + EventBridge Scheduler','Job incident-escalation cada hora (en local, IncidentEscalationWorker).'),
 ('incCtrl','component','IncidentsCompat Controller','REST Controller','/api/v1/incidents (y /incidents): GET, POST, PUT, DELETE, triage-suggestion, triage, assign, resolve y comments.'),
 ('spCtrl','component','ServiceProviders CompatController','REST Controller','GET, POST /serviceProviders y DELETE /serviceProviders/{id}.'),
 ('cmd','component','IncidentCommand Service','Application Service (IIncidentCommandService)','Handle() de Create, Update, Assign, ConfirmTriage, AddComment, Resolve y Delete.'),
 ('qry','component','IncidentQueryService','Application Service (IIncidentQueryService)','Incidencias del condominio por residente y estado.'),
 ('tri','component','IncidentTriageService','Application Service','Sugerencia de categoría y prioridad con IA (plan Standard o superior, tope mensual de IA).'),
 ('esc','component','IncidentEscalationJob','Background Job','Escala las incidencias abiertas y sin proveedor tras 48 horas.'),
 ('dm','component','Domain Model','Domain Layer','Incident, IncidentEvent, BuildingServiceProvider, EscalationPolicy, IncidentActor.'),
 ('repo','component','IncidentRepository / ServiceProvider Repository','Repository (EF Core)','IIncidentRepository e IServiceProviderRepository sobre TiDB Cloud.'),
 ('adv','component','GeminiIncident TriageAdvisor','Anticorruption Layer (IIncidentTriageAdvisor)','Pide a Gemini un JSON con categoría, prioridad y motivo, y lo valida.'),
 ('db','db','TiDB Cloud','MySQL compatible','incidents, incident_events, service_providers.'),
 ('gemini','ext','Google Gemini API','','Proveedor de IA (IGeminiClient compartido con Resident Care).'),
]
ROWS = [['rc','spa','team'],['spCtrl','incCtrl','jobs'],['qry','cmd','tri','esc'],['dm','repo','adv'],['db','gemini']]
EDGES = [
 ('spa','incCtrl','JSON/HTTPS'),('spa','spCtrl',''),
 ('rc','cmd','CreateIncident Command'),('team','cmd','ResolveIncident Command'),
 ('jobs','esc','RunOnceAsync'),
 ('incCtrl','cmd','Envía comando'),('incCtrl','qry','Consulta'),('incCtrl','tri','Pide triaje'),
 ('spCtrl','db','service_providers (AppDbContext)'),
 ('cmd','dm','Reglas'),('cmd','repo','Persiste'),('cmd','rc','IncidenteResuelto'),
 ('qry','repo','Lee'),('tri','adv','SuggestAsync'),('tri','repo','Guarda sugerencia'),
 ('esc','repo','Candidatas y escalamiento'),
 ('adv','gemini','generateContent (HTTPS)'),
 ('repo','db','EF Core'),
]

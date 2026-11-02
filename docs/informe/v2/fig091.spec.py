# Fig. 91 - Componentes del módulo Incidents (BuildingFex.Api)
WRAP = 19
LABELWRAP = 14
NODESEP = 0.12
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz web para administradores y residentes.'),
 ('jobs','job','Función de jobs','AWS Lambda + EventBridge','Job incident-escalation (cada hora); en local, IncidentEscalationWorker.'),
 ('team','extcomp','Módulo Team','MaintenanceTask CommandService','Al completar la última tarea ligada, resuelve la incidencia.'),
 ('incCtrl','component','IncidentsCompatController','API Controller','/incidents y /api/v1/incidents: registro, consulta, triaje (triage-suggestion y triage), asignación, resolución, comentarios y baja.'),
 ('provCtrl','component','ServiceProviders CompatController','API Controller','/serviceProviders: alta, consulta y baja de proveedores (AppDbContext).'),
 ('qrySvc','component','IncidentQueryService','Query Service','Incidencias por condominio y residente.'),
 ('cmdSvc','component','IncidentCommandService','Application Service','Create, Update, Assign, Resolve, AddComment, ConfirmTriage y Delete; cada cambio queda como IncidentEvent.'),
 ('triage','component','IncidentTriageService','Application Service','Sugerencia de categoría y prioridad con IA, sujeta al plan y al tope de consultas.'),
 ('escJob','component','IncidentEscalationJob','Application Service','Escala las incidencias sin asignar tras 48 h (EscalationPolicy).'),
 ('advisor','component','GeminiIncidentTriageAdvisor','Infrastructure (IIncidentTriageAdvisor)','Arma el prompt de triaje y llama al gateway de IA.'),
 ('incRepo','component','IncidentRepository','EF Core Repository','Incidencias y su historial (incident_events).'),
 ('provRepo','component','ServiceProviderRepository','EF Core Repository','Proveedores del condominio.'),
 ('rc','extcomp','Módulo Resident Care','SupportController, IncidentResolutionNotifier, PlanQuotaClient, AiUsageQuota','Reporta incidencias desde el chat, avisa al resolverse; plan y tope de IA.'),
 ('hub','extcomp','Hub de avisos','SupportHub (SignalR, solo fuera de Lambda)','Aviso incidentUpdated al admin y al residente; en AWS, consulta periódica.'),
 ('ai','extcomp','Gateway de IA','GeminiClient','Único acceso a Gemini.'),
 ('db','db','TiDB Cloud','MySQL compatible','incidents, incident_events y service_providers.'),
 ('gemini','ext','Google Gemini API','','Proveedor de IA externo.'),
]
CLUSTERS = {}
TITLE = 'BuildingFex.Api - módulo Incidents (azul claro: componentes del módulo; gris: otros módulos)'
ROWS = [['spa','team','jobs'],['provCtrl','incCtrl'],['qrySvc','cmdSvc','hub'],['triage','escJob'],['provRepo','incRepo','advisor'],['db','rc','ai'],['gemini']]
EDGES = [
 ('spa','incCtrl','JSON/HTTPS'),('spa','provCtrl',''),
 ('rc','cmdSvc','CreateIncident Command (y triaje)'),
 ('team','cmdSvc','ResolveIncident Command'),
 ('jobs','escJob','Ejecuta incident-escalation'),
 ('incCtrl','cmdSvc',''),('incCtrl','qrySvc',''),('incCtrl','triage',''),
 ('incCtrl','hub','Avisa cambios'),
 ('cmdSvc','incRepo',''),('cmdSvc','provRepo',''),
 ('cmdSvc','rc','NotifyResolved Async'),
 ('qrySvc','incRepo',''),('triage','incRepo',''),('triage','advisor',''),
 ('triage','rc','Plan y tope de IA'),
 ('advisor','ai','GenerateReply Async'),
 ('ai','gemini','generateContent (HTTPS)'),
 ('escJob','incRepo',''),('escJob','hub','Avisa escalamiento'),
 ('incRepo','db','EF Core'),('provRepo','db',''),('provCtrl','db','AppDbContext'),
]

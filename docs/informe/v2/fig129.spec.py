# Fig. 129 - Component Level Diagram: bounded context Resident Care
WRAP = 18
LABELWRAP = 13
NODESEP = 0.06
TITLE = 'BuildingFex.Api - bounded context Resident Care (azul claro: componentes; gris: otros módulos)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores y residentes.'),
 ('comms','extcomp','Módulo Communications','BuildingFex.Api','ImportUploadsController encola el indexado y retira fragmentos de documentos reemplazados o archivados.'),
 ('jobs','job','Función de jobs','AWS Lambda + EventBridge Scheduler','Job ai-index: invocación asíncrona por documento y barrido programado.'),
 ('ctrl','component','SupportController','REST Controller','/api/v1/support: chats, summary, ai-usage, messages (AskQuestion), status, close e incident.'),
 ('hub','component','SupportHub','SignalR Hub (fuera de AWS Lambda)','/hubs/support: JoinOwner() y JoinChat(); avisos en vivo. En Lambda el frontend consulta periódicamente.'),
 ('quota','component','AiUsageQuota','Application Service','Tope mensual por edificio y límite diario por residente (UPDATE condicional atómico).'),
 ('idx','component','AiContextIndexer','Application Service','Fragmenta, genera embeddings, recupera fragmentos de documentos vigentes y retira los no vigentes.'),
 ('jobsvc','component','AiContextIndexing Job / Worker / Queue','Background Job','Indexado en segundo plano (BackgroundService fuera de Lambda).'),
 ('notif','component','IncidentResolution Notifier','Application Service','IIncidentResolutionNotifier: deja la resolución en el chat de origen y lo cierra.'),
 ('dm','component','Domain Model','Domain Layer','SupportChat, SupportMessage, AiContextChunk, AiUsage, AnswerPolicy, QuestionRelevancePolicy.'),
 ('gem','component','GeminiClient / Embedding Client / RateLimiter','Anticorruption Layer','Respuestas, títulos y embeddings con timeout, reintento y circuit breaker.'),
 ('pqc','component','PlanQuotaClient','Anticorruption Layer','Tope mensual del plan efectivo y módulos incluidos.'),
 ('lq','component','LambdaAiContext IndexingQueue','Adapter','En AWS invoca de forma asíncrona el job ai-index.'),
 ('ctx','component','AppDbContext','EF Core (compartido)','support_chats, support_messages, ai_context_chunks, ai_usages, resident_ai_usages.'),
 ('inc','extcomp','Módulo Incidents','BuildingFex.Api','CreateIncidentCommand e IncidentTriageService; al resolver llama a IIncidentResolutionNotifier.'),
 ('billing','extcomp','Módulo Billing','BuildingFex.Api','SubscriptionPlans y PlanCatalog.'),
 ('stor','extcomp','IFirebaseStorage Service (Communications)','Adapter compartido','Descarga los bytes del documento a indexar.'),
 ('db','db','TiDB Cloud','MySQL compatible','Esquema de Resident Care.'),
 ('gemini','ext','Google Gemini API','','Proveedor de IA.'),
]
ROWS = [['spa','comms','jobs'],['hub','ctrl','jobsvc'],['inc','quota','pqc','lq'],['notif','dm','billing','idx'],['ctx','gem','stor'],['db','gemini']]
EDGES = [
 ('spa','ctrl','JSON/HTTPS; en AWS, consulta periódica'),
 ('spa','hub','Chat en vivo, WSS (fuera de Lambda)'),
 ('comms','jobsvc','Encola documento'),('comms','idx','RemoveUpload Async'),
 ('ctrl','dm','Reglas'),('ctrl','quota','Reserva consulta'),('ctrl','pqc','Tope del plan'),
 ('ctrl','idx','Recupera fragmentos'),('ctrl','gem','Genera respuesta'),
 ('ctrl','inc','Reportar incidente'),('ctrl','ctx',''),
 ('inc','notif','IncidenteResuelto'),('notif','ctx',''),('quota','ctx','SQL atómico'),
 ('jobsvc','idx','IndexUpload Async'),('jobsvc','lq','En AWS'),
 ('lq','jobs','Invoke (Event)'),('jobs','jobsvc','ai-index'),
 ('idx','gem','Embeddings'),('idx','stor','Descarga archivo'),('idx','ctx','Guarda fragmentos'),
 ('pqc','billing','Catálogo'),
 ('gem','gemini','generateContent y embedContent'),
 ('ctx','db','EF Core'),
]

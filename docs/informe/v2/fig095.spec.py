# Fig. 95 - Componentes del módulo Resident Care (BuildingFex.Api)
WRAP = 17
LABELWRAP = 13
NODESEP = 0.05
TITLE = 'BuildingFex.Api - módulo Resident Care (azul claro: componentes del módulo; gris: otros módulos)'
TITLEWRAP = 75
NODES = [
 ('resident','person','Residente','','Hace consultas al asistente.'),
 ('admin','person','Administrador','','Atiende las consultas derivadas.'),
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz web para administradores y residentes.'),
 ('communications','extcomp','Módulo Communications','ImportUploads Controller','Encola el documento confirmado o publicado y retira el archivado.'),
 ('jobs','job','Función de jobs','AWS Lambda + EventBridge','Job ai-index: invocación asíncrona y barrido cada 30 min.'),
 ('rcCtrl','component','SupportController','API Controller','/api/v1/support: chats, mensajes, estado, cierre, uso de IA y «Reportar como incidencia». Filtra, aplica cupos, recupera contexto, responde y deriva al admin.'),
 ('rcHub','component','SupportHub','SignalR (/hubs/support, solo fuera de Lambda)','Avisos en vivo de mensajes y derivaciones; en AWS el chat usa consulta periódica.'),
 ('policies','component','Políticas del dominio','Domain Services','QuestionRelevancePolicy, AnswerPolicy, SupportEscalate y ResidentAssistantPrompt.'),
 ('quota','component','AiUsageQuota','Application Service','Tope mensual por condominio (ai_usages) y diario por residente (resident_ai_usages).'),
 ('planQuota','component','PlanQuotaClient','Anticorruption Layer','Tope de consultas y módulos del plan, publicado por Billing.'),
 ('indexer','component','AiContextIndexer','Application Service','Divide el documento, guarda embeddings en ai_context_chunks y recupera los fragmentos más parecidos.'),
 ('indexJob','component','AiContextIndexingJob','Application Service','Indexa los pendientes; en local lo dispara AiContextIndexingWorker desde AiContextIndexingQueue.'),
 ('notifier','component','IncidentResolution Notifier','Application Service','Implementa IIncidentResolutionNotifier: deja un aviso en el chat de origen.'),
 ('gateway','extcomp','Gateway de IA','GeminiClient, GeminiEmbedding Client, GeminiRate Limiter','Único acceso a Gemini.'),
 ('gemini','ext','Google Gemini API','','Proveedor de IA externo.'),
 ('incidents','extcomp','Módulo Incidents','IncidentCommand Service e IncidentTriage Service','Registra la incidencia del chat y avisa al resolverla.'),
 ('billing','extcomp','Módulo Billing','SubscriptionPlans y PlanCatalog','Plan efectivo y tope mensual de consultas.'),
 ('storage','extcomp','File Storage','S3StorageService','Descarga del documento.'),
 ('db','db','TiDB Cloud','MySQL compatible','support_chats, support_messages, ai_context_chunks, ai_usages, resident_ai_usages.'),
]
ROWS = [['resident','admin','communications','jobs'],['spa','incidents','indexJob'],['rcCtrl'],['policies','quota','planQuota','notifier'],['rcHub','indexer','billing'],['gateway','db','storage'],['gemini']]
EDGES = [
 ('resident','spa','Consulta al asistente'),('admin','spa','Responde consultas derivadas'),
 ('spa','rcCtrl','JSON/HTTPS (en AWS, consulta periódica)'),
 ('spa','rcHub','Avisos (local, WSS)'),
 ('rcCtrl','policies','Aplica'),('rcCtrl','quota','Reserva y libera cupo'),('rcCtrl','planQuota','Tope del plan'),
 ('rcCtrl','indexer','RetrieveAsync'),('rcCtrl','gateway','GenerateReply Async'),
 ('rcCtrl','rcHub','Avisa'),('rcCtrl','incidents','CreateIncident Command'),
 ('incidents','notifier','NotifyResolved Async'),
 ('communications','indexJob','Encola ai-index'),
 ('communications','indexer','RemoveUpload Async'),
 ('jobs','indexJob','Ejecuta ai-index'),
 ('indexJob','indexer','IndexUpload Async'),
 ('indexer','gateway','EmbedAsync'),('indexer','storage','DownloadBytes Async'),
 ('planQuota','billing','Lee el plan'),
 ('gateway','gemini','generateContent y embeddings (HTTPS)'),
 ('rcCtrl','db','Chats y mensajes (AppDbContext)'),('quota','db',''),('indexer','db',''),('notifier','db','Escribe el aviso'),
]

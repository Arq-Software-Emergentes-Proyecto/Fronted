# Fig. 102 - Diagrama de despliegue: producción (AWS Lambda + Vercel + TiDB Cloud)
WRAP = 21
LABELWRAP = 15
NODESEP = 0.10
RANKSEP = 0.30
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Compilada con VITE_REALTIME=false: el chat de soporte usa consulta periódica (polling).'),
 ('static','container','SPA estática','Vite build (dist/)','HTML, JS y CSS servidos desde la CDN.'),
 ('rewrites','dnode','Rewrites','vercel.json','Reenvían /api/v1/* y las rutas de compatibilidad a API Gateway.'),
 ('apigw','dnode','Amazon API Gateway','HTTP API','Ruta ANY /{proxy+}; 50 req/s, ráfaga de 100.'),
 ('logs','dnode','Amazon CloudWatch Logs','Un grupo por función','Logs de ApiFunction y JobsFunction; retención de 14 días.'),
 ('api','container','BuildingFex.Api','ASP.NET Core (.NET 10)','Monolito modular (9 módulos). Valida el ID token. Sin SignalR.'),
 ('scheduler','dnode','Amazon EventBridge Scheduler','4 schedules','monthly-billing diario 06:15 (Lima); incident-escalation cada hora; import-cleanup y ai-index cada 30 min.'),
 ('jobs','container','Función de jobs','Mismo paquete .NET','migrate, monthly-billing, incident-escalation, import-cleanup y ai-index.'),
 ('files','db','Almacenamiento de archivos','Amazon S3 (FilesBucket)','Privado y cifrado; CORS solo del frontend.'),
 ('db','db','Base de datos TiDB Cloud','TiDB Cloud Starter (compatible con MySQL)','Base buildingfex; TLS con SslMode=VerifyFull.'),
 ('fbauth','ext','Firebase Authentication','','Proyecto emergentes-36306. La API verifica el ID token (Admin SDK).'),
 ('gemini','ext','Google Gemini API','','Chat del asistente y triaje (API); embeddings (job ai-index).'),
 ('mp','ext','Checkout Pro','','Cuotas y suscripción.'),
]
CLUSTERS = {
 'Navegador del usuario|[Escritorio o móvil]': ['spa'],
 'Vercel|[CDN global, fronted-seven-opal.vercel.app]': ['static','rewrites'],
 'Mercado Pago': ['mp'],
 'Amazon Web Services|[us-east-2 (Ohio)]': ['apigw','logs','scheduler','files',
     {'AWS Lambda: ApiFunction|[dotnet10, arm64, 1024 MB, 30 s]': ['api']},
     {'AWS Lambda: JobsFunction|[dotnet10, arm64, 600 s]': ['jobs']}],
 'Google Cloud': ['fbauth','gemini'],
 'TiDB Cloud|[AWS us-east-1]': ['db'],
}
ROWS = [['spa'],['static','rewrites','mp'],['apigw','logs'],['scheduler','api','fbauth'],['jobs','gemini'],['files','db']]
EDGES = [
 ('spa','static','Descarga la SPA (HTTPS)'),
 ('spa','rewrites','/api/v1 y rutas de compatibilidad (HTTPS/JSON)'),
 ('spa','fbauth','Inicia sesión y obtiene el ID token (HTTPS)'),
 ('spa','files','Sube y descarga con URL prefirmada (10 min, máx. 15)'),
 ('spa','mp','Paga en Checkout Pro'),
 ('rewrites','apigw','Reenvía (HTTPS)'),
 ('apigw','api','Invoca (proxy)'),
 ('api','db','EF Core, TLS'),
 ('api','files','Firma URL y verifica metadatos'),
 ('api','jobs','Invoca ai-index (asíncrono)'),
 ('api','fbauth',''),
 ('api','gemini','Chat y triaje'),
 ('api','mp','Crea el cobro y consulta el pago'),
 ('mp','apigw','Webhook POST /api/v1/payments/webhook (x-signature)'),
 ('scheduler','jobs','Programa los jobs'),
 ('jobs','db','EF Core, TLS'),
 ('jobs','files','Lee y borra objetos'),
 ('jobs','gemini',''),
]

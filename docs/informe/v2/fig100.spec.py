# Fig. 100 - Diagrama de despliegue: entorno local
WRAP = 21
LABELWRAP = 15
NODESEP = 0.12
RANKSEP = 0.30
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','http://localhost:5173. La cuenta demo test / 123456 funciona sin la API (datos de ejemplo).'),
 ('devserver','container','Servidor de desarrollo','Vite','Sirve la SPA y reenvía /api, /hubs y rutas de compatibilidad a :5001.'),
 ('api','container','BuildingFex.Api','ASP.NET Core (.NET 10)','Monolito modular con 9 módulos. Swagger UI en /swagger. Aplica el esquema al arrancar.'),
 ('workers','container','Workers','BackgroundService','Indexación IA, limpieza de importaciones, cobro mensual y escalamiento de incidencias, en el mismo proceso.'),
 ('hub','container','Hub SignalR','/hubs/support','Mensajes y avisos en vivo (soporte e incidencias). Solo existe en local.'),
 ('mysql','db','MySQL 8.4','Contenedor buildingfex-mysql, puerto 3306','Base de datos local buildingfex (en producción, TiDB Cloud).'),
 ('fbauth','ext','Firebase Authentication','','Proyecto emergentes-36306.'),
 ('gemini','ext','Google Gemini API','','Clave de desarrollo.'),
 ('mp','ext','Mercado Pago (sandbox)','','Checkout Pro con credenciales de prueba.'),
 ('s3','ext','Amazon S3 (opcional)','','Solo con BF_FILES_BUCKET; si no, la API usa el adaptador heredado de Firebase Storage.'),
]
CLUSTERS = {
 'Equipo del desarrollador|[Windows, macOS o Linux]': [
    {'Navegador web|[Chrome, Edge o Firefox]': ['spa']},
    {'Vite dev server|[Node.js, puerto 5173]': ['devserver']},
    {'dotnet run|[Kestrel, http://localhost:5001]': ['api','workers','hub']},
    {'Docker Compose|[Docker]': ['mysql']}],
 'Servicios en la nube|[Claves de desarrollo o sandbox]': ['fbauth','gemini','mp','s3'],
}
ROWS = [['spa'],['devserver','fbauth'],['hub','api','workers'],['mysql','gemini'],['mp','s3']]
EDGES = [
 ('spa','devserver','Carga la SPA y llama a /api (HTTP :5173)'),
 ('devserver','api','Proxy de /api y rutas de compatibilidad (HTTP :5001)'),
 ('devserver','hub','Proxy de /hubs/support (WebSocket)'),
 ('spa','fbauth','Inicia sesión y obtiene el ID token (HTTPS)'),
 ('api','mysql','EF Core, TCP 3306'),
 ('workers','mysql','EF Core'),
 ('api','fbauth','Verifica el ID token'),
 ('api','gemini','Chat y embeddings'),
 ('api','mp','Crea pagos de prueba'),
 ('api','s3','URL prefirmadas (opcional)'),
]

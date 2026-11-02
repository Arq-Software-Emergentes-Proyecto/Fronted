# Fig. 111 - Component Level Diagram: bounded context Finances
WRAP = 18
LABELWRAP = 14
NODESEP = 0.06
TITLE = 'BuildingFex.Api - bounded context Finances (azul claro: componentes; gris: otros módulos e infraestructura)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores, junta directiva y residentes.'),
 ('jobs','job','Función de jobs','AWS Lambda + EventBridge Scheduler','Job monthly-billing: diario a las 06:15 (Lima).'),
 ('mp','ext','Mercado Pago','','Checkout Pro, API de pagos y webhooks.'),
 ('opsCtrl','component','FinanceOperations Controller','REST Controller','/api/v1/finances: receipts/generate, billing-alerts, payment-calendar, PDF de pago y de recibo, balance.'),
 ('dashCtrl','component','DashboardController','REST Controller','GET /api/v1/finances/kpi.'),
 ('mpCtrl','component','MercadoPagoController','REST Controller','/api/v1/payments: config, preference, checkout, confirm, process y webhook (x-signature).'),
 ('compat','component','Controladores Compat','REST Controllers','9 controladores con rutas json-server (/fees, /receipts, /financeSettings…): cuotas, pagos, recibos, configuración, KPI, gastos y cargos extra.'),
 ('worker','component','MonthlyBillingWorker','Background Job: solo fuera de Lambda (local)','Ejecuta la facturación de todos los condominios una vez al día.'),
 ('bill','component','MonthlyBillingService','Application Service','Emite (idempotente) los recibos del mes según FinanceSetting; alertas de facturación.'),
 ('qs','component','Servicios de consulta','Application Services','AccountStatus, PaymentCalendar y Dashboard QueryService.'),
 ('rds','component','ReceiptDocumentService','Application Service','Comprobante PDF de un pago o de un recibo pagado.'),
 ('mps','component','MercadoPagoService','Application Service','Checkout Pro, pago con tarjeta y conciliación idempotente.'),
 ('pdf','component','SimpleReceiptPdfRenderer','Adapter','Implementa IReceiptPdfRenderer (PDF 1.4).'),
 ('dm','component','Domain Model','Domain Layer','10 agregados (Fee, Payment, Receipt, FinanceSetting, MaintenanceCheckout…); Money, Period, MonthlyCharge; DelinquencyPolicy (Fig. 112).'),
 ('repo','component','Repositorios EF Core','Repository (EF Core)','Un repositorio por agregado (9; ResidentExtraCharge no tiene).'),
 ('social','extcomp','Módulo Social Spaces','BuildingFex.Api','FinancesAccountStatusAcl: regla de reservas para morosos.'),
 ('billing','extcomp','Módulo Billing','BuildingFex.Api','Usa MercadoPagoService; activa el plan pagado.'),
 ('iam','extcomp','Módulos IAM y Profiles','BuildingFex.Api','IUserRepository, CallerContextAccessor e IBuildingRepository.'),
 ('dbctx','extcomp','AppDbContext','Infraestructura compartida (EF Core)','DbContext único de BuildingFex.Api.'),
 ('db','db','TiDB Cloud','MySQL compatible','Las 10 tablas de Finances (Fig. 113).'),
]
ROWS = [['spa','jobs','mp'],['compat','opsCtrl','dashCtrl','mpCtrl'],['worker','bill','qs','mps'],['social','rds','dm','billing'],['repo','pdf','iam'],['dbctx'],['db']]
EDGES = [
 ('spa','opsCtrl','JSON/HTTPS'),('spa','dashCtrl',''),('spa','mpCtrl',''),('spa','compat',''),
 ('jobs','bill','monthly-billing'),
 ('worker','bill',''),
 ('opsCtrl','bill','Genera recibos'),('opsCtrl','qs','Consulta'),('opsCtrl','rds','PDF'),
 ('dashCtrl','qs','KPI'),
 ('mpCtrl','mps','Preferencia, confirmación y webhook'),
 ('compat','repo','Lee y persiste'),
 ('bill','dm','Receipt.Create Monthly'),('mps','dm','Reglas'),('mps','repo','Persiste'),
 ('rds','pdf','Render'),
 ('bill','dbctx',''),('qs','dbctx',''),('rds','dbctx',''),('repo','dbctx','EF Core'),
 ('dbctx','db','MySQL'),
 ('mps','mp','Preferencias y pagos (SDK, HTTPS)'),
 ('mp','mpCtrl','Webhook firmado (x-signature)'),
 ('mps','billing','Activa la suscripción'),
 ('social','qs','Consulta morosidad'),
 ('mps','iam','Residentes y condominio'),
]

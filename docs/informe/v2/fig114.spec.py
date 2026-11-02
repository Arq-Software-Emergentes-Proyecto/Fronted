# Fig. 114 - Component Level Diagram: bounded context Billing
WRAP = 19
LABELWRAP = 14
NODESEP = 0.10
TITLE = 'BuildingFex.Api - bounded context Billing (azul claro: componentes; gris: otros módulos)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores y residentes.'),
 ('iam','extcomp','Módulo IAM','BuildingFex.Api','UserCommandService: prueba Free al registrar un administrador y tope de residentes.'),
 ('profiles','extcomp','Módulo Profiles','BuildingFex.Api','BuildingsController y ResidentRosterImportService: edificio principal y tope de departamentos.'),
 ('plansCtrl','component','PlansController','REST Controller','GET /api/v1/plans, .../plans/{planId} y .../plans/suggest (público).'),
 ('subCtrl','component','SubscriptionController','REST Controller','GET y PATCH /api/v1/subscription; POST .../checkout y .../confirm; GET .../limits.'),
 ('svc','component','SubscriptionService','Application Service (ISubscriptionService)','GetOrStart, StartTrial, ActivatePaidPlan, ChangeToFree, CreateCheckout, ApplyPayment, CheckRosterGrowth, LinkBuilding (Async).'),
 ('dm','component','Domain Model','Domain Layer','Subscription, SubscriptionPayment, SubscriptionCheckout, PlanLimits, SubscriptionPlans, PlanCatalog, SubscriptionStatus.'),
 ('repo','component','SubscriptionRepository','Repository (EF Core)','Implementa ISubscriptionRepository sobre TiDB Cloud.'),
 ('fin','extcomp','MercadoPagoService (Finances)','IMercadoPagoService','Preferencia Checkout Pro, confirm y webhook (POST /api/v1/payments/webhook, firma x-signature).'),
 ('rc','extcomp','Módulo Resident Care','BuildingFex.Api','PlanQuotaClient: tope de consultas de IA y módulos del plan.'),
 ('mp','ext','Mercado Pago','','Checkout Pro: pago de cada periodo.'),
 ('db','db','TiDB Cloud','MySQL compatible','subscriptions, subscription_payments, subscription_checkouts.'),
]
ROWS = [['iam','spa','profiles'],['plansCtrl','subCtrl'],['rc','fin'],['svc','mp'],['dm','repo'],['db']]
EDGES = [
 ('spa','subCtrl','JSON/HTTPS'),('spa','plansCtrl',''),
 ('iam','svc','StartTrial, CheckRoster Growth'),
 ('profiles','svc','LinkBuilding, CheckRoster Growth'),
 ('plansCtrl','dm','Lee PlanCatalog'),
 ('subCtrl','svc',''),
 ('subCtrl','fin','Checkout y confirm'),
 ('fin','svc','CreateCheckout, ApplyPayment'),
 ('svc','dm','Reglas del dominio'),('svc','repo','Persiste'),
 ('rc','dm','Lee topes del plan'),
 ('fin','mp','Preferencia, pago y webhook (HTTPS)'),
 ('repo','db','EF Core'),
]

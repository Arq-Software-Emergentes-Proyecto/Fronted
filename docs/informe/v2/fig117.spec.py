# Fig. 117 - Component Level Diagram: bounded context Social Spaces
WRAP = 20
LABELWRAP = 14
NODESEP = 0.12
TITLE = 'BuildingFex.Api - bounded context Social Spaces (azul claro: componentes; gris: otros módulos)'
NODES = [
 ('spa','container','BuildingFex Web SPA','Vue 3','Interfaz para administradores, residentes y la página pública del invitado.'),
 ('spCtrl','component','SocialSpacesCompat Controller','REST Controller','GET, POST /socialSpaces; GET, PATCH, DELETE /socialSpaces/{id}.'),
 ('resCtrl','component','ReservationsCompat Controller','REST Controller','GET, POST /reservations; GET, PATCH, DELETE /reservations/{id}; POST .../{id}/cancel.'),
 ('gpCtrl','component','GuestPassesController','REST Controller','GET /api/v1/guest-passes/{token} (público) y POST .../{token}/check-in (portería).'),
 ('svc','component','ReservationCommand Service','Application Service','CreateAsync, UpdateGuestsAsync, CancelAsync, PurgeAsync, CheckInByTokenAsync. Usa GuestListSanitizer y SocialSpacesClock.'),
 ('dm','component','Domain Model','Domain Layer','SocialSpace, Reservation (con el pase QR), TimeSlot y ReservationPolicy.'),
 ('acl','component','FinancesAccountStatusAcl','Anticorruption Layer (IAccountStatusAcl)','¿El reglamento impide reservar al residente moroso?'),
 ('repo','component','SocialSpaceRepository / ReservationRepository','Repository (EF Core)','BeginBookingAsync bloquea el espacio (SELECT ... FOR UPDATE).'),
 ('finances','extcomp','Módulo Finances','BuildingFex.Api','IAccountStatusQueryService: estado de cuenta y regla de morosidad.'),
 ('db','db','TiDB Cloud','MySQL compatible','social_spaces, reservations.'),
]
ROWS = [['spa'],['spCtrl','resCtrl','gpCtrl'],['svc'],['dm','repo','acl'],['db','finances']]
EDGES = [
 ('spa','spCtrl',''),('spa','resCtrl','JSON/HTTPS'),('spa','gpCtrl',''),
 ('resCtrl','svc','Crea, edita invitados, cancela'),('gpCtrl','svc','Check-in'),
 ('spCtrl','repo','Lee y escribe espacios'),('resCtrl','repo','Consulta reservas'),('gpCtrl','repo','Valida el pase'),
 ('svc','dm','Reglas del dominio'),('svc','acl','BlocksReservations Async'),('svc','repo','Persiste'),
 ('acl','finances','Consulta estado de cuenta'),
 ('repo','db','EF Core'),
]

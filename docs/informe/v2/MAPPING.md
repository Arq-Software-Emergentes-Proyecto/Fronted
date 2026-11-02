# Figuras v2: legibilidad para impresión y correcciones de contenido

Criterio: cada imagen se inserta a 450 pt de ancho y como máximo 650 pt de alto (A4 vertical).
La columna **pt impreso** es el tamaño de la letra más pequeña de la figura con ese encaje:
`tamaño mínimo de fuente (px) × min(450 / ancho, 650 / alto)`, medido sobre el SVG o el HTML.
Las PNG de PlantUML y Graphviz salen con todos los textos a 14 px base o más (títulos de caja a 15 o 16 px), en Liberation Sans.
Las HTML usan 14 px como mínimo. Todas las PNG miden 2400 px de ancho o menos.

Las figuras que ahora tienen varias partes (106, 112, 113, 118) necesitan un pie por parte en el informe
(por ejemplo, «Figura 112a/b/c»), o pueden ir como subfiguras con un solo pie.

## Tabla de figuras

| Figura | Archivo(s) | Fuente | Píxeles | pt impreso (mín.) | Qué cambió |
|---|---|---|---|---|---|
| 1 Lean UX Canvas | fig001.png | fig001.html | 2400×3475 | 6.7 | Nueva imagen HTML con los mismos 8 bloques, la misma disposición en 3 columnas y los mismos colores (fondo gris pizarra, tarjetas blancas, hipótesis en turquesa). Todo el texto transcrito del canvas anterior. Datos actualizados con las secciones 1.2 y 1.2.2: planes desde S/ 79; tabla de planes Free S/ 0, Essential S/ 79 (10–15 dptos.), Standard S/ 159 (16–40), Scale S/ 289 (41–80) y Portafolio S/ 4/dpto. (mín. S/ 600, desde 150 dptos.); meta de «60 edificios pagantes y S/ 8,310 de MRR en 24 meses» con hitos de 14 (6 meses), 28 (12) y 57 (hacia el mes 23) y 60 a los 24; pregunta clave «entre S/ 79 y S/ 289 … S/ 4 por departamento con mínimo de S/ 600»; punto de equilibrio con el equipo de 28 edificios (escenario B1); landing «Free, S/ 79, S/ 159, S/ 289 y Portafolio»; hipótesis 4 con los precios nuevos. En «Users», el personal (conserjes y mantenimiento) ya no figura como usuario: «no tienen cuenta; la administración los registra en Equipo», como en la sección 1.2. Formato vertical. |
| 16 Impact Mapping | fig016.png | fig016.html | 2340×4098 | 6.7 | Árbol reconstruido desde la imagen de Miro (meta → actor → impacto → entregable → historias), en formato vertical. La meta pasa a «60 edificios pagantes y S/ 8,310 de MRR en 24 meses (hitos: 14 edificios a los 6 meses, 28 a los 12, 57 hacia el mes 23 y 60 a los 24)». Se agregan, en verde, 5 entregables nuevos con US034–US048: «Acceso de la junta en solo lectura» (US035–US037), «Triaje de incidencias con IA y escalamiento automático» (US046–US048), «Asistente de IA con los documentos del edificio y tope de consultas» (US041–US045) y «Cuentas según el tipo de cliente y gestión de varios edificios (Portafolio)» (US034, US038–US040). |
| 17 Diagrama estratégico | fig017.png | fig017.html | 2100×3291 | 8.3 | Se agregan Amazon API Gateway y la API en AWS Lambda; la función de jobs (AWS Lambda) con EventBridge Scheduler y sus jobs monthly-billing (06:15 Lima), incident-escalation (cada hora) y ai-index (cola de indexación); y el paso «Indexación para la IA (fragmentos y embeddings de documentos publicados)». Los avisos se rotulan «Avisos en la app (SignalR fuera de Lambda; consulta periódica en producción)». La base pasa de «tenant_id» a «ownerAdminId (tenant)», que es la columna real. Letra más grande y figura más alta. |
| 67 BC IAM (tablero) | fig067.png | fig067_edit.py (+ tools/fig067_original.png, tools/OpenSans.ttf) | 1628×1440 | ≈5.3 en las notas nuevas más chicas; 6–9 en el resto | Se quitan el agregado «Edificio», «Agregar edificio → Edificio agregado» y la política «Agregar edificios requiere Portafolio» (los edificios son de Profiles: POST /api/v1/portfolio/buildings). «Cambiar edificio activo → Edificio activo cambiado» pasa a la fila 3. Se agregan «Revocar invitación → Invitación revocada» y «Retirar miembro → Miembro retirado». La nota roja «Google OAuth» pasa a «Firebase Authentication». La imagen se rehízo al doble de resolución. Sigue siendo una captura de Miro: sus notas originales más chicas no se pudieron agrandar. |
| 83 Context Map | fig083.png | fig083.dot | 2394×1621 | 6.8 | «Google OAuth (externo)» pasa a «Firebase Authentication (externo)», con la relación «U: API (ID token, Admin SDK) / D: ACL» hacia IAM. Disposición vertical, etiquetas de relación de 15 px (antes ≈4–5 pt impresas) y una nota que aclara que IAM es upstream (OHS + PL) de todos los contextos y que solo se dibuja la relación con Profiles, más una leyenda de siglas. |
| 86 Contenedores (C4) | fig086.png | fig086.puml | 2397×3525 | 6.6 | URL prefirmada «(10 min, máx. 15)». Letras más grandes con el estilo v2. Fuente: diagramas/fig086.puml. |
| 87 Componentes (vista general) | fig087.png | fig087.spec.py → fig087.dot | 2377×2981 | 6.7 | Rejilla vertical de 3 columnas, descripciones más cortas y los módulos numerados en la etiqueta («3. Finances · Payments»…). File Storage: «URL prefirmadas de 10 min (máx. 15)». Hub de avisos: «solo fuera de Lambda; en AWS, consulta periódica». Mismas relaciones que antes. |
| 88 Módulo IAM | fig088.png | fig088.puml | 2398×3417 | 6.4 | Formato vertical sin límite de contenedor; se acortan los textos de las cajas y de las flechas. Mismo contenido. |
| 91 Módulo Incidents | fig091.png | fig091.spec.py → .dot | 2379×3019 | 6.6 | Formato vertical. El hub de avisos queda como «SignalR, solo fuera de Lambda; en AWS, consulta periódica». |
| 93 Communications: documentos | fig093.png | fig093.spec.py → .dot | 2369×2475 | 7.7 | URL prefirmadas PUT/GET de «10 min (máx. 15)». Formato vertical (no estaba en la lista; se rehízo por el dato de vigencia). |
| 95 Módulo Resident Care | fig095.png | fig095.spec.py → .dot | 2378×3578 | 6.5 | Formato vertical. «Polling» pasa a «consulta periódica»; SupportHub, «solo fuera de Lambda». |
| 96 Módulo Profiles | fig096.png | fig096.spec.py → .dot | 2377×2289 | 6.7 | Re-maquetado. Mismo contenido. |
| 98 Clases (global) | fig098.png | fig098.html | 2400×3788 | 6.6 | Vista **resumida**: clases por bounded context (AR, entidad, VO, servicio de dominio) con sus relaciones y multiplicidades, sin atributos, métodos ni enumeraciones. El detalle completo está en los diagramas Domain Layer del Capítulo V (Figs. 106, 109, 112, 115, 118, 121, 124, 127 y 130), como dice la nota de la propia figura. |
| 99 Base de datos (global) | fig099.png | fig099.html | 2400×2730 | 7.2 | **Mapa de tablas**: nombres de tabla por contexto, con las FK (→) y las referencias sin FK (⇢), y el borde de cada tabla según tenga o no FK owner_admin_id → users. Las columnas, claves e índices están en los diagramas de BD del Capítulo V (Figs. 107, 110, 113, 116, 119, 122, 125, 128 y 131). |
| 100 Despliegue local | fig100.png | fig100.spec.py → .dot | 2372×3005 | 7.1 | Formato vertical. Mismo contenido. Fuente previa: scratchpad figx/new/fig100.puml. |
| 101 Despliegue con proxy | fig101.png | fig101.puml | 2391×3773 | 6.3 | URL prefirmada «(10 min, máx. 15)». La API indica que usa los mismos servicios externos de producción (Gemini, Mercado Pago). Fuente previa: scratchpad diag2/A/fig101.puml; no estaba en el repositorio. |
| 102 Despliegue en producción | fig102.png | fig102.spec.py → .dot | 2379×4946 | 7.0 | URL prefirmada «(10 min, máx. 15)». Formato vertical con nodos anidados (Vercel, AWS con ApiFunction y JobsFunction, Google Cloud, TiDB Cloud, Mercado Pago). Fuente previa: scratchpad figx/new/fig102.puml; no estaba en el repositorio. |
| 105 Componentes IAM | fig105.png | fig105.puml | 2391×3328 | 6.7 | Rejilla vertical de 4 columnas, rutas resumidas y solo las etiquetas de flecha que aportan información (JSON/HTTPS, idToken, Claims, tope del plan, JWKS, Admin SDK). |
| 106 Clases IAM | fig106a.png, fig106b.png | fig106a.puml, fig106b.puml | 2055×3360; 2003×4057 | 8.5; 7.0 | Dividida en 2: (a) User, sus enumeraciones y Email; (b) BuildingMember, MemberInvitation, MemberRoles, Email e IUserRepository (User en gris como referencia). Se ocultan las listas largas de parámetros («(...)»). |
| 107 BD IAM | fig107.png | fig107.puml | 2392×1882 | 7.1 | Estilo v2 y columnas. |
| 108 Componentes Profiles | fig108.png | fig108.spec.py → .dot | 2370×3025 | 7.4 | Formato vertical. |
| 109 Clases Profiles | fig109.png | fig109.puml | 2390×2290 | 7.5 | De arriba abajo y estilo v2. |
| 111 Componentes Finances | fig111.png | fig111.spec.py → .dot | 2374×3163 | 6.7 | Nueva caja **«Función de jobs (AWS Lambda + EventBridge Scheduler)»**, job monthly-billing a las 06:15 (Lima), que llama a MonthlyBillingService. MonthlyBillingWorker queda como «Background Job: solo fuera de Lambda (local)». Las listas de 9 a 10 nombres (controladores, repositorios, tablas) se resumen y remiten a las Figs. 112 y 113. |
| 112 Clases Finances | fig112a.png, fig112b.png, fig112c.png | fig112a/b/c.puml | 2396×3837; 2395×2419; 2389×2991 | 7.4; 7.0; 6.7 | Dividida en 3: (a) Receipt, Fee, Payment, sus estados y repositorio, y la nota general; (b) MaintenanceCheckout e Item, DelinquencyPolicy, FinanceClock y DebtLight; (c) FinanceSetting, MonthlyCharge, Period, Money, gastos, KPI y cargos. Las clases de otra parte aparecen en gris. |
| 113 BD Finances | fig113a.png, fig113b.png | fig113a/b.puml | 2395×3632; 1971×3392 | 6.9; 8.4 | Dividida en 2: (a) receipts, fees, payments, maintenance_checkouts; (b) configuración, gastos, KPI y cargos. Se reparte la nota. |
| 114 Componentes Billing | fig114.png | fig114.spec.py → .dot | 2373×4585 | 8.2 | Formato vertical (no estaba en la lista; era de ≈4 pt). |
| 115 Clases Billing | fig115.png | fig115.puml | 2391×3324 | 6.5 | Columnas y firmas abreviadas. |
| 116 BD Billing | fig116.png | fig116.puml | 2395×1714 | 6.6 | Estilo v2. |
| 117 Componentes Social Spaces | fig117.png | fig117.spec.py → .dot | 2376×3275 | 9.7 | Formato vertical. |
| 118 Clases Social Spaces | fig118a.png, fig118b.png | fig118a/b.puml | 2302×3730; 1854×1774 | 7.6; 10.6 | Dividida en 2: (a) agregados, TimeSlot y estados; (b) ReservationPolicy y repositorios. |
| 119 BD Social Spaces | fig119.png | fig119.puml | 2396×2560 | 8.2 | Estilo v2 (no estaba en la lista; era de ≈5 pt). |
| 120 Componentes Incidents | fig120.png | fig120.spec.py → .dot | 2378×2544 | 7.6 | Formato vertical. |
| 121 Clases Incidents | fig121.png | fig121.puml | 2394×2466 | 6.6 | Columnas y firmas abreviadas. |
| 122 BD Incidents | fig122.png | fig122.puml | 2397×2220 | 6.9 | Estilo v2 (era de ≈5 pt). |
| 123 Componentes Communications | fig123.png | fig123.spec.py → .dot | 2378×2723 | 7.0 | Formato vertical. El adaptador de almacenamiento indica «URL firmadas (10 min, máx. 15)». Se quita el separador invisible. |
| 124 Clases Communications | fig124.png | fig124.puml | 2393×2920 | 7.1 | Columnas y firmas abreviadas. |
| 126 Componentes Team | fig126.png | fig126.spec.py → .dot | 2271×3588 | 10.6 | Formato vertical. |
| 127 Clases Team | fig127.png | fig127.puml | 2389×3008 | 6.7 | De arriba abajo y firmas abreviadas. |
| 129 Componentes Resident Care | fig129.png | fig129.spec.py → .dot | 2368×3024 | 7.0 | Rejilla vertical de 4 columnas. «Polling» pasa a «consulta periódica». |
| 130 Clases Resident Care | fig130.png | fig130.puml | 2399×3103 | 6.8 | Columnas y firmas abreviadas. |
| 131 BD Resident Care | fig131.png | fig131.puml | 2387×2810 | 8.3 | Estilo v2 (era de ≈6 pt). |

## Qué no se regeneró y por qué

- **Vigencia de la URL prefirmada**: «10 min (máx. 15)» queda en las Figs. 86, 87, 93, 101 y 102 (y en las Figs. 123 y 111, en sus textos de almacenamiento). Las fuentes de las Figs. 101 y 102 no estaban en el repositorio: se tomaron las últimas versiones del scratchpad (diag2/A/fig101.puml y figx/new/fig102.puml). Conviene compararlas con la imagen del informe antes de reemplazarlas.
- **Cap. IV 89, 90, 92, 94 y 97**: no se pidieron y no se rehicieron (≈4.7–7 pt impresos en el informe actual).
- **Cap. V 110, 125 y 128**: ya estaban en ≈7–9 pt y no se tocaron.
- **Fig. 67**: es una captura de Miro. Se corrigió el contenido, pero sus notas originales más pequeñas quedan en ≈5–6 pt.

## Cómo volver a generar

- PlantUML (`figNNN.puml` + `common_c4.iuml` / `common_class.iuml`): `PLANTUML_JAR=… python3 tools/render_puml.py figNNN`. Mide la letra en el SVG y exporta la PNG con un dpi tal que el ancho quede en 2400 px o menos (equivale a `java -DPLANTUML_LIMIT_SIZE=16384 -jar plantuml.jar -tpng -Sdpi=N`). Los archivos fuente no fijan el dpi.
- Graphviz con estilo C4 (`figNNN.spec.py`): `python3 tools/c4dot.py figNNN.spec.py`, que escribe `figNNN.dot` y `figNNN.png`.
- Fig. 83: `dot -Tpng -Gdpi=174 fig083.dot -o fig083.png`.
- HTML (`fig001`, `fig016`, `fig017`, `fig098`, `fig099`): `node tools/htmlshot.mjs figNNN.html` (Playwright + Chromium; captura `#c`).
- Fig. 67: `python3 fig067_edit.py`.

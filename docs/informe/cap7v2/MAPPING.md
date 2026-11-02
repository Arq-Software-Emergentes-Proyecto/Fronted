# cap7v2: screenshots for chapter VII and the annexes

How they were captured: production build (`vite build`) served locally. Playwright and Chromium opened it at `https://fronted-seven-opal.vercel.app`, with every request answered from the local build, so the generated links show the production domain. Only ev173 was captured from the local URL, because the localhost link is the evidence there. Settings: demo account `test` / `123456`, locale es-PE, America/Lima time zone, deviceScaleFactor 2, so every pixel size below is twice the CSS size. The browser clock was fixed at Mon 2 Nov 2026 18:40 (Lima) so that the demo reservation (Piscina, 18:00–20:00) is under way and its guest pass is valid. Crops leave out the sidebar except in the annex images. Red marks are 3.5 CSS px (7 px in the image) with rounded corners.

## 7.2.1.5 Execution Evidence (Figuras 155–166)

| File | Figure | Size (px) | Notes |
|---|---|---|---|
| ex155.png | 155 Inicio de sesión | 2560×1440 | Full login at 1280×720, tabs «Junta o administración» / «Residente». |
| ex156.png | 156 Panel del administrador | 2784×2104 | 1600 px viewport, main column: Para hoy (labels no longer truncated), KPIs, Ingresos/Egresos chart and Reservas de hoy (Piscina 18:00–20:00, «1 departamento · 1 con invitados»). |
| ex157.png | 157 Residentes y espacios | 2464×1211 | Header KPIs (4/5000 residents, Portafolio plan), filters and roster with statuses. |
| ex158.png | 158 Documentos | 2464×1039 | Folders General and Contexto IA, upload area. |
| ex159.png | 159 Cobros | 2464×1229 | KPIs, status per resident and the 6-month history. |
| ex160.png | 160 Control de acceso | 2464×1244 | Day agenda with the reservation's guests, and pass `demo-invite-302` validated («Invitación válida»). |
| ex161.png | 161 Incidencias | 2464×1147 | List by status with the provider assigned. |
| ex162.png | 162 Soporte | 2464×1200 | Inbox and an open conversation. The counter reads «Consultas IA este mes 1 de 10,000», which is the Portafolio plan cap (the old capture showed 400). |
| ex163.png | 163 Inicio del residente | 2464×1878 | Amount to pay, next reservation (Piscina, today 18:00–20:00) and announcements. |
| ex164.png | 164 Mis pagos | 2464×1246 | Pending fee S/ 205.00, «Pagar con Mercado Pago» button, last 6 months. |
| ex165.png | 165 Áreas comunes | 2464×1114 | Cards showing capacity («Hasta 20/40/12 personas»). |
| ex166.png | 166 Mis invitados | 2464×1677 | Guest list and QR pass. The link is `https://fronted-seven-opal.vercel.app/invite/demo-invite-302`. |

## 7.3.3 Heuristic evaluation evidence (currently Figuras 173–182)

| File | Figure / problem | Size (px) | What the red box marks |
|---|---|---|---|
| ev173.png | 173 / P#1 link to localhost | 1150×1280 | The «Enlace de invitación» field showing `http://localhost:4183/invite/demo-invite-302`. Captured from the local preview on purpose. |
| ev174.png | 174 / P#2 Contexto IA without guidance | 2432×985 | The «Contexto IA» folder header, which has only a one-line note and no guide. |
| ev175.png | 175 / P#3 unlabeled icons and red delete | 2348×724 | The action icon group (link, edit, deactivate, delete) in every row. |
| ev176.png | 176 / P#4 «Morosidad crítica» card | 1362×442 | The Morosidad crítica card (S/ 779.00, «Sin presupuesto»). |
| ev177.png | 177 / P#4 «Por cobrar» and «Deuda vencida» | 2464×530 | The two KPI pills: S/ 565.00 Por cobrar and S/ 310.00 Deuda vencida. |
| ev178.png | 178 / P#5 history shown by color only | 2348×670 | The «Últimos 6 meses» column (header and dots). The color legend is included. |
| ev179.png | 179 / P#6 AI query counter | 716×984 | The «Consultas IA este mes 1 de 10,000» card above the inbox. |
| ev180.png | 180 / P#7 «Gestionar» and the three-dot menu | 2348×690 | The actions column of every row. |
| ev181.png | 181 / P#8 repeated shortcuts | 2464×1246 | Three boxes: the header buttons, the «Para hoy» row and «Pagar cuota» on the Por pagar card. |
| ev182.png | 182 / P#9 generic icons | 1832×760 | The placeholder media area of each space card. |

## Annexes «Mock-up de la aplicación web» (currently Figuras 175–183)

| File | Figure | Size (px) | Notes |
|---|---|---|---|
| ax175.png | 175 Login | 2880×1620 | Full screen at 1440×810. |
| ax176.png | 176 Inicio del residente | 2880×2328 | Whole page with the sidebar. |
| ax177.png | 177 Panel del administrador | 3200×2528 | 1600 px viewport. The «Para hoy» labels and the chart show in full. |
| ax178.png | 178 Cobros y Mis pagos | 2960×3746 | Two labeled screens stacked: Cobros (administrator) and Mis pagos (resident). |
| ax179.png | 179 Áreas comunes y Control de acceso | 2960×2736 | Two labeled screens stacked: Áreas comunes (resident) and Control de acceso (administrator). |
| ax180.png | 180 Incidencias | 2880×1238 | Administrator view. |
| ax181.png | 181 Comunicados y Documentos | 2960×2562 | Two labeled screens stacked, both administrator views. |
| ax182.png | 182 Residentes y espacios | 2880×1302 | Residents tab. |
| ax183.png | 183 Soporte y Ayuda | 2960×3298 | Two labeled screens stacked: Soporte (administrator, open conversation) and Ayuda (resident). |

## Notes for the report text

- The demo account is on the Portafolio plan (two buildings, cap of 5,000 residents), so the AI cap shown is 10,000, not Standard's 2,000.
- In Cobros the demo now shows «Deuda vencida S/ 310.00». The text of Problem #4 quotes S/ 420.00, and the Morosidad crítica card still shows S/ 779.00.
- The Incidencias KPI reads «0 Resueltas» while the list shows one resolved incident (from October).

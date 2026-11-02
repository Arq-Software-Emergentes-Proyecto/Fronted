import json, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter
S='/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/wf/shots/'
O='/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/wf/out/'
import os; os.makedirs(O,exist_ok=True)
F='/usr/share/fonts/opentype/inter/'
def font(w,sz): return ImageFont.truetype(F+{'r':'Inter-Regular.otf','m':'Inter-Medium.otf','b':'Inter-SemiBold.otf','x':'Inter-Bold.otf'}[w],sz)
NAVY=(30,58,138); INK=(15,23,42); MUTED=(71,85,105); RED=(220,38,38); LINE=(100,116,139); BG=(255,255,255)
meta={}
for m in ('desktop','mobile'):
    try: meta.update(json.load(open(S+f'meta_{m}.json')))
    except FileNotFoundError: pass

def wrap(d,text,f,maxw):
    words=text.split(); lines=[]; cur=''
    for w in words:
        t=(cur+' '+w).strip()
        if d.textlength(t,font=f)<=maxw: cur=t
        else: lines.append(cur); cur=w
    if cur: lines.append(cur)
    return lines

def thumb(key,w,h=None,hl=True,radius=18):
    im=Image.open(S+key+'.png').convert('RGB')
    sx=im.width/ (1440 if key.startswith('desktop') else 390)
    b=meta.get(key,{}).get('box') if hl else None
    if b:
        d=ImageDraw.Draw(im); pad=8*sx
        d.rounded_rectangle([b['x']*sx-pad,b['y']*sx-pad,(b['x']+b['width'])*sx+pad,(b['y']+b['height'])*sx+pad],radius=int(12*sx),outline=RED,width=int(5*sx))
    if h is None: h=int(im.height*w/im.width)
    im=im.resize((w,h),Image.LANCZOS)
    mask=Image.new('L',(w,h),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,w-1,h-1],radius=radius,fill=255)
    return im,mask

def paste_card(canvas,im,mask,x,y,radius=18):
    sh=Image.new('RGBA',(im.width+40,im.height+40),(0,0,0,0))
    ImageDraw.Draw(sh).rounded_rectangle([20,24,20+im.width,24+im.height],radius=radius,fill=(15,23,42,60))
    sh=sh.filter(ImageFilter.GaussianBlur(10))
    canvas.paste(sh,(x-20,y-20),sh)
    canvas.paste(im,(x,y),mask)
    ImageDraw.Draw(canvas).rounded_rectangle([x,y,x+im.width-1,y+im.height-1],radius=radius,outline=(203,213,225),width=2)

def arrow(d,pts,color=LINE,w=5,head=18):
    d.line(pts,fill=color,width=w,joint='curve')
    (x1,y1),(x2,y2)=pts[-2],pts[-1]
    a=math.atan2(y2-y1,x2-x1)
    p1=(x2-head*math.cos(a-0.45),y2-head*math.sin(a-0.45)); p2=(x2-head*math.cos(a+0.45),y2-head*math.sin(a+0.45))
    d.polygon([(x2,y2),p1,p2],fill=color)

def badge(d,x,y,n,r=26):
    d.ellipse([x-r,y-r,x+r,y+r],fill=NAVY); f=font('x',28)
    t=str(n); d.text((x-d.textlength(t,font=f)/2,y-17),t,font=f,fill=(255,255,255))

def flow(name,title,subtitle,steps,mode='desktop',per_row=3):
    if mode=='desktop':
        tw,th=720,450; gapx=120; gapy=120; cap_h=110; W=60*2+per_row*tw+(per_row-1)*gapx
    else:
        th=760; tw=int(th*390/844); gapx=110; gapy=80; cap_h=150; per_row=len(steps); W=60*2+per_row*tw+(per_row-1)*gapx
    rows=math.ceil(len(steps)/per_row)
    top=170
    H=top+rows*(th+cap_h)+(rows-1)*gapy+60
    c=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(c)
    d.text((60,46),title,font=font('x',48),fill=INK)
    d.text((60,110),subtitle,font=font('r',30),fill=MUTED)
    pos=[]
    for i,(key,cap) in enumerate(steps):
        r,col=divmod(i,per_row)
        x=60+col*(tw+gapx); y=top+r*(th+cap_h+gapy)
        im,mask=thumb(f'{mode}_{key}',tw,th, radius=18 if mode=='desktop' else 34)
        paste_card(c,im,mask,x,y,radius=18 if mode=='desktop' else 34)
        badge(d,x+4,y+4,i+1)
        f=font('m',27 if mode=='desktop' else 25)
        for k,line in enumerate(wrap(d,cap,f,tw-10)[:4]):
            d.text((x+4,y+th+22+k*35),line,font=f,fill=INK)
        pos.append((x,y))
    for i in range(len(steps)-1):
        (x1,y1),(x2,y2)=pos[i],pos[i+1]
        if y1==y2:
            cy=y1+th//2; arrow(d,[(x1+tw+18,cy),(x2-18,cy)])
        else:
            sx=x1+tw//2; sy=y1+th+cap_h-6; my=sy+gapy//2+4; ex=x2+tw//2
            arrow(d,[(sx,sy),(sx,my),(ex,my),(ex,y2-14)])
    c.save(O+name+'.png'); 
    return c.size

def overview():
    tw,th=300,188; gapx=46; lane_h=th+120; left=60; lx=left+380
    lanes=[('Residente','res',['dashboard','finance','services','generation','incidents','support'],['Inicio','Mis pagos','Áreas comunes','Mis invitados','Mis incidencias','Ayuda']),
           ('Administrador','adm',['dashboard','advanced-management','finance','incidents','information','access','buildings'],['Panel','Residentes y espacios','Cobros','Incidencias','Comunicados','Junta y accesos','Mis edificios']),
           ('Junta directiva (solo lectura)','brd',['board','access','buildings'],['Resumen','Equipo de gestión','Mis edificios'])]
    W=lx+7*tw+6*gapx+60; top=170; H=top+3*lane_h+40
    c=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(c)
    d.text((60,46),'Wireflow general de la aplicación web',font=font('x',48),fill=INK)
    d.text((60,110),'Desde el inicio de sesión, cada rol entra a su propio panel y navega por sus módulos desde el menú lateral.',font=font('r',30),fill=MUTED)
    # login
    lw,lh=320,200; ly=top+lane_h+ (lane_h-lh)//2-30
    im,mask=thumb('desktop_ov_login',lw,lh,hl=False); paste_card(c,im,mask,left,ly)
    d.text((left,ly-44),'Inicio de sesión',font=font('b',30),fill=INK)
    for li,(label,pref,keys,names) in enumerate(lanes):
        y=top+li*lane_h+40
        d.text((lx,y-40),label,font=font('x',32),fill=NAVY)
        busy=y-8
        for k,(key,nm) in enumerate(zip(keys,names)):
            x=lx+k*(tw+gapx)
            im,mask=thumb(f'desktop_ov_{pref}_{key}',tw,th,hl=False,radius=12); paste_card(c,im,mask,x,y+28,radius=12)
            d.text((x,y+28+th+10),nm,font=font('m',24),fill=INK)
        # arrow from login to first page
        arrow(d,[(left+lw+16,ly+lh//2),(lx-60,ly+lh//2),(lx-60,y+28+th//2),(lx-14,y+28+th//2)],w=5)
        # bus from first page to others
        if len(keys)>1:
            x0=lx+tw//2; xn=lx+(len(keys)-1)*(tw+gapx)+tw//2; by=y+16
            d.line([(x0,y+28),(x0,by),(xn,by)],fill=(148,163,184),width=4)
            for k in range(1,len(keys)):
                xk=lx+k*(tw+gapx)+tw//2; arrow(d,[(xk,by),(xk,y+24)],color=(148,163,184),w=4,head=14)
    c.save(O+'w0_overview.png'); return c.size

if __name__=='__main__':
    print(overview())
    D=[('w1_1','Visita la landing page y elige «¿Eres residente? Ingresa aquí».'),('w1_2','Inicia sesión como residente con su correo o con Google.'),('w1_3','En Inicio elige «Pagar cuota».'),('w1_4','En Mis pagos revisa el total y paga con Mercado Pago.'),('w1_5','El pago se confirma y el recibo queda en el historial.')]
    print(flow('w1_desktop','Wireflow 1: Pagar una cuota','Residente · aplicación web',D))
    D2=[('w2_1','En Inicio elige «Reservar espacio».'),('w2_2','En Áreas comunes elige el espacio y pulsa «Reservar».'),('w2_3','Elige el día y el horario y confirma la reserva.'),('w2_4','Con la reserva confirmada, pulsa «Agregar invitados».'),('w2_5','En Mis invitados escribe el nombre del invitado y lo agrega.'),('w2_6','Comparte el enlace o el QR del pase con sus invitados.')]
    print(flow('w2_desktop','Wireflow 2: Reservar un área común con invitado','Residente · aplicación web',D2))
    D3=[('w3_1','En Inicio elige «Reportar incidencia».'),('w3_2','Se abre el formulario de nueva incidencia.'),('w3_3','Describe el problema y envía la incidencia.'),('w3_4','La incidencia queda abierta; la IA sugiere categoría y prioridad y la administración la atiende.')]
    print(flow('w3_desktop','Wireflow 3: Reportar una incidencia','Residente · aplicación web',D3,per_row=2))
    D4=[('w4_1','En Inicio elige «Hablar con el asistente».'),('w4_2','En Ayuda inicia un chat con el asistente.'),('w4_3','Escribe su consulta.'),('w4_4','El asistente responde con el reglamento y cita la fuente; el residente confirma «Sí, gracias».'),('w4_5','La conversación se cierra y queda en su historial.')]
    print(flow('w4_desktop','Wireflow 4: Consultar al asistente','Residente · aplicación web',D4))
    D5=[('w5_1','El titular de la cuenta invita a la junta en «Junta y accesos».'),('w5_2','Se genera un enlace personal de un solo uso, válido 7 días.'),('w5_3','El miembro de la junta abre el enlace y acepta con su correo.'),('w5_4','Entra al resumen de la junta directiva, en solo lectura.')]
    print(flow('w5_desktop','Wireflow 5: Invitar a la junta directiva','Administrador y junta directiva · aplicación web',D5,per_row=2))
    D6=[('w6_1','El administrador ve el edificio activo en el menú lateral.'),('w6_2','En «Mis edificios» elige otro edificio de la cuenta.'),('w6_3','El panel cambia a los datos de ese edificio.'),('w6_4','Con el plan Portafolio agrega un edificio nuevo.'),('w6_5','El edificio aparece como un condominio aparte.')]
    print(flow('w6_desktop','Wireflow 6: Cambiar de edificio (plan Portafolio)','Administrador · aplicación web',D6))
    M1=[('w1_1','Abre la landing y elige «¿Eres residente? Ingresa aquí».'),('w1_2','Inicia sesión como residente.'),('w1_3','En Inicio toca «Pagar cuota».'),('w1_4','Paga con Mercado Pago.'),('w1_5','El pago queda confirmado.')]
    print(flow('w1_mobile','Wireflow 1: Pagar una cuota','Residente · celular',M1,mode='mobile'))
    M2=[('w2_1','Toca «Reservar espacio».'),('w2_2','Elige el espacio y toca «Reservar».'),('w2_3','Elige día y horario y confirma.'),('w2_4','Toca «Agregar invitados».'),('w2_5','Agrega el nombre del invitado.'),('w2_6','Comparte el enlace o el QR.')]
    print(flow('w2_mobile','Wireflow 2: Reservar un área común con invitado','Residente · celular',M2,mode='mobile'))
    M3=[('w3_1','Toca «Reportar incidencia».'),('w3_2','Se abre el formulario.'),('w3_3','Describe el problema y envía.'),('w3_4','La incidencia queda abierta.')]
    print(flow('w3_mobile','Wireflow 3: Reportar una incidencia','Residente · celular',M3,mode='mobile'))
    M4=[('w4_1','Toca «Hablar con el asistente».'),('w4_2','Inicia el chat.'),('w4_3','Escribe su consulta.'),('w4_4','Lee la respuesta con su fuente y confirma.'),('w4_5','La conversación se cierra.')]
    print(flow('w4_mobile','Wireflow 4: Consultar al asistente','Residente · celular',M4,mode='mobile'))

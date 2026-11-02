"""Figura 67 (v2) - Bounded Context IAM (tablero EventStorming).
Parte de la captura original del tablero (tools/fig067_original.png, 814x480) y aplica las mismas técnicas que
diagramas/edit_iam.py, con estos cambios respecto de la versión anterior:
 - se elimina el agregado «Edificio», «Agregar edificio → Edificio agregado» y la política «Agregar edificios
   requiere Portafolio» (los edificios son de Profiles: POST /api/v1/portfolio/buildings);
 - «Cambiar edificio activo → Edificio activo cambiado» (edificio activo del usuario, X-Building-Id) pasa a la
   fila 3, junto a «Desactivar cuenta»;
 - se agregan «Revocar invitación → Invitación revocada» y «Retirar miembro → Miembro retirado» (MembersController);
 - «Google OAuth» (sistema externo) pasa a «Firebase Authentication» (el ingreso con Google va por Firebase).
Salida: fig067.png al doble de resolución (1628 px de ancho) para que el texto nuevo salga nítido."""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import os
S=os.path.dirname(os.path.abspath(__file__))+'/tools/'
FONT=S+'OpenSans.ttf'
K=2   # factor de escala
def font(sz):
    f=ImageFont.truetype(FONT,int(round(sz*K)))
    try: f.set_variation_by_axes([400,100])
    except Exception: pass
    return f
def B(box): return tuple(int(v*K) for v in box)
def fill_box(im,box,col):
    x0,y0,x1,y1=B(box); ImageDraw.Draw(im).rectangle([x0+3*K,y0+3*K,x1-4*K,y1-4*K],fill=col)
def text(im,box,lines,sz,pitch=None,col=(40,38,38)):
    d=ImageDraw.Draw(im); f=font(sz); pitch=(pitch or sz*1.32)*K
    x0,y0,x1,y1=B(box); cx=(x0+x1)/2; cy=(y0+y1)/2; n=len(lines)
    for i,l in enumerate(lines):
        d.text((cx,cy+(i-(n-1)/2)*pitch),l,font=f,fill=col,anchor='mm')
        if d.textlength(l,font=f)>(x1-x0)-8*K: print('AVISO texto ancho:',l)
def sticky_from(im,src_patch,box,lines,sz,pitch=None):
    """pega una nota del color de src_patch (recortada del original) y escribe el texto"""
    x0,y0,x1,y1=box
    p=src_patch.resize((int((x1-x0)*K),int((y1-y0)*K)))
    im.paste(p,(int(x0*K),int(y0*K)))
    col=tuple(int(v) for v in np.median(np.array(p)[10*K:-10*K,6*K:12*K].reshape(-1,3),axis=0))
    fill_box(im,box,col); text(im,box,lines,sz,pitch)
def tile(im,patch,area):
    x0,y0,x1,y1=B(area); pw,ph=patch.size
    for y in range(y0,y1,ph):
        for x in range(x0,x1,pw):
            im.paste(patch.crop((0,0,min(pw,x1-x),min(ph,y1-y))),(x,y))

src=Image.open(S+'fig067_original.png').convert('RGB'); W,H=src.size
big=src.resize((W*K,H*K),Image.LANCZOS)
grid=big.crop(B((500,378,814,480)))
NEWH=H+240
im=Image.new('RGB',(W*K,NEWH*K)); im.paste(big,(0,0)); tile(im,grid,(0,H,W,NEWH))

# colores de notas tomados del original
blue  =src.crop((188,146,259,219))   # comando (Registrar cuenta)
orange=src.crop((304,155,374,229))   # evento (Cuenta registrada)
yellow=src.crop((29,142,122,239))    # agregado (Cuenta)
purple=src.crop((651,156,721,228))   # política (Expirar sesión…)
red   =src.crop((420,390,490,463))   # sistema externo (Google OAuth)

# fila 3: sistema externo renombrado y «Cambiar edificio activo»
sticky_from(im,red,(420,390,490,463),['Firebase','Authenti-','cation'],10.5)
sticky_from(im,blue,(536,390,606,463),['Cambiar','edificio','activo'],10)
sticky_from(im,orange,(651,390,721,463),['Edificio','activo','cambiado'],10)

# fila 4: Membresía (alta)
oy=H+22
sticky_from(im,yellow,(29,oy+4,122,oy+101),['Membresía'],16)
for (x0,x1),lab,p in zip([(188,259),(304,374),(420,490),(536,606)],
        [['Invitar','miembro'],['Invitación','enviada'],['Aceptar','invitación'],['Miembro','agregado']],
        [blue,orange,blue,orange]):
    sticky_from(im,p,(x0,oy+12,x1,oy+85),lab,11)
sticky_from(im,purple,(651,oy+17,721,oy+90),['La junta','solo lee:','se rechazan','sus escrituras'],9.5)

# fila 5: Membresía (bajas), comandos del canvas de IAM
oy=H+140
for (x0,x1),lab,p in zip([(188,259),(304,374),(420,490),(536,606)],
        [['Revocar','invitación'],['Invitación','revocada'],['Retirar','miembro'],['Miembro','retirado']],
        [blue,orange,blue,orange]):
    sticky_from(im,p,(x0,oy+12,x1,oy+85),lab,11)

im.save(os.path.join(os.path.dirname(os.path.abspath(__file__)),'fig067.png')); print('fig067',im.size)

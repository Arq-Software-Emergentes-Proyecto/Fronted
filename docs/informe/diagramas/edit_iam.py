import sys
sys.path.insert(0,'/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/jb')
from PIL import Image, ImageDraw, ImageFont
import numpy as np
J='/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/jb/'
FONT='/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/fonts/OpenSans.ttf'
_fc={}
def font(sz,w=400):
    k=(sz,w)
    if k not in _fc:
        f=ImageFont.truetype(FONT,sz)
        try: f.set_variation_by_axes([w,100])
        except Exception: pass
        _fc[k]=f
    return _fc[k]
def fill_box(im,box,col):
    d=ImageDraw.Draw(im); x0,y0,x1,y1=box; d.rectangle([x0+3,y0+3,x1-4,y1-4],fill=col)
def text(im,box,lines,sz,pitch=None,col=(40,38,38)):
    d=ImageDraw.Draw(im); f=font(sz); pitch=pitch or sz*1.32
    x0,y0,x1,y1=box; cx=(x0+x1)/2; cy=(y0+y1)/2; n=len(lines)
    for i,l in enumerate(lines):
        d.text((cx,cy+(i-(n-1)/2)*pitch),l,font=f,fill=col,anchor='mm')
        if d.textlength(l,font=f)>(x1-x0)-8: print('WARN wide',l)
def sticky(im,box,lines,sz,pitch=None):
    a=np.array(im); x0,y0,x1,y1=box
    col=tuple(int(v) for v in np.median(a[y0+8:y1-8,x0+6:x0+12].reshape(-1,3),axis=0))
    fill_box(im,box,col); text(im,box,lines,sz,pitch)
def tile(im,patch,area):
    x0,y0,x1,y1=area; pw,ph=patch.size
    for y in range(y0,y1,ph):
        for x in range(x0,x1,pw):
            im.paste(patch.crop((0,0,min(pw,x1-x),min(ph,y1-y))),(x,y))

# ---------------- Figura 59: Step 7 & 8 (IAM) ----------------
src=Image.open(J+'fig059.png').convert('RGB'); W,H=src.size
grid=src.crop((700,2,1268,142))
NEWH=H+225
im=Image.new('RGB',(W,NEWH)); im.paste(src,(0,0)); tile(im,grid,(0,H,W,NEWH))
band=src.crop((0,240,1155,346))              # fila de comandos/eventos con flechas (10 notas)
oy=H-10                                       # la fila nueva empieza justo debajo
im.paste(band,(0,oy))
dy=oy-240
row=[(9,257,80,330),(121,257,191,331),(250,257,320,330),(361,257,431,330),(490,257,560,330),
     (601,257,672,330),(730,257,801,330),(842,257,912,330),(970,257,1041,330),(1082,257,1152,330)]
labels=[['Invitar','miembro'],['Invitación','enviada'],['Aceptar','invitación'],['Miembro','agregado'],
        ['Revocar','invitación'],['Invitación','revocada'],['Cambiar','edificio','activo'],['Edificio','activo','cambiado'],
        ['Agregar','edificio'],['Edificio','agregado']]
for (x0,y0,x1,y1),lab in zip(row,labels):
    sticky(im,(x0,y0+dy,x1,y1+dy),lab,11 if len(lab)<3 else 10)
# notas debajo: read models (verde) y policy (morado)
green=src.crop((121,22,191,95)); purple=src.crop((250,144,320,216))
gy=oy+118
for x,lab in [(361,['Resumen','de la junta','(solo','lectura)']),(1082,['Mis','edificios'])]:
    im.paste(green,(x,gy)); sticky(im,(x,gy,x+70,gy+73),lab,10 if len(lab)<3 else 9)
im.paste(purple,(490,gy)); sticky(im,(490,gy,560,gy+72),['Policy: Si','la junta','intenta','escribir,','rechazar','(403)'],7.5,pitch=10)
im.paste(purple,(970,gy)); sticky(im,(970,gy,1040,gy+72),['Policy: Solo','con plan','Portafolio','se agregan','edificios'],7.5,pitch=10)
im.save(J+'fig059_new.png'); print('fig059',im.size)

# ---------------- Figura 67: Bounded Context IAM ----------------
src=Image.open(J+'fig067.png').convert('RGB'); W,H=src.size
grid=src.crop((500,378,814,480))
NEWH=H+270
im=Image.new('RGB',(W,NEWH)); im.paste(src,(0,0)); tile(im,grid,(0,H,W,NEWH))
band=src.crop((0,138,W,242))                 # fila «Cuenta»: agregado + 4 notas + policy
for k,(agg,labs,pol) in enumerate([
    (['Membresía'],[['Invitar','miembro'],['Invitación','enviada'],['Aceptar','invitación'],['Miembro','agregado']],
     ['La junta','solo lee:','se rechazan','sus escrituras']),
    (['Edificio'],[['Cambiar','edificio','activo'],['Edificio','activo','cambiado'],['Agregar','edificio'],['Edificio','agregado']],
     ['Agregar','edificios','requiere','Portafolio'])]):
    oy=H+22+k*118; im.paste(band,(0,oy)); dy=oy-138
    sticky(im,(29,142+dy,122,239+dy),agg,21 if len(agg[0])<9 else 18)
    for (x0,y0,x1,y1),lab in zip([(188,146,259,219),(304,155,374,229),(420,155,490,229),(536,155,606,229)],labs):
        sticky(im,(x0,y0+dy,x1,y1+dy),lab,11 if len(lab)<3 else 10)
    sticky(im,(651,156+dy,721,228+dy),pol,9.5)
im.save(J+'fig067_new.png'); print('fig067',im.size)

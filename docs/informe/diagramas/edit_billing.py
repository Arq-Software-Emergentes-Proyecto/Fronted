import sys
sys.argv=['x']
exec(open('/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/jb/edit_iam.py').read().split('# ---------------- Figura 59')[0])
src=Image.open('/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/figcheck/orig_fig075.png').convert('RGB')
im=src.copy()
blue=src.crop((159,139,251,236)); orange=src.crop((269,139,361,236))
purple=Image.open(J+'fig067.png').convert('RGB').crop((651,156,721,228)).resize((92,97),Image.LANCZOS)
y=258
im.paste(blue,(159,y)); sticky(im,(159,y,251,y+97),['Contratar','Portafolio'],13)
im.paste(orange,(269,y)); sticky(im,(269,y,361,y+97),['Suscripción','de cuenta','activada'],12.5)
im.paste(purple,(371,y)); sticky(im,(371,y,463,y+97),['Portafolio:','S/ 4 por dpto.,','mín. S/ 600;','cubre todos','los edificios'],10,pitch=13)
im.save(J+'fig075_new.png'); print(im.size)

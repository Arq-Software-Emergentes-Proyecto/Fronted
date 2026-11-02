#!/usr/bin/env python3
"""Render puml(s) from v2 dir: SVG to measure, PNG at dpi so width<=2400. Report printed pt."""
import sys, subprocess, re, os, html
from PIL import Image
J=os.environ.get('PLANTUML_JAR','/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/diag2/plantuml.jar')
import os; V=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP='/tmp/v2svg'
os.makedirs(TMP,exist_ok=True)
def run(args):
    r=subprocess.run(['java','-DPLANTUML_LIMIT_SIZE=16384','-jar',J]+args,capture_output=True,text=True)
    err='\n'.join(l for l in (r.stdout+r.stderr).splitlines() if 'JAVA_TOOL' not in l)
    if err.strip(): print(err)
def measure(svg):
    s=open(svg,encoding='utf-8').read()
    m=re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"',s); w,h=float(m.group(1)),float(m.group(2))
    sizes=[]
    for fm in re.finditer(r'<text([^>]*)>([^<]*)</text>',s):
        attrs,txt=fm.group(1),html.unescape(fm.group(2))
        if not txt.strip().replace('\xa0',''): continue
        if 'transparent' in attrs: continue
        fs=re.search(r'font-size="([\d.]+)"',attrs)
        if fs and float(fs.group(1))>=4: sizes.append((float(fs.group(1)),txt))
    return w,h,sizes
for name in sys.argv[1:]:
    p=os.path.join(V,name+'.puml')
    # svg at dpi-free: strip dpi/scale lines into temp
    src=open(p,encoding='utf-8').read()
    tsrc=re.sub(r'(?m)^\s*(skinparam dpi .*|scale .*)$','',src)
    tp=os.path.join(TMP,name+'.puml'); open(tp,'w',encoding='utf-8').write(tsrc)
    for inc in os.listdir(V):
        if inc.endswith('.iuml'):
            open(os.path.join(TMP,inc),'w').write(re.sub(r'(?m)^\s*skinparam dpi .*$','',open(os.path.join(V,inc)).read()))
    run(['-tsvg','-o',TMP,tp])
    w,h,sizes=measure(os.path.join(TMP,name+'.svg'))
    sc=min(450/w,650/h)
    mn=min(s for s,_ in sizes)
    small=sorted(set(round(s,1) for s,_ in sizes))
    dpi=int(min(300,96*2400/w))
    run(['-tpng','-Sdpi=%d'%dpi,'-o',V,p])
    im=Image.open(os.path.join(V,name+'.png'))
    ex=[t for s,t in sizes if s==mn][:3]
    print(f'{name}: base {w:.0f}x{h:.0f} ratio {h/w:.2f} | sizes {small} | min {mn} -> {mn*sc:.2f} pt (body14 {14*sc:.2f}) | png {im.size} dpi {dpi} | {"WIDTH" if 450/w<650/h else "HEIGHT"}-limited | ex {ex}')

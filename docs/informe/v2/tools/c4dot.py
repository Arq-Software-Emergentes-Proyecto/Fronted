#!/usr/bin/env python3
"""Generador de diagramas estilo C4 en Graphviz (dot) con rejilla controlada.
Uso: python3 c4dot.py figNNN.spec.py   -> escribe figNNN.dot y figNNN.png (ancho <= 2400 px)
El spec es un archivo Python que define:
  NODES = [(id, kind, nombre, tecnología, descripción), ...]
     kind: person | container | component | ext | extcomp | db | job
  ROWS  = [[id, id, ...], ...]          filas de arriba a abajo (orden izquierda->derecha)
  EDGES = [(origen, destino, etiqueta), ...]  (etiqueta '' = sin texto)
  CLUSTERS = {"Título": [ids...]}       (opcional, límite punteado)
  WRAP = 22                              (opcional, caracteres por línea en la descripción)
  NOTE = "texto"                         (opcional, nota al pie)
"""
import sys, textwrap, subprocess, html, re, os
spec = {}
exec(open(sys.argv[1], encoding='utf-8').read(), spec)
NODES, ROWS, EDGES = spec['NODES'], spec['ROWS'], spec['EDGES']
CLUSTERS = spec.get('CLUSTERS', {})
WRAP = spec.get('WRAP', 22)
NAMEWRAP = spec.get('NAMEWRAP', WRAP)
NODESEP = spec.get('NODESEP', 0.18)
RANKSEP = spec.get('RANKSEP', 0.32)
STY = {
  'person':   ('#08427B', 'white', 'box', 'rounded,filled'),
  'container':('#438DD5', 'white', 'box', 'rounded,filled'),
  'job':      ('#438DD5', 'white', 'box', 'rounded,filled'),
  'component':('#85BBF0', 'black', 'box', 'rounded,filled'),
  'ext':      ('#999999', 'white', 'box', 'rounded,filled'),
  'extcomp':  ('#CCCCCC', 'black', 'box', 'rounded,filled'),
  'db':       ('#438DD5', 'white', 'cylinder', 'filled'),
  'note':     ('#FFFDE7', 'black', 'note', 'filled'),
  'dnode':    ('#FFFFFF', 'black', 'box', 'filled'),
}
def esc(t): return html.escape(t, quote=False)
def wrap(t, w):
    out = []
    for part in t.split('\n'):
        out += textwrap.wrap(part, w, break_long_words=False, break_on_hyphens=False) or ['']
    return '<br/>'.join(esc(x) for x in out)
L = ['digraph G {',
     f'  graph [rankdir=TB, newrank=true, splines=true, nodesep={NODESEP}, ranksep={RANKSEP}, fontname="Liberation Sans", fontsize=15, pad="0.08", outputorder=edgesfirst];',
     '  node [fontname="Liberation Sans", fontsize=14, margin="0.10,0.06", penwidth=0];',
     '  edge [fontname="Liberation Sans", fontsize=14, color="#666666", fontcolor="#333333", arrowsize=0.7, penwidth=1.1];']
if spec.get('TITLE'):
    L.append(f'  labelloc=t; label=<<b>{wrap(spec["TITLE"], spec.get("TITLEWRAP", 60))}</b>>;')
nodedef = {}
for n in NODES:
    nid, kind, name, tech, desc = n
    fill, fc, shape, style = STY[kind]
    parts = [f'<font point-size="15"><b>{wrap(name, NAMEWRAP)}</b></font>']
    if tech: parts.append(f'<i>[{wrap(tech, WRAP+2)}]</i>')
    if desc: parts.append(wrap(desc, WRAP))
    lab = '<br/>'.join(parts)
    extra = ' penwidth=1, color="#8A8A8A"' if kind in ('note', 'dnode') else ''
    nodedef[nid] = f'  {nid} [shape={shape}, style="{style}", fillcolor="{fill}", fontcolor="{fc}", label=<{lab}>{extra}];'
incl = set()
_cc = [0]
def emit_cluster(title, items, depth=1):
    # items: lista de ids o dicts {título: [items]} (clústeres anidados, p. ej. nodos de despliegue)
    _cc[0] += 1; ind = '  ' * depth
    lab = '<br/>'.join(f'<b>{esc(x)}</b>' if i == 0 else f'<font point-size="14">{esc(x)}</font>' for i, x in enumerate(title.split('|')))
    L.append(f'{ind}subgraph cluster_{_cc[0]} {{ label=<{lab}>; style="dashed,rounded"; color="#444444"; fontcolor="#222222"; fontsize=15; margin=8;')
    for it in items:
        if isinstance(it, dict):
            for t2, its2 in it.items(): emit_cluster(t2, its2, depth + 1)
        else:
            L.append(ind + nodedef[it]); incl.add(it)
    L.append(ind + '}')
for title, ids in CLUSTERS.items():
    emit_cluster(title, ids)
for nid, d in nodedef.items():
    if nid not in incl: L.append(d)
for r in ROWS:
    L.append('  { rank=same; ' + '; '.join(r) + '; }')
    for a, b in zip(r, r[1:]):
        L.append(f'  {a} -> {b} [style=invis, weight=5];')
# keep vertical order: invisible edges between first nodes of consecutive rows
for r1, r2 in zip(ROWS, ROWS[1:]):
    L.append(f'  {r1[0]} -> {r2[0]} [style=invis, weight=0];')
rowof = {n: i for i, r in enumerate(ROWS) for n in r}
for e in EDGES:
    a, b, lab = e[:3]
    opts = e[3] if len(e) > 3 else ''
    attrs = []
    ra, rb = rowof.get(a), rowof.get(b)
    if ra is not None and rb is not None:
        if rb < ra:   # arista hacia arriba: se invierte para no romper las filas
            a, b = b, a; attrs.append('dir=back')
        elif ra == rb:
            attrs.append('SAMEROW')
    same = 'SAMEROW' in attrs
    if same and lab: print('AVISO: arista etiquetada en la misma fila:', a, b)
    if same: attrs.remove('SAMEROW')
    if lab: attrs.append(f'{"xlabel" if same and spec.get("SAMEROW_XLABEL", True) else "label"}=<{wrap(lab, spec.get("LABELWRAP", 18))}>')
    if opts: attrs.append(opts)
    L.append(f'  {a} -> {b} [{", ".join(attrs)}];')
L.append('}')
base = os.path.splitext(sys.argv[1])[0].replace('.spec', '')
open(base + '.dot', 'w', encoding='utf-8').write('\n'.join(L) + '\n')
svg = subprocess.run(['dot', '-Tsvg', base + '.dot'], capture_output=True, text=True).stdout
m = re.search(r'viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"', svg)
w, h = float(m.group(1)), float(m.group(2))
dpi = int(min(300, 72 * 2380 / w))
r = subprocess.run(['dot', '-Tpng', f'-Gdpi={dpi:.0f}', base + '.dot', '-o', base + '.png'], capture_output=True, text=True)
if r.stderr.strip(): print('DOT:', r.stderr.strip())
sc = min(450 / w, 650 / h)
print(f'{os.path.basename(base)}: {w:.0f}x{h:.0f}pt ratio {h/w:.2f} -> 14px font = {14*sc:.2f} pt impreso ({"ancho" if 450/w < 650/h else "alto"}) dpi {dpi:.0f}')

#!/usr/bin/env python3
import csv,json,re,time
from pathlib import Path
from statistics import mean
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein
import easyocr
ROOT=Path(__file__).resolve().parent; DATA=ROOT/'data'; OUT=ROOT/'results_fast'; TXT=OUT/'texts'
def norm(s): return re.sub(r'\s+',' ',re.sub(r'[^\w\s]+',' ',s.lower(),flags=re.UNICODE)).strip()
def ca(r,h):
 r,h=norm(r),norm(h); return max(0,1-Levenshtein.distance(r,h)/len(r)) if r else 0
rows=list(csv.DictReader(open(OUT/'per_image.csv'))) if (OUT/'per_image.csv').exists() else []
summary=list(csv.DictReader(open(OUT/'summary.csv'))) if (OUT/'summary.csv').exists() else []
done={r['variant'] for r in summary}
name='easyocr-en'; langs=['en']
reader=easyocr.Reader(langs,gpu=False,verbose=False)
per=[]; texts=[]
for img in sorted(DATA.glob('*.jpeg')):
 ref=img.with_suffix('.txt').read_text(errors='replace')
 t0=time.perf_counter(); parts=reader.readtext(str(img),detail=0,paragraph=True); sec=time.perf_counter()-t0
 text='\n'.join(map(str,parts)); token=fuzz.token_set_ratio(norm(ref),norm(text))/100; ch=ca(ref,text)
 print(img.name, sec, token, ch, len(text), flush=True)
 per.append((sec,token,ch,len(text))); texts.append(f'===== {img.name} =====\n{text}\n')
 # replace duplicate rows for easyocr-en per image if any
 rows=[r for r in rows if not (r.get('variant')==name and r.get('image')==img.name)]
 rows.append({'variant':name,'image':img.name,'seconds':round(sec,3),'token_set_accuracy':round(token,4),'char_accuracy':round(ch,4),'chars_out':len(text),'status':'ok','error':''})
summary=[r for r in summary if r.get('variant')!=name]
summary.append({'variant':name,'engine':'easyocr','lang':'+'.join(langs),'psm':'','prep':'raw','images_ok':len(per),'images_total':len(per),'total_seconds':round(sum(x[0] for x in per),3),'avg_seconds_per_image':round(mean(x[0] for x in per),3),'avg_token_set_accuracy':round(mean(x[1] for x in per),4),'avg_char_accuracy':round(mean(x[2] for x in per),4),'avg_chars_out':round(mean(x[3] for x in per),1),'status':'ok','error':''})
(TXT/f'{name}.txt').write_text('\n'.join(texts),errors='replace')
keys=['variant','engine','lang','psm','prep','images_ok','images_total','total_seconds','avg_seconds_per_image','avg_token_set_accuracy','avg_char_accuracy','avg_chars_out','status','error']
with (OUT/'per_image.csv').open('w',newline='') as f: w=csv.DictWriter(f,fieldnames=['variant','image','seconds','token_set_accuracy','char_accuracy','chars_out','status','error']); w.writeheader(); w.writerows(rows)
with (OUT/'summary.csv').open('w',newline='') as f: w=csv.DictWriter(f,fieldnames=keys); w.writeheader(); w.writerows(summary)
(OUT/'summary.json').write_text(json.dumps(summary,indent=2))
print(summary[-1])

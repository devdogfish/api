#!/usr/bin/env python3
import csv, json, re, time
from pathlib import Path
from statistics import mean
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein
ROOT=Path(__file__).resolve().parent; DATA=ROOT/'data'; OUT=ROOT/'results_fast'; TXT=OUT/'texts'; TXT.mkdir(parents=True,exist_ok=True)
def norm(s): return re.sub(r'\s+',' ',re.sub(r'[^\w\s]+',' ',s.lower(),flags=re.UNICODE)).strip()
def ca(ref,hyp):
 r,h=norm(ref),norm(hyp); return max(0,1-Levenshtein.distance(r,h)/len(r)) if r else 0
def load_csv(p): return list(csv.DictReader(open(p))) if p.exists() else []
rows=load_csv(OUT/'per_image.csv'); summary=load_csv(OUT/'summary.csv'); done={r['variant'] for r in summary}
variants=[('easyocr-en',['en']),('easyocr-en-de',['en','de']),('easyocr-en-fr',['en','fr'])]
try:
 import easyocr
except Exception as e:
 for name,langs in variants:
  if name not in done: summary.append({'variant':name,'engine':'easyocr','lang':'+'.join(langs),'psm':'','prep':'raw','images_ok':0,'images_total':len(list(DATA.glob('*.jpeg'))),'status':'fail','error':repr(e)[:300]})
else:
 for name,langs in variants:
  if name in done: continue
  per=[]; texts=[]; status='ok'; err=''
  try:
   reader=easyocr.Reader(langs,gpu=False,verbose=False)
  except Exception as e:
   summary.append({'variant':name,'engine':'easyocr','lang':'+'.join(langs),'psm':'','prep':'raw','images_ok':0,'images_total':len(list(DATA.glob('*.jpeg'))),'status':'fail','error':repr(e)[:300]}); continue
  for img in sorted(DATA.glob('*.jpeg')):
   ref=img.with_suffix('.txt').read_text(errors='replace')
   try:
    t0=time.perf_counter(); parts=reader.readtext(str(img),detail=0,paragraph=True); sec=time.perf_counter()-t0
    text='\n'.join(parts); ta=fuzz.token_set_ratio(norm(ref),norm(text))/100; ch=ca(ref,text)
    rows.append({'variant':name,'image':img.name,'seconds':round(sec,3),'token_set_accuracy':round(ta,4),'char_accuracy':round(ch,4),'chars_out':len(text),'status':'ok','error':''}); per.append((sec,ta,ch,len(text))); texts.append(f'===== {img.name} =====\n{text}\n')
   except Exception as e:
    status='partial'; err=repr(e)[:300]; rows.append({'variant':name,'image':img.name,'seconds':'','token_set_accuracy':'','char_accuracy':'','chars_out':'','status':'fail','error':err})
  if per:
   (TXT/f'{name}.txt').write_text('\n'.join(texts),errors='replace')
   summary.append({'variant':name,'engine':'easyocr','lang':'+'.join(langs),'psm':'','prep':'raw','images_ok':len(per),'images_total':len(list(DATA.glob('*.jpeg'))),'total_seconds':round(sum(x[0] for x in per),3),'avg_seconds_per_image':round(mean(x[0] for x in per),3),'avg_token_set_accuracy':round(mean(x[1] for x in per),4),'avg_char_accuracy':round(mean(x[2] for x in per),4),'avg_chars_out':round(mean(x[3] for x in per),1),'status':status,'error':err})
keys=['variant','engine','lang','psm','prep','images_ok','images_total','total_seconds','avg_seconds_per_image','avg_token_set_accuracy','avg_char_accuracy','avg_chars_out','status','error']
with (OUT/'per_image.csv').open('w',newline='') as f: w=csv.DictWriter(f,fieldnames=['variant','image','seconds','token_set_accuracy','char_accuracy','chars_out','status','error']); w.writeheader(); w.writerows(rows)
with (OUT/'summary.csv').open('w',newline='') as f: w=csv.DictWriter(f,fieldnames=keys); w.writeheader(); w.writerows(summary)
(OUT/'summary.json').write_text(json.dumps(summary,indent=2))
print('summary rows',len(summary))
print(summary[-3:])

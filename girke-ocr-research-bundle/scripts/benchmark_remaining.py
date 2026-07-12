#!/usr/bin/env python3
# Append four more preprocessing variants with aggressive per-image timeout.
import csv, json, os, re, subprocess, tempfile, time
from pathlib import Path
from statistics import mean
import cv2, numpy as np
from PIL import Image, ImageOps
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein
ROOT=Path(__file__).resolve().parent; DATA=ROOT/'data'; OUT=ROOT/'results_fast'; TXT=OUT/'texts'
images=sorted(DATA.glob('*.jpeg'))
def norm(s): return re.sub(r'\s+',' ',re.sub(r'[^\w\s]+',' ',s.lower(),flags=re.UNICODE)).strip()
def char_acc(ref,hyp):
 r,h=norm(ref),norm(hyp); return max(0,1-(Levenshtein.distance(r,h)/len(r))) if r else (1 if not h else 0)
def prep(src,mode):
 img=cv2.imread(str(src)); gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY); gray=cv2.resize(gray,None,fx=2,fy=2,interpolation=cv2.INTER_CUBIC)
 if mode=='up2_gray': out=gray
 elif mode=='otsu': _,out=cv2.threshold(gray,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
 elif mode=='sharpen': out=cv2.filter2D(gray,-1,np.array([[0,-1,0],[-1,5,-1],[0,-1,0]]))
 elif mode=='contrast':
  pil=Image.open(src).convert('L'); pil=ImageOps.autocontrast(pil); pil=pil.resize((pil.width*2,pil.height*2),Image.Resampling.BICUBIC); fd,p=tempfile.mkstemp(suffix='.png'); os.close(fd); pil.save(p); return Path(p)
 else: raise ValueError(mode)
 fd,p=tempfile.mkstemp(suffix='.png'); os.close(fd); cv2.imwrite(p,out); return Path(p)
variants=[('tess-latin-psm11-up2_gray','Latin',11,'up2_gray'),('tess-latin-psm11-otsu','Latin',11,'otsu'),('tess-latin-psm11-sharpen','Latin',11,'sharpen'),('tess-latin-psm11-contrast','Latin',11,'contrast'),('tess-eng+deu+fra-psm11-up2_gray','eng+deu+fra',11,'up2_gray'),('tess-eng+deu+fra-psm11-otsu','eng+deu+fra',11,'otsu'),('tess-eng+deu+fra-psm11-sharpen','eng+deu+fra',11,'sharpen')]
rows=[]; summary=[]
if (OUT/'per_image.csv').exists(): rows=list(csv.DictReader(open(OUT/'per_image.csv')))
if (OUT/'summary.csv').exists(): summary=list(csv.DictReader(open(OUT/'summary.csv')))
done={r['variant'] for r in summary}
def flush():
 keys=['variant','engine','lang','psm','prep','images_ok','images_total','total_seconds','avg_seconds_per_image','avg_token_set_accuracy','avg_char_accuracy','avg_chars_out','status','error']
 with (OUT/'per_image.csv').open('w',newline='') as f: w=csv.DictWriter(f,fieldnames=['variant','image','seconds','token_set_accuracy','char_accuracy','chars_out','status','error']); w.writeheader(); w.writerows(rows)
 with (OUT/'summary.csv').open('w',newline='') as f: w=csv.DictWriter(f,fieldnames=keys); w.writeheader(); w.writerows(summary)
 (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
for name,lang,psm,pmode in variants:
 if name in done: continue
 per=[]; texts=[]; status='ok'; err=''
 for img in images:
  ref=img.with_suffix('.txt').read_text(errors='replace'); tmp=None
  try:
   tmp=prep(img,pmode); t0=time.perf_counter(); cp=subprocess.run(['tesseract',str(tmp),'stdout','-l',lang,'--psm',str(psm),'--oem','1'],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45); sec=time.perf_counter()-t0
   if cp.returncode: raise RuntimeError(cp.stderr.strip()[:300])
   text=cp.stdout; ta=fuzz.token_set_ratio(norm(ref),norm(text))/100; ca=char_acc(ref,text)
   rows.append({'variant':name,'image':img.name,'seconds':round(sec,3),'token_set_accuracy':round(ta,4),'char_accuracy':round(ca,4),'chars_out':len(text),'status':'ok','error':''}); per.append((sec,ta,ca,len(text))); texts.append(f'===== {img.name} =====\n{text}\n')
  except Exception as e:
   status='partial'; err=str(e)[:300]; rows.append({'variant':name,'image':img.name,'seconds':'','token_set_accuracy':'','char_accuracy':'','chars_out':'','status':'fail','error':err})
  finally:
   if tmp and tmp!=img:
    try: tmp.unlink()
    except: pass
 if per:
  (TXT/f'{name}.txt').write_text('\n'.join(texts),errors='replace')
  summary.append({'variant':name,'engine':'tesseract','lang':lang,'psm':psm,'prep':pmode,'images_ok':len(per),'images_total':len(images),'total_seconds':round(sum(x[0] for x in per),3),'avg_seconds_per_image':round(mean(x[0] for x in per),3),'avg_token_set_accuracy':round(mean(x[1] for x in per),4),'avg_char_accuracy':round(mean(x[2] for x in per),4),'avg_chars_out':round(mean(x[3] for x in per),1),'status':status,'error':err})
 else: summary.append({'variant':name,'engine':'tesseract','lang':lang,'psm':psm,'prep':pmode,'images_ok':0,'images_total':len(images),'status':'fail','error':err})
 flush(); print(name, summary[-1])
print('done')

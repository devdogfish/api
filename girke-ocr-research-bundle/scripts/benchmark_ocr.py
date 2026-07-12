#!/usr/bin/env python3
import csv, json, os, re, subprocess, tempfile, time
from pathlib import Path
from statistics import mean

import cv2
import numpy as np
from PIL import Image, ImageOps
from rapidfuzz import fuzz

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
OUT = ROOT / 'results'
OUT_TXT = OUT / 'texts'
OUT.mkdir(parents=True, exist_ok=True)
OUT_TXT.mkdir(parents=True, exist_ok=True)

images = sorted(DATA.glob('*.jpeg'))
assert images, f'no images in {DATA}'

def norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r'[^\w\s]+', ' ', s, flags=re.UNICODE)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def cer(ref: str, hyp: str) -> float:
    # normalized Levenshtein distance at char level
    from rapidfuzz.distance import Levenshtein
    r, h = norm(ref), norm(hyp)
    if not r:
        return 1.0 if h else 0.0
    return Levenshtein.distance(r, h) / len(r)

def prep(src: Path, mode: str) -> Path:
    img = cv2.imread(str(src))
    if img is None:
        raise RuntimeError(f'cannot read {src}')
    if mode == 'raw':
        return src
    if mode == 'gray':
        out = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    elif mode == 'up2_gray':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        out = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    elif mode == 'up3_gray':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        out = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    elif mode == 'otsu':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        _, out = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    elif mode == 'adaptive':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        out = cv2.adaptiveThreshold(gray,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C,cv2.THRESH_BINARY,31,11)
    elif mode == 'sharpen':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        kernel = np.array([[0,-1,0],[-1,5,-1],[0,-1,0]])
        out = cv2.filter2D(gray, -1, kernel)
    elif mode == 'denoise':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        out = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
    elif mode == 'contrast':
        pil = Image.open(src).convert('L')
        pil = ImageOps.autocontrast(pil)
        pil = pil.resize((pil.width*2, pil.height*2), Image.Resampling.BICUBIC)
        fd, p = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        pil.save(p)
        return Path(p)
    else:
        raise ValueError(mode)
    fd, p = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    cv2.imwrite(p, out)
    return Path(p)

VARIANTS = [
    # Baselines
    {'name':'tess-eng-psm3-raw','engine':'tesseract','lang':'eng','psm':3,'prep':'raw'},
    {'name':'tess-deu-psm3-raw','engine':'tesseract','lang':'deu','psm':3,'prep':'raw'},
    {'name':'tess-fra-psm3-raw','engine':'tesseract','lang':'fra','psm':3,'prep':'raw'},
    {'name':'tess-latin-psm3-raw','engine':'tesseract','lang':'Latin','psm':3,'prep':'raw'},
    {'name':'tess-eng+deu+fra-psm3-raw','engine':'tesseract','lang':'eng+deu+fra','psm':3,'prep':'raw'},
    {'name':'tess-latin+eng-psm3-raw','engine':'tesseract','lang':'Latin+eng','psm':3,'prep':'raw'},
    # PSM search: product labels are not single clean pages
    {'name':'tess-latin-psm4-raw','engine':'tesseract','lang':'Latin','psm':4,'prep':'raw'},
    {'name':'tess-latin-psm6-raw','engine':'tesseract','lang':'Latin','psm':6,'prep':'raw'},
    {'name':'tess-latin-psm11-raw','engine':'tesseract','lang':'Latin','psm':11,'prep':'raw'},
    {'name':'tess-latin-psm12-raw','engine':'tesseract','lang':'Latin','psm':12,'prep':'raw'},
    {'name':'tess-latin-psm13-raw','engine':'tesseract','lang':'Latin','psm':13,'prep':'raw'},
    {'name':'tess-eng+deu+fra-psm4-raw','engine':'tesseract','lang':'eng+deu+fra','psm':4,'prep':'raw'},
    {'name':'tess-eng+deu+fra-psm6-raw','engine':'tesseract','lang':'eng+deu+fra','psm':6,'prep':'raw'},
    {'name':'tess-eng+deu+fra-psm11-raw','engine':'tesseract','lang':'eng+deu+fra','psm':11,'prep':'raw'},
    {'name':'tess-eng+deu+fra-psm12-raw','engine':'tesseract','lang':'eng+deu+fra','psm':12,'prep':'raw'},
    # Preprocessing variants on two strongest language packs
    {'name':'tess-latin-psm11-gray','engine':'tesseract','lang':'Latin','psm':11,'prep':'gray'},
    {'name':'tess-latin-psm11-up2_gray','engine':'tesseract','lang':'Latin','psm':11,'prep':'up2_gray'},
    {'name':'tess-latin-psm11-otsu','engine':'tesseract','lang':'Latin','psm':11,'prep':'otsu'},
    {'name':'tess-latin-psm11-adaptive','engine':'tesseract','lang':'Latin','psm':11,'prep':'adaptive'},
    {'name':'tess-latin-psm11-sharpen','engine':'tesseract','lang':'Latin','psm':11,'prep':'sharpen'},
    {'name':'tess-latin-psm11-contrast','engine':'tesseract','lang':'Latin','psm':11,'prep':'contrast'},
    {'name':'tess-eng+deu+fra-psm11-up2_gray','engine':'tesseract','lang':'eng+deu+fra','psm':11,'prep':'up2_gray'},
    {'name':'tess-eng+deu+fra-psm11-otsu','engine':'tesseract','lang':'eng+deu+fra','psm':11,'prep':'otsu'},
    {'name':'tess-eng+deu+fra-psm11-sharpen','engine':'tesseract','lang':'eng+deu+fra','psm':11,'prep':'sharpen'},
]

def run_tesseract(img_path: Path, lang: str, psm: int) -> str:
    cmd = ['tesseract', str(img_path), 'stdout', '-l', lang, '--psm', str(psm), '--oem', '1']
    cp = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if cp.returncode != 0:
        raise RuntimeError(cp.stderr.strip()[:500])
    return cp.stdout

rows = []
summary = []
for v in VARIANTS:
    per = []
    texts = []
    ok = True
    err = ''
    for img in images:
        tmp = None
        ref = img.with_suffix('.txt').read_text(errors='replace')
        try:
            tmp = prep(img, v['prep'])
            t0 = time.perf_counter()
            text = run_tesseract(tmp, v['lang'], v['psm'])
            sec = time.perf_counter() - t0
            sim = fuzz.token_set_ratio(norm(ref), norm(text)) / 100.0
            chr_acc = max(0.0, 1.0 - cer(ref, text))
            rows.append({'variant':v['name'],'image':img.name,'seconds':round(sec,3),'token_set_accuracy':round(sim,4),'char_accuracy':round(chr_acc,4),'chars_out':len(text),'status':'ok','error':''})
            per.append((sec, sim, chr_acc, len(text)))
            texts.append(f'===== {img.name} =====\n{text}\n')
        except Exception as e:
            ok = False; err = str(e)
            rows.append({'variant':v['name'],'image':img.name,'seconds':'','token_set_accuracy':'','char_accuracy':'','chars_out':'','status':'fail','error':err[:300]})
        finally:
            if tmp and tmp != img:
                try: tmp.unlink()
                except Exception: pass
    if per:
        (OUT_TXT / f"{v['name']}.txt").write_text('\n'.join(texts), errors='replace')
        summary.append({
            'variant': v['name'], 'engine':'tesseract','lang':v['lang'],'psm':v['psm'],'prep':v['prep'],
            'images_ok': len(per), 'images_total': len(images),
            'total_seconds': round(sum(x[0] for x in per),3),
            'avg_seconds_per_image': round(mean(x[0] for x in per),3),
            'avg_token_set_accuracy': round(mean(x[1] for x in per),4),
            'avg_char_accuracy': round(mean(x[2] for x in per),4),
            'avg_chars_out': round(mean(x[3] for x in per),1),
            'status': 'ok' if ok else 'partial', 'error': err[:300]
        })
    else:
        summary.append({'variant':v['name'],'engine':'tesseract','lang':v['lang'],'psm':v['psm'],'prep':v['prep'],'images_ok':0,'images_total':len(images),'status':'fail','error':err[:300]})

with (OUT / 'per_image.csv').open('w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
with (OUT / 'summary.csv').open('w', newline='') as f:
    keys = ['variant','engine','lang','psm','prep','images_ok','images_total','total_seconds','avg_seconds_per_image','avg_token_set_accuracy','avg_char_accuracy','avg_chars_out','status','error']
    w = csv.DictWriter(f, fieldnames=keys)
    w.writeheader(); w.writerows(summary)
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(sorted(summary, key=lambda r: r.get('avg_char_accuracy',0), reverse=True)[:10], indent=2))

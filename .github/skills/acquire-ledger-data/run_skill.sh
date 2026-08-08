#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $(basename "$0") <query>" >&2
  exit 2
fi
QUERY="$1"
TMPFILE=$(mktemp)
RAW_URL="https://raw.githubusercontent.com/harry2480/ledger/feat/add-purchase-url/data/private-transaction.csv"

# Try gh API first (returns base64 content)
if command -v gh >/dev/null 2>&1; then
  if gh api repos/harry2480/ledger/contents/data/private-transaction.csv --jq .content > "$TMPFILE.base64" 2>/dev/null; then
    base64 --decode "$TMPFILE.base64" > "$TMPFILE" 2>/dev/null || true
    rm -f "$TMPFILE.base64" || true
  fi
fi

# If file empty or missing, fallback to raw.githubusercontent
if [ ! -s "$TMPFILE" ]; then
  curl -sS "$RAW_URL" -o "$TMPFILE" || true
fi

if [ ! -s "$TMPFILE" ]; then
  echo "Failed to retrieve ledger CSV." >&2
  rm -f "$TMPFILE" || true
  exit 3
fi

python3 - <<PY
import csv,sys,os,re
from datetime import datetime
fn = os.environ.get('TMPFILE') or '${TMPFILE}'
q = '${QUERY}'.lower()

# heuristics for column roles
DATE_KEYS = ['date','購入日','日付','purchase_date']
AMOUNT_KEYS = ['amount','price','金額','cost','cost_yen']
DESC_KEYS = ['description','item','memo','note','title','detail','summary']
URL_KEYS = ['url','link','purchase_url']

def find_key(headers, candidates):
    for c in candidates:
        for h in headers:
            if c in h.lower():
                return h
    return None

# try reading CSV with utf-8, fallback to latin-1
for enc in ('utf-8','utf-8-sig','latin-1'):
    try:
        with open(fn, 'r', encoding=enc) as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        break
    except Exception:
        rows = []

if not rows:
    print('No data in CSV or failed to parse')
    sys.exit(4)

headers = rows[0].keys()
date_key = find_key(headers, DATE_KEYS)
amount_key = find_key(headers, AMOUNT_KEYS)
desc_key = find_key(headers, DESC_KEYS)
url_key = find_key(headers, URL_KEYS)

matches = []
for r in rows:
    # flatten values
    vals = [ (k,(r.get(k) or '').strip()) for k in headers]
    text = ' '.join(v for k,v in vals if v)
    if q in text.lower():
        matches.append(r)

if not matches:
    print('No matching purchase found.')
    sys.exit(1)

# date parsing helper
def parse_date(s):
    if not s:
        return None
    s = s.strip()
    # common patterns
    patterns = ['%Y-%m-%d','%Y/%m/%d','%Y.%m.%d','%Y年%m月%d日','%Y%m%d','%d/%m/%Y','%d-%m-%Y']
    for p in patterns:
        try:
            return datetime.strptime(s, p).date()
        except Exception:
            pass
    # try extracting yyyy mm dd via regex
    m = re.search(r'(20\d{2})[^0-9]?(0?\d)[^0-9]?(0?\d)', s)
    if m:
        y=int(m.group(1)); mo=int(m.group(2)); d=int(m.group(3))
        return datetime(y,mo,d).date()
    return None

for r in matches:
    # get values
    desc = r.get(desc_key) if desc_key else None
    if not desc:
        # fallback to first non-empty column
        for k in headers:
            v = r.get(k) or ''
            if v.strip():
                desc = v
                break
    amt = (r.get(amount_key) or '').strip() if amount_key else ''
    url = (r.get(url_key) or '').strip() if url_key else ''
    date_raw = (r.get(date_key) or '').strip() if date_key else ''
    d = parse_date(date_raw)
    if d:
        date_jp = f"{d.year}年{d.month:02d}月{d.day:02d}日"
    else:
        date_jp = date_raw or '日付不明'
    # format amount
    amt_out = ''
    if amt:
        # try to extract number
        m = re.search(r"([0-9,]+)", amt.replace('¥','').replace('￥',''))
        if m:
            num = int(m.group(1).replace(',',''))
            amt_out = f" — ¥{num:,}"
        else:
            amt_out = f" — {amt}"
    # build item
    item = desc.strip() if desc else '購入品'
    out = f"{date_jp}に {item} を購入しました{amt_out}"
    if url:
        out += f" — {url}"
    print(out)
PY

rm -f "$TMPFILE" || true

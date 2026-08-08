#!/usr/bin/env python3
"""Batch URL viewer: extract URLs from a daily summary and check/open/digest them.

Usage:
  python3 .github/skills/batch-url-viewing/run.py 20260221 [--open] [--digest] [--fail-only] [--concurrency N] [--rate S]

This script follows the SKILL.md policy: no intermediate files left in workspace, respects rate limits,
and can call existing `scripts/url_digest.py` when `--digest` is set.
"""

import argparse
import concurrent.futures
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser
import webbrowser
from pathlib import Path
from subprocess import run


URL_RE = re.compile(r"https?://[^)\]\s]+")


def find_file(arg):
    # If arg looks like YYYYMMDD, map to ideas/daily/YYYYMMDD-summary.md
    if re.fullmatch(r"\d{8}", arg):
        p = Path("ideas/daily") / f"{arg}-summary.md"
        if p.exists():
            return p
        else:
            raise FileNotFoundError(f"Summary file not found: {p}")
    p = Path(arg)
    if p.exists():
        return p
    raise FileNotFoundError(f"File not found: {arg}")


def extract_urls(text):
    # Extract markdown links and bare URLs
    urls = []
    seen = set()
    # markdown [text](url)
    for m in re.finditer(r"\[[^\]]+\]\((https?://[^)]+)\)", text):
        u = m.group(1).strip()
        if u not in seen:
            seen.add(u)
            urls.append(u)
    # bare URLs
    for m in URL_RE.finditer(text):
        u = m.group(0).strip().rstrip(').,')
        if u not in seen:
            seen.add(u)
            urls.append(u)
    return urls


def allowed_by_robots(url):
    try:
        parsed = urllib.parse.urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        return rp.can_fetch("batch-url-viewer", url)
    except Exception:
        return True


def check_url(url, rate, digest, args_date, do_digest):
    result = {
        "url": url,
        "status": None,
        "final_url": "",
        "content_type": "",
        "note": "",
    }
    if not allowed_by_robots(url):
        result["note"] = "Disallowed by robots.txt"
        return result

    req = urllib.request.Request(url, headers={"User-Agent": "batch-url-viewer/1.0"}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result["status"] = resp.getcode()
            result["final_url"] = resp.geturl()
            result["content_type"] = resp.getheader("Content-Type") or ""
    except Exception:
        # fallback to GET for cases where HEAD is blocked
        try:
            req2 = urllib.request.Request(url, headers={"User-Agent": "batch-url-viewer/1.0"})
            with urllib.request.urlopen(req2, timeout=15) as resp:
                result["status"] = resp.getcode()
                result["final_url"] = resp.geturl()
                result["content_type"] = resp.getheader("Content-Type") or ""
        except Exception as e:
            result["status"] = "ERR"
            result["note"] = str(e)

    # optional digest
    if digest and do_digest and result.get("status") and result.get("status") != "ERR":
        try:
            run([sys.executable, "scripts/url_digest.py", url, "--translate"], check=False)
        except Exception:
            pass

    # rate limiting per task
    if rate and rate > 0:
        time.sleep(rate)

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="YYYYMMDD or path to summary file")
    ap.add_argument("--open", action="store_true", help="Open URLs in default browser")
    ap.add_argument("--open-only", action="store_true", help="Only open URLs and do not write output file")
    ap.add_argument("--meta-only", action="store_true", help="Only extract URLs from 'URL:' lines or Meta情報 blocks")
    ap.add_argument("--digest", action="store_true", help="Run url_digest.py for each URL")
    ap.add_argument("--fail-only", action="store_true", help="Only show/open URLs with error status")
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--rate", type=float, default=1.0, help="Seconds to sleep after each request (per worker)")
    args = ap.parse_args()

    try:
        path = find_file(args.target)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        sys.exit(2)

    # determine date_tag early for cache file naming
    m = re.match(r"(\d{8})", args.target)
    if m:
        date_tag = m.group(1)
    else:
        date_tag = time.strftime("%Y%m%d")

    text = path.read_text(encoding="utf-8")
    if args.meta_only:
        # extract URLs only from lines like 'URL: https://...'
        meta_urls = re.findall(r"[Uu][Rr][Ll][:：]\s*(https?://[^\s,]+)", text)
        # also try Japanese 'メタ情報' blocks: collect URLs following a line containing 'メタ情報' or 'Meta'
        if not meta_urls:
            lines = text.splitlines()
            meta_urls = []
            capture = False
            for ln in lines:
                if re.search(r"メタ情報|Meta情報|Meta information|メタ", ln):
                    capture = True
                    continue
                if capture:
                    if not ln.strip():
                        break
                    found = URL_RE.findall(ln)
                    for u in found:
                        if u not in meta_urls:
                            meta_urls.append(u)
        urls = meta_urls
    else:
        urls = extract_urls(text)
    if not urls:
        print("No URLs found in", path)
        return

    print(f"Found {len(urls)} unique URLs in {path}")

    results = []
    do_digest = args.digest

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = [ex.submit(check_url, u, args.rate, args.digest, args.target, do_digest) for u in urls]
        for fut in concurrent.futures.as_completed(futures):
            r = fut.result()
            results.append(r)
            st = r.get("status")
            note = r.get("note") or ""
            print(f"{r['url']} -> {st} {r.get('final_url','')} {note}")

    # Post-process opening to avoid duplicates across runs: use per-day cache in /tmp
    if args.open:
        cache_dir = Path(os.environ.get('TMPDIR', '/tmp'))
        cache_file = cache_dir / f"batch-url-viewer-opened-{date_tag}.txt"
        opened_set = set()
        if cache_file.exists():
            try:
                opened_set = set(x.strip() for x in cache_file.read_text(encoding='utf-8').splitlines() if x.strip())
            except Exception:
                opened_set = set()

        to_open = []
        for r in results:
            st = r.get('status')
            status_ok = isinstance(st, int) and st < 400
            if args.fail_only and status_ok:
                continue
            final = r.get('final_url') or r.get('url')
            if not final:
                continue
            # respect robots.txt: skip if disallowed
            if not allowed_by_robots(final):
                continue
            if final in opened_set:
                continue
            to_open.append(final)

        # open sequentially and append to cache
        if to_open:
            try:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                with cache_file.open('a', encoding='utf-8') as cf:
                    for u in to_open:
                        try:
                            # Prefer system opener for reliability (macOS: open, Linux: xdg-open)
                            opened = False
                            if sys.platform == 'darwin':
                                try:
                                    run(['open', u], check=False)
                                    opened = True
                                except Exception:
                                    opened = False
                            elif sys.platform.startswith('linux'):
                                try:
                                    run(['xdg-open', u], check=False)
                                    opened = True
                                except Exception:
                                    opened = False
                            if not opened:
                                try:
                                    webbrowser.open(u)
                                except Exception:
                                    pass
                            cf.write(u + "\n")
                            # small pause to avoid browser overload
                            time.sleep(0.1)
                        except Exception:
                            pass
                print(f"Opened {len(to_open)} new URLs (skipped {len(results)-len(to_open)} already-opened)")
            except Exception:
                print("Warning: could not update/open cache file")

    # write summary file
    date_tag = None
    m = re.match(r"(\d{8})", args.target)
    if m:
        date_tag = m.group(1)
    else:
        # fallback to today
        date_tag = time.strftime("%Y%m%d")

    # write summary file unless open-only requested
    if not args.open_only:
        outp = Path("ideas/daily") / f"{date_tag}-url-check.md"
        header = f"# URL Check — {time.strftime('%Y-%m-%d')}\n\n"
        lines = [header, "| URL | Status | Final URL | Content-Type | Note |\n", "|-----|--------|-----------|--------------|------|\n"]
        for r in results:
            lines.append(f"| {r['url']} | {r['status']} | {r.get('final_url','-')} | {r.get('content_type','-')} | {r.get('note','')} |\n")

        outp.parent.mkdir(parents=True, exist_ok=True)
        with outp.open("a", encoding="utf-8") as f:
            f.writelines(lines)

        print(f"Wrote: {outp}")
    else:
        print("Open-only mode: skipped writing URL check file.")


if __name__ == '__main__':
    main()

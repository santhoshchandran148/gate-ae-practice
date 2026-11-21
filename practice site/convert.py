#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convert.py — GATE-style question-paper PDF  ->  static exam-practice data.

USAGE
    python convert.py AE.pdf --key AE_Keys.pdf
    python convert.py AE.pdf --key AE_Keys.pdf --report
    python convert.py AE.pdf --key AE_Keys.pdf --clean-watermark --report
    python convert.py AE.pdf --key AE_Keys.pdf --png
    python convert.py AE.pdf --key AE_Keys.pdf --key-csv AE_keys.csv
    python convert.py AE.pdf --key AE_Keys.pdf --exclude 4,37

DESIGN
    * Screenshot-based: each question is ONE cropped image.
    * Key parsing: page.get_text("words") -> rows grouped by y (tolerance 3pt)
      -> tokens -> strict field parser. Marks is ALWAYS the last token.
    * Label detection: words -> lines grouped by y -> reject banner lines
      containing "Carry"/"mark"/en-dash range -> accept only lines where
      Q.n is the only content in the left cell OR text starts to its right.
    * Cropping: from top of label row to next label row on page (or last
      non-empty row on page), snapped to next horizontal border, +padding.
    * WebP: Pillow is used. Single warning if unavailable; PNG fallback.
    * Questions.js extension matches the file actually written.

TROUBLESHOOTING
    * Scanned PDFs are NOT supported (no OCR). Run `ocrmypdf` first so the
      "Q.n" labels become text.
    * Missed question -> raise LEFT_COL_FRAC.
    * Cropped header/footer -> raise HEADER_TOP_PX / FOOTER_BOT_PX.
    * Crop too short -> raise PAD_BOTTOM or lower SNAP_TO_BORDER_PX.
    * Key rows < 65 -> inspect verify/key_rows_debug.txt (written on --report).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---- PyMuPDF (new name preferred; falls back to fitz) ----------------------
try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz
    except ImportError:
        sys.stderr.write(
            "ERROR: PyMuPDF is required.\n"
            "    pip install -r requirements.txt\n"
        )
        sys.exit(1)

# ---- Pillow (WebP encoder) -------------------------------------------------
try:
    from PIL import Image
    _PIL_OK = True
except ImportError:
    _PIL_OK = False


# =========================================================================== #
# CONFIG
# =========================================================================== #

CONFIG = {
    # ---- Question detection ------------------------------------------------
    "LEFT_COL_FRAC": 0.20,
    "Q_LABEL_RE": r"^Q\.(\d{1,4})$",

    # ---- Page margins ------------------------------------------------------
    "HEADER_TOP_PX": 40,
    "FOOTER_BOT_PX": 40,

    # ---- Crop trimming -----------------------------------------------------
    "PAD_TOP": 4,
    "PAD_BOTTOM": 6,
    "ROW_EMPTY_TEXT_PIX": 2,
    "ROW_EMPTY_IMAGE_PIX": 8,
    "SNAP_TO_BORDER_PX": 6,
    "PAGE_GAP_PX": 4,

    # ---- Render ------------------------------------------------------------
    "ZOOM": 2.0,
    "WEBP_QUALITY": 85,
    "MIN_CROP_HEIGHT_PX": 60,

    # ---- Fallback marks/section (only if key row missing — reported) ------
    "FALLBACK_MARKS": {
        (1, 5): 1, (6, 10): 2,
        (11, 35): 1, (36, 65): 2,
    },
    "FALLBACK_SECTION": {
        **{q: "GA" for q in range(1, 11)},
        **{q: "AE" for q in range(11, 66)},
    },

    # ---- Expected totals ---------------------------------------------------
    "EXPECTED": {
        "total_questions": 65,
        "mcq": 35,
        "msq": 2,
        "nat": 28,
        "ga_marks": 15,
        "ae_marks": 85,
        "total_marks": 100,
    },

    # ---- Tags --------------------------------------------------------------
    "TAG_MAP": [
        (1, 1, "Verbal Aptitude"),
        (2, 3, "Numerical Aptitude"),
        (4, 4, "Verbal Aptitude (Venn)"),
        (5, 5, "Numerical Aptitude"),
        (6, 6, "Numerical Aptitude (Matching)"),
        (7, 7, "Numerical Aptitude"),
        (8, 8, "Numerical Aptitude (Figure)"),
        (9, 9, "Verbal Aptitude"),
        (10, 10, "Numerical Aptitude (Bar chart)"),
        (11, 12, "Engineering Mathematics"),
        (13, 13, "Engineering Mathematics (Linear Alg.)"),
        (14, 15, "Engineering Mathematics"),
        (16, 17, "Aerodynamics"),
        (18, 19, "Aerodynamics (Airfoil)"),
        (20, 22, "Aerodynamics"),
        (23, 25, "Flight Mechanics"),
        (26, 27, "Structures"),
        (28, 30, "Structures (Vibrations)"),
        (31, 33, "Propulsion"),
        (34, 34, "Aerodynamics (NAT)"),
        (35, 35, "Aerodynamics (NAT)"),
        (36, 36, "Structures"),
        (37, 37, "Structures (Material table)"),
        (38, 39, "Structures (MSQ)"),
        (40, 42, "Structures (NAT)"),
        (43, 45, "Aerodynamics (NAT)"),
        (46, 49, "Aerodynamics (NAT)"),
        (50, 53, "Flight Mechanics (NAT)"),
        (54, 57, "Propulsion (NAT)"),
        (58, 61, "Space Dynamics (NAT)"),
        (62, 65, "Thermodynamics (NAT)"),
    ],
    "DEFAULT_TAG": "Untagged (verify me)",

    # ---- Watermark ---------------------------------------------------------
    "WM_MIN_CHANNEL": 235,
    "WM_MAX_SPREAD": 12,
    "WM_PREVIEW_QNOS": [4, 10, 19, 49],
}


# =========================================================================== #
# Helpers
# =========================================================================== #

def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def clean_int(v) -> Optional[int]:
    try:
        return int(str(v).strip())
    except Exception:
        return None


def parse_float(v) -> Optional[float]:
    try:
        return float(str(v).strip())
    except Exception:
        return None


# =========================================================================== #
# BUG 1 — Answer key parsing via word-row grouping
# =========================================================================== #

def _group_words_into_rows(words: list, y_tol: float = 3.0) -> list[list]:
    """
    Group PyMuPDF 'words' tuples into rows. Each word tuple:
        (x0, y0, x1, y1, text, block_no, line_no, word_no)
    Rows are grouped by midpoint y within y_tol, and sorted by x0.
    Returns rows sorted top-to-bottom, each row sorted left-to-right.
    """
    if not words:
        return []
    items = []
    for w in words:
        x0, y0, x1, y1, txt = w[0], w[1], w[2], w[3], w[4]
        cy = (y0 + y1) / 2.0
        items.append((cy, x0, x1, txt))
    items.sort(key=lambda t: (t[0], t[1]))

    rows: list[list] = []
    cur_row: list = []
    cur_y: Optional[float] = None
    for cy, x0, x1, txt in items:
        if cur_y is None or abs(cy - cur_y) <= y_tol:
            cur_row.append((x0, txt))
            cur_y = cy if cur_y is None else (cur_y + cy) / 2.0
        else:
            cur_row.sort(key=lambda t: t[0])
            rows.append(cur_row)
            cur_row = [(x0, txt)]
            cur_y = cy
    if cur_row:
        cur_row.sort(key=lambda t: t[0])
        rows.append(cur_row)
    return rows


KEY_TYPE_RE = re.compile(r"^(MCQ|MSQ|NAT)$")
KEY_SECTION_RE = re.compile(r"^(GA|AE)$")
NAT_RANGE_RE = re.compile(
    r"(-?\d+(?:\.\d+)?)\s*(?:to|–|-)\s*(-?\d+(?:\.\d+)?)"
)
HEADER_TOKENS = {"q.", "q", "no.", "no", "q.no", "qno", "session", "type",
                 "section", "key/range", "key", "marks", "question"}


def _parse_key_row_tokens(tokens: list[str]) -> Optional[dict]:
    """
    Given a row's tokens (left-to-right), return a parsed key row dict
    or None if it does not look like a key row.

    Expected shape (after dropping header tokens):
        qno  session  TYPE  SECTION  <key-tokens...>  marks
    - qno: int 1..65
    - session: int
    - TYPE: MCQ | MSQ | NAT
    - SECTION: GA | AE
    - key: whatever remains between SECTION and the LAST token
    - marks: last token, must be exactly "1" or "2"
    """
    if not tokens:
        return None
    toks = [t for t in tokens if t.strip() and t.lower() not in HEADER_TOKENS]
    if len(toks) < 6:
        return None
    qno_s, session_s, type_s, section_s = toks[0], toks[1], toks[2], toks[3]
    try:
        qno = int(qno_s)
        int(session_s)
    except Exception:
        return None
    if not (1 <= qno <= 65):
        return None
    type_u = type_s.upper()
    section_u = section_s.upper()
    if not KEY_TYPE_RE.match(type_u) or not KEY_SECTION_RE.match(section_u):
        return None
    marks_s = toks[-1]
    marks_i = clean_int(marks_s)
    if marks_i not in (1, 2):
        return None
    key_tokens = toks[4:-1]
    if not key_tokens:
        return None
    key_raw = " ".join(key_tokens).strip()

    # ---- parse key by type ----
    if type_u == "MCQ":
        m = re.search(r"\b([A-Da-d])\b", key_raw)
        if not m:
            return None
        answer = m.group(1).upper()
    elif type_u == "MSQ":
        letters = re.findall(r"[A-Da-d]", key_raw)
        if not letters:
            return None
        answer = sorted({l.upper() for l in letters})
    elif type_u == "NAT":
        m = NAT_RANGE_RE.search(key_raw)
        if m:
            lo, hi = float(m.group(1)), float(m.group(2))
        else:
            xs = re.findall(r"-?\d+(?:\.\d+)?", key_raw)
            if len(xs) == 2:
                lo, hi = float(xs[0]), float(xs[1])
            elif len(xs) == 1:
                lo = hi = float(xs[0])
            else:
                return None
        if lo > hi:
            lo, hi = hi, lo
        answer = {"min": lo, "max": hi}
    else:
        return None

    return {
        "qno": qno,
        "session": int(session_s),
        "type": type_u,
        "section": section_u,
        "marks": float(marks_i),
        "key_raw": key_raw,
        "answer": answer,
    }


def parse_key_pdf(path: Path, debug_path: Optional[Path] = None
                  ) -> tuple[dict[int, dict], list[tuple[int, str, str]]]:
    """
    Returns (rows_by_qno, failures).
    failures: list of (page_index, raw_row_text, reason).
    If debug_path is provided, writes every attempted row and every failure.
    """
    doc = fitz.open(str(path))
    rows_by_qno: dict[int, dict] = {}
    failures: list[tuple[int, str, str]] = []
    debug_lines: list[str] = []
    try:
        for pno in range(len(doc)):
            page = doc[pno]
            words = page.get_text("words")
            rows = _group_words_into_rows(words, y_tol=3.0)
            for row in rows:
                tokens = [t for (_, t) in row]
                raw = " ".join(tokens)
                low = raw.lower()
                if not raw.strip():
                    continue
                if "page" in low and " of " in low:
                    continue  # "Page n of m"
                if low.strip() in ("q. no. session type section key/range marks",):
                    continue
                parsed = _parse_key_row_tokens(tokens)
                if parsed is None:
                    # Only record as failure if it looks like it *might* be a row
                    if any(t.upper() in ("MCQ", "MSQ", "NAT") for t in tokens):
                        failures.append((pno, raw, "could not parse tokens"))
                        debug_lines.append(f"[FAIL p{pno}] {raw}")
                    continue
                qno = parsed["qno"]
                if qno in rows_by_qno:
                    failures.append(
                        (pno, raw, f"duplicate qno {qno} — kept first")
                    )
                    debug_lines.append(f"[DUP  p{pno}] {raw}")
                    continue
                rows_by_qno[qno] = parsed
                debug_lines.append(
                    f"[OK   p{pno}] q={qno:02d} {parsed['type']:3s} "
                    f"{parsed['section']:2s} mk={int(parsed['marks'])} "
                    f"key={parsed['key_raw']!r}"
                )
    finally:
        doc.close()

    if debug_path is not None:
        ensure_dir(debug_path.parent)
        debug_path.write_text(
            "KEY ROWS DEBUG\n"
            "==============\n"
            f"Total rows parsed OK: {len(rows_by_qno)}\n"
            f"Total rows failed:    {len(failures)}\n\n"
            + "\n".join(debug_lines)
            + "\n\nFAILURES\n--------\n"
            + ("\n".join(f"[p{p}] {raw}   --> {reason}"
                          for p, raw, reason in failures) or "(none)")
            + "\n",
            encoding="utf-8",
        )

    return rows_by_qno, failures


def parse_key_csv(path: Path) -> dict[int, dict]:
    """CSV columns: qno,type,answer,marks,section (header optional)."""
    out: dict[int, dict] = {}
    with path.open(newline="", encoding="utf-8") as f:
        rdr = csv.reader(f)
        for row in rdr:
            if not row or row[0].strip().lower() in ("qno", "q.no", "question"):
                continue
            if len(row) < 5:
                continue
            qno = clean_int(row[0])
            if qno is None:
                continue
            qtype = row[1].strip().upper()
            section = row[4].strip().upper()
            marks = parse_float(row[3])
            if qtype not in ("MCQ", "MSQ", "NAT"):
                continue
            if section not in ("GA", "AE"):
                continue
            if marks not in (1, 2):
                continue
            raw = row[2].strip()
            if qtype == "MCQ":
                m = re.search(r"\b([A-Da-d])\b", raw)
                if not m:
                    continue
                answer = m.group(1).upper()
            elif qtype == "MSQ":
                letters = re.findall(r"[A-Da-d]", raw)
                answer = sorted({l.upper() for l in letters})
            else:
                m = NAT_RANGE_RE.search(raw)
                if m:
                    lo, hi = float(m.group(1)), float(m.group(2))
                else:
                    xs = re.findall(r"-?\d+(?:\.\d+)?", raw)
                    if len(xs) == 2:
                        lo, hi = float(xs[0]), float(xs[1])
                    elif len(xs) == 1:
                        lo = hi = float(xs[0])
                    else:
                        continue
                if lo > hi:
                    lo, hi = hi, lo
                answer = {"min": lo, "max": hi}
            out[qno] = {
                "qno": qno, "session": 0, "type": qtype,
                "section": section, "marks": marks,
                "key_raw": raw, "answer": answer,
            }
    return out


# =========================================================================== #
# BUG 2 — Question label detection with banner rejection
# =========================================================================== #

@dataclass
class QLabel:
    qno: int
    page_index: int
    y0: float
    y1: float
    x0: float
    x1: float
    table_x0: float
    table_x1: float


BANNER_RE = re.compile(
    r"(carry\b|\bmarks?\b|\bmark\s*each\b|–|—|(?:\bto\b\s*Q))",
    re.IGNORECASE,
)


def _reject_banner(line_text: str) -> bool:
    """A banner line contains 'Carry', 'mark(s)', or an en/em dash range."""
    return bool(BANNER_RE.search(line_text))


def find_question_labels(doc) -> tuple[list[QLabel], list[str]]:
    """
    Returns (labels, errors). Labels is a dict-order list of exactly one entry
    per qno (1..65). If a qno is matched more than once after banner rejection
    AND its matches are on different pages, that is reported as an ERROR.
    """
    rx = re.compile(CONFIG["Q_LABEL_RE"])
    raw_matches: list[QLabel] = []

    for pno in range(len(doc)):
        page = doc[pno]
        W, H = page.rect.width, page.rect.height
        left_limit = CONFIG["LEFT_COL_FRAC"] * W
        words = page.get_text("words")
        # Group words into lines (tighter tolerance than the key parser)
        by_line: dict[tuple, list] = {}
        for w in words:
            key = (w[5], w[6])  # block, line
            by_line.setdefault(key, []).append(
                (w[0], w[1], w[2], w[3], w[4])
            )
        for _, ws in by_line.items():
            ws.sort(key=lambda t: t[0])
            full_line = " ".join(w[4] for w in ws)
            if _reject_banner(full_line):
                continue

            # Try every candidate span of length 1..3 tokens that matches Q.n
            for i in range(len(ws)):
                for j in range(i + 1, min(len(ws), i + 3) + 1):
                    part = ws[i:j]
                    txt = "".join(p[4] for p in part) if j > i + 1 else part[0][4]
                    m = rx.match(txt.replace(" ", ""))
                    if not m:
                        continue
                    x0 = min(p[0] for p in part)
                    x1 = max(p[2] for p in part)
                    y0 = min(p[1] for p in part)
                    y1 = max(p[3] for p in part)
                    if x0 >= left_limit:
                        continue
                    if y0 < CONFIG["HEADER_TOP_PX"]:
                        continue
                    if y1 > H - CONFIG["FOOTER_BOT_PX"]:
                        continue

                    # Additional guard from Bug 2b: accept only if EITHER
                    # (i) the label is the whole line, OR
                    # (ii) another token on this line starts to the right
                    #      of the left column (i.e. it's the label + question
                    #      text continuing on the same visual line).
                    other_x_min = None
                    for k, w in enumerate(ws):
                        if i <= k < j:
                            continue
                        other_x_min = min(other_x_min, w[0]) \
                            if other_x_min is not None else w[0]
                    if len(ws) > (j - i) + 1 and other_x_min is not None:
                        if other_x_min <= 0.15 * W:
                            # Not truly a right-hand question line; skip
                            continue

                    tx0 = page.rect.x0 + 8
                    tx1 = page.rect.x1 - 8
                    raw_matches.append(QLabel(
                        qno=int(m.group(1)), page_index=pno,
                        y0=y0, y1=y1, x0=x0, x1=x1,
                        table_x0=tx0, table_x1=tx1,
                    ))
                    break

    # ---- consolidate: exactly one per qno ----
    errors: list[str] = []
    per_qno: dict[int, list[QLabel]] = {}
    for lb in raw_matches:
        per_qno.setdefault(lb.qno, []).append(lb)

    labels: list[QLabel] = []
    for qno in sorted(per_qno):
        matches = per_qno[qno]
        if len(matches) == 1:
            labels.append(matches[0])
            continue
        pages = sorted({m.page_index for m in matches})
        if len(pages) > 1:
            # Truly ambiguous — ERROR
            coords = ", ".join(
                f"p{m.page_index} y={m.y0:.0f}" for m in matches
            )
            errors.append(
                f"Q{qno}: matched {len(matches)} times across pages "
                f"{pages} at [{coords}] — cannot disambiguate"
            )
            labels.append(matches[0])  # keep one for now
        else:
            # Same page, multiple matches — pick earliest y and log INFO
            matches.sort(key=lambda m: m.y0)
            log(f"  · info: Q{qno} matched {len(matches)} times on "
                f"p{matches[0].page_index}; kept first (y={matches[0].y0:.0f})")
            labels.append(matches[0])

    labels.sort(key=lambda l: (l.page_index, l.y0))
    return labels, errors


# =========================================================================== #
# Cropping (unchanged)
# =========================================================================== #

def horizontal_borders(page) -> list[float]:
    ys: list[float] = []
    for d in page.get_drawings():
        for it in d.get("items", []):
            if it[0] == "l":
                p1, p2 = it[1], it[2]
                if abs(p1.y - p2.y) < 1.0 and abs(p1.x - p2.x) > 40:
                    ys.append(round((p1.y + p2.y) / 2.0, 1))
            elif it[0] == "re":
                r = it[1]
                if r.height <= 2 and r.width > 40:
                    ys.append(round(r.y0, 1))
    return sorted(set(ys))


def last_nonempty_y(page, y_start, y_end, x0, x1) -> float:
    max_text_y = y_start
    for w in page.get_text("words"):
        wy0, wy1, wx0 = w[1], w[3], w[0]
        if wy0 < y_start or wy0 > y_end:
            continue
        if wx0 < x0 - 4 or wx0 > x1 + 4:
            continue
        if (wy1 - wy0) >= CONFIG["ROW_EMPTY_TEXT_PIX"]:
            if wy1 > max_text_y:
                max_text_y = wy1
    max_img_y = y_start
    for info in page.get_image_info():
        ix0, iy0, ix1, iy1 = info["bbox"]
        if iy1 < y_start or iy0 > y_end:
            continue
        if ix1 < x0 - 4 or ix0 > x1 + 4:
            continue
        if (iy1 - iy0) >= CONFIG["ROW_EMPTY_IMAGE_PIX"]:
            if iy1 > max_img_y:
                max_img_y = iy1
    return max(max_text_y, max_img_y)


def snap_to_border(y, borders, tol):
    best, best_d = y, tol
    for b in borders:
        d = abs(b - y)
        if d < best_d:
            best, best_d = b, d
    return best


def compute_crops(doc, labels: list[QLabel]):
    by_page: dict[int, list[QLabel]] = {}
    for lb in labels:
        by_page.setdefault(lb.page_index, []).append(lb)
    for p in by_page:
        by_page[p].sort(key=lambda l: l.y0)

    out = []
    for pno in sorted(by_page):
        page = doc[pno]
        W, H = page.rect.width, page.rect.height
        borders = horizontal_borders(page)
        group = by_page[pno]

        for i, lb in enumerate(group):
            top = max(lb.y0 - CONFIG["PAD_TOP"], CONFIG["HEADER_TOP_PX"])
            if i + 1 < len(group):
                bottom_limit = group[i + 1].y0 - CONFIG["PAD_TOP"]
            else:
                bottom_limit = H - CONFIG["FOOTER_BOT_PX"]

            last_y = last_nonempty_y(
                page, top, bottom_limit, lb.table_x0, lb.table_x1
            )
            if last_y < top + 2:
                last_y = min(bottom_limit, lb.y1 + CONFIG["MIN_CROP_HEIGHT_PX"])

            snapped = snap_to_border(last_y, borders,
                                     CONFIG["SNAP_TO_BORDER_PX"])
            bottom = min(snapped + CONFIG["PAD_BOTTOM"], bottom_limit)
            if bottom - top < CONFIG["MIN_CROP_HEIGHT_PX"]:
                bottom = min(top + CONFIG["MIN_CROP_HEIGHT_PX"], H)

            rect = fitz.Rect(lb.table_x0, top, lb.table_x1, bottom)
            out.append((lb, [(pno, rect)]))
    return out


# =========================================================================== #
# BUG 3 — Rendering with Pillow (single warning, correct extension)
# =========================================================================== #

_WEBP_WARNED = {"once": False}


def _pix_to_webp(pix, quality: int) -> Optional[bytes]:
    """Convert a fitz.Pixmap to WebP bytes via Pillow. Returns None if unable."""
    if not _PIL_OK:
        return None
    try:
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        out = io.BytesIO()
        img.save(out, format="WEBP", quality=quality, method=6)
        return out.getvalue()
    except Exception:
        return None


def render_crop(page, rect, zoom: float, want_webp: bool,
                quality: int) -> tuple[bytes, str]:
    """
    Returns (bytes, ext) where ext is 'webp' or 'png' matching the content.
    Falls back silently but warns ONCE for WebP.
    """
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, clip=rect, alpha=False)

    if want_webp:
        webp_bytes = _pix_to_webp(pix, quality)
        if webp_bytes is not None:
            return webp_bytes, "webp"
        if not _WEBP_WARNED["once"]:
            _WEBP_WARNED["once"] = True
            log("WARN: WebP encoding unavailable (Pillow missing or "
                "failed). Falling back to PNG for ALL images.")
    return pix.tobytes("png"), "png"


def clean_watermark_png(png_bytes: bytes) -> bytes:
    try:
        pix = fitz.Pixmap(png_bytes)
        pix = fitz.Pixmap(fitz.csRGB, pix)
        samples = bytearray(pix.samples)
        stride = pix.n
        minc, spread = CONFIG["WM_MIN_CHANNEL"], CONFIG["WM_MAX_SPREAD"]
        for i in range(0, len(samples), stride):
            r, g, b = samples[i], samples[i + 1], samples[i + 2]
            if r >= minc and g >= minc and b >= minc:
                hi, lo = max(r, g, b), min(r, g, b)
                if hi - lo <= spread:
                    samples[i] = samples[i + 1] = samples[i + 2] = 255
        out = fitz.Pixmap(fitz.csRGB, pix.width, pix.height,
                          bytes(samples), False)
        return out.tobytes("png")
    except Exception as e:
        log(f"WARN: watermark clean failed ({e}); using original.")
        return png_bytes


# =========================================================================== #
# Tags / fallback / writers
# =========================================================================== #

def tag_for(qno: int) -> str:
    for lo, hi, tag in CONFIG["TAG_MAP"]:
        if lo <= qno <= hi:
            return tag
    return CONFIG["DEFAULT_TAG"]


def fallback_marks(qno: int) -> float:
    for (lo, hi), m in CONFIG["FALLBACK_MARKS"].items():
        if lo <= qno <= hi:
            return float(m)
    return 1.0


def fallback_section(qno: int) -> str:
    return CONFIG["FALLBACK_SECTION"].get(qno, "AE")


def write_questions_js(path: Path, rows: list[dict]) -> None:
    body = json.dumps(rows, indent=2, ensure_ascii=False)
    path.write_text(
        "// AUTO-GENERATED by convert.py — do not edit by hand.\n"
        "// Answers deliberately NOT included here.\n"
        "window.QUESTIONS = " + body + ";\n",
        encoding="utf-8",
    )


def write_answers_js(path: Path, answers: dict) -> None:
    body = json.dumps(answers, indent=2, ensure_ascii=False)
    path.write_text(
        "// AUTO-GENERATED by convert.py — do not edit by hand.\n"
        "// DO NOT load this file on the exam page.\n"
        "window.ANSWERS = " + body + ";\n",
        encoding="utf-8",
    )


def write_contact_sheet(path: Path, rows: list[dict]) -> None:
    items = []
    for r in rows:
        img_rel = r["image"]
        key_txt = r.get("_key_display", "")
        warn = " ".join(r.get("_warnings", []))
        items.append(f"""
        <div class="card">
          <h3>Q{r['qno']} <span class="type">{r['type']}</span>
              <span class="sec">{r['section']}</span>
              <span class="marks">{r['marks']:g}m</span></h3>
          <div class="key">Key: <b>{key_txt}</b></div>
          <div class="tag">{r['tag']}</div>
          <img src="../{img_rel}" loading="lazy" alt="Q{r['qno']}">
          <div class="warn">{warn}</div>
        </div>""")
    html_doc = f"""<!doctype html>
<meta charset="utf-8">
<title>Contact sheet — verify crops</title>
<style>
  body{{font:14px system-ui,sans-serif;background:#111;color:#eee;margin:16px}}
  h1{{font-size:18px}}
  .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}}
  .card{{background:#1b1b1b;border:1px solid #333;border-radius:8px;padding:10px}}
  .card h3{{margin:0 0 6px;font-size:14px}}
  .type,.sec,.marks{{font-size:11px;background:#333;padding:1px 6px;border-radius:4px;margin-left:4px}}
  .key{{color:#7cf;font-size:12px;margin-bottom:2px}}
  .tag{{color:#fc7;font-size:12px;margin-bottom:6px}}
  img{{max-width:100%;background:#fff;border-radius:4px}}
  .warn{{color:#f88;font-size:11px;margin-top:4px}}
</style>
<h1>Contact sheet — {len(rows)} questions (answers visible, setup only)</h1>
<div class="grid">{''.join(items)}</div>
"""
    path.write_text(html_doc, encoding="utf-8")


# =========================================================================== #
# Main
# =========================================================================== #

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paper", type=Path)
    ap.add_argument("--key", type=Path)
    ap.add_argument("--key-csv", type=Path)
    ap.add_argument("--out-dir", type=Path, default=Path("."))
    ap.add_argument("--png", action="store_true")
    ap.add_argument("--clean-watermark", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--exclude", type=str, default="")
    args = ap.parse_args()

    if not args.paper.exists():
        log(f"ERROR: paper not found: {args.paper}")
        return 2
    if not args.key and not args.key_csv:
        log("ERROR: provide --key or --key-csv")
        return 2
    if args.key and not args.key.exists():
        log(f"ERROR: key not found: {args.key}")
        return 2
    if args.key_csv and not args.key_csv.exists():
        log(f"ERROR: key csv not found: {args.key_csv}")
        return 2

    out_dir: Path = args.out_dir.resolve()
    images_dir = out_dir / "images"
    data_dir = out_dir / "data"
    verify_dir = out_dir / "verify"
    preview_dir = verify_dir / "preview"
    ensure_dir(images_dir)
    ensure_dir(data_dir)
    ensure_dir(verify_dir)

    exclude = {clean_int(x) for x in args.exclude.split(",") if x.strip()}
    exclude = {x for x in exclude if x}

    # ===================================================================== #
    # Step 1 — Answer key
    # ===================================================================== #
    key: dict[int, dict] = {}
    key_failures: list = []
    if args.key:
        key, key_failures = parse_key_pdf(
            args.key,
            debug_path=(verify_dir / "key_rows_debug.txt") if args.report else None,
        )
        print(f"Key rows parsed from PDF: {len(key)} / expected "
              f"{CONFIG['EXPECTED']['total_questions']}")
    if args.key_csv:
        csv_key = parse_key_csv(args.key_csv)
        print(f"Key rows parsed from CSV: {len(csv_key)}")
        for q, row in csv_key.items():
            key.setdefault(q, row)

    if len(key) < CONFIG["EXPECTED"]["total_questions"]:
        log("")
        log(f"ERROR: only {len(key)} key rows parsed, expected "
            f"{CONFIG['EXPECTED']['total_questions']}.")
        log("  Refusing to proceed — fix the key or pass --key-csv.")
        if key_failures:
            log(f"  {len(key_failures)} row(s) failed to parse. "
                f"See verify/key_rows_debug.txt (run with --report).")
        missing = sorted(
            set(range(1, CONFIG["EXPECTED"]["total_questions"] + 1))
            - set(key.keys())
        )
        log(f"  Missing qnos: {missing[:20]}"
            + (" ..." if len(missing) > 20 else ""))
        return 4

    # ===================================================================== #
    # Step 2 — Question labels
    # ===================================================================== #
    doc = fitz.open(str(args.paper))
    try:
        labels, label_errors = find_question_labels(doc)
        print(f"Question labels detected: {len(labels)} / expected "
              f"{CONFIG['EXPECTED']['total_questions']}")
        if label_errors:
            log("")
            log("ERROR: ambiguous question labels:")
            for e in label_errors:
                log("  " + e)
            return 5
        if not labels:
            log("ERROR: no labels found; adjust CONFIG / troubleshooting.")
            return 5

        crops = compute_crops(doc, labels)

        # ================================================================= #
        # Step 3 — Render + build rows
        # ================================================================= #
        want_webp = not args.png
        rows: list[dict] = []
        answers: dict[str, dict] = {}
        missing_key: list[int] = []
        short_crops: list[int] = []
        type_mismatch: list[str] = []
        wm_previews: list[tuple[int, bytes, bytes]] = []
        used_ext: set[str] = set()

        for (lb, pieces) in crops:
            qno = lb.qno
            if qno in exclude:
                log(f"  · skipping Q{qno} (excluded)")
                continue
            qid = f"q{qno:03d}"

            # ---------- Render each page-piece (or stitched) ----------
            if len(pieces) == 1:
                pno, rect = pieces[0]
                img_bytes, ext = render_crop(
                    doc[pno], rect, CONFIG["ZOOM"],
                    want_webp, CONFIG["WEBP_QUALITY"]
                )
                try:
                    if _PIL_OK:
                        with Image.open(io.BytesIO(img_bytes)) as im:
                            pix_w, pix_h = im.width, im.height
                    else:
                        pix = fitz.Pixmap(img_bytes)
                        pix_w, pix_h = pix.width, pix.height
                except Exception:
                    pix_w, pix_h = 0, 0
            else:
                png_pieces = []
                for pno, rect in pieces:
                    mat = fitz.Matrix(CONFIG["ZOOM"], CONFIG["ZOOM"])
                    pix = doc[pno].get_pixmap(matrix=mat, clip=rect, alpha=False)
                    png_pieces.append(pix.tobytes("png"))
                try:
                    pixes = [fitz.Pixmap(b) for b in png_pieces]
                    w = max(p.width for p in pixes)
                    h = sum(p.height for p in pixes) \
                        + CONFIG["PAGE_GAP_PX"] * (len(pixes) - 1)
                    tmp = fitz.open()
                    tpage = tmp.new_page(width=w, height=h)
                    y = 0
                    for p in pixes:
                        tpage.insert_image(
                            fitz.Rect(0, y, p.width, y + p.height),
                            stream=p.tobytes("png"),
                        )
                        y += p.height + CONFIG["PAGE_GAP_PX"]
                    stitched_pix = tpage.get_pixmap(alpha=False)
                    tmp.close()
                    pix_w, pix_h = stitched_pix.width, stitched_pix.height
                    if want_webp:
                        wb = _pix_to_webp(stitched_pix, CONFIG["WEBP_QUALITY"])
                        if wb is not None:
                            img_bytes, ext = wb, "webp"
                        else:
                            img_bytes = stitched_pix.tobytes("png")
                            ext = "png"
                    else:
                        img_bytes = stitched_pix.tobytes("png")
                        ext = "png"
                except Exception as e:
                    log(f"WARN: stitch failed for Q{qno} ({e}); "
                        "using first piece only")
                    img_bytes = png_pieces[0]
                    ext = "png"
                    pix_w = pix_h = 0

            # ---------- Optional watermark cleaning ----------
            if args.clean_watermark:
                before = None
                if args.report and qno in CONFIG["WM_PREVIEW_QNOS"]:
                    if ext == "webp" and _PIL_OK:
                        with Image.open(io.BytesIO(img_bytes)) as im:
                            buf = io.BytesIO()
                            im.convert("RGB").save(buf, format="PNG")
                            before = buf.getvalue()
                    else:
                        before = img_bytes

                if ext == "webp" and _PIL_OK:
                    with Image.open(io.BytesIO(img_bytes)) as im:
                        buf = io.BytesIO()
                        im.convert("RGB").save(buf, format="PNG")
                        src_png = buf.getvalue()
                else:
                    src_png = img_bytes
                cleaned = clean_watermark_png(src_png)
                if ext == "webp":
                    cleaned_pix = fitz.Pixmap(cleaned)
                    wb = _pix_to_webp(cleaned_pix, CONFIG["WEBP_QUALITY"])
                    img_bytes = wb if wb is not None else cleaned
                    ext = "webp" if wb is not None else "png"
                else:
                    img_bytes = cleaned
                if before is not None:
                    wm_previews.append((qno, before, cleaned))

            # ---------- Write image file ----------
            fname = f"{qid}.{ext}"
            (images_dir / fname).write_bytes(img_bytes)
            used_ext.add(ext)

            # ---------- Short-crop warning ----------
            if pix_h and pix_h < CONFIG["MIN_CROP_HEIGHT_PX"]:
                short_crops.append(qno)

            # ---------- Merge key row ----------
            keyrow = key.get(qno)
            if keyrow is None:
                missing_key.append(qno)
                q_type = "UNKNOWN"
                q_section = fallback_section(qno)
                q_marks = fallback_marks(qno)
                key_display = "(missing key — type UNKNOWN)"
                warn = ["missing key; type=UNKNOWN, fallback marks/section"]
            else:
                q_type = keyrow["type"]
                q_section = keyrow["section"]
                q_marks = keyrow["marks"]
                key_display = keyrow["key_raw"]
                warn = []

            public = {
                "id": qid,
                "qno": qno,
                "image": f"images/{fname}",
                "type": q_type,
                "marks": q_marks,
                "section": q_section,
                "tag": tag_for(qno),
            }
            rows.append({**public, "_key_display": key_display,
                         "_warnings": warn})
            answers[qid] = {
                "answer": (keyrow["answer"] if keyrow else {}),
                "explanation": "",
            }

    finally:
        doc.close()

    # ===================================================================== #
    # Step 4 — Write output
    # ===================================================================== #
    public_rows = [{k: v for k, v in r.items() if not k.startswith("_")}
                   for r in rows]
    write_questions_js(data_dir / "questions.js", public_rows)
    write_answers_js(data_dir / "answers.js", answers)

    # ===================================================================== #
    # Step 5 — Validation report
    # ===================================================================== #
    n = len(public_rows)
    mcq = sum(1 for r in public_rows if r["type"] == "MCQ")
    msq = sum(1 for r in public_rows if r["type"] == "MSQ")
    nat = sum(1 for r in public_rows if r["type"] == "NAT")
    ga_marks = sum(r["marks"] for r in public_rows if r["section"] == "GA")
    ae_marks = sum(r["marks"] for r in public_rows if r["section"] == "AE")
    total_marks = sum(r["marks"] for r in public_rows)
    exp = CONFIG["EXPECTED"]

    for q in range(1, exp["total_questions"] + 1):
        r = next((x for x in public_rows if x["qno"] == q), None)
        if r is None or q not in key:
            continue
        if r["type"] != key[q]["type"]:
            type_mismatch.append(
                f"Q{q}: crop-derived {r['type']} vs key {key[q]['type']}"
            )

    print()
    print("=" * 62)
    print("VALIDATION REPORT")
    print("=" * 62)
    print(f"Key rows parsed:    {len(key):d}          "
          f"(expect {exp['total_questions']})")
    print(f"Questions detected: {n}          "
          f"(expect {exp['total_questions']})")
    print(f"Type counts:        MCQ={mcq} MSQ={msq} NAT={nat}   "
          f"(expect {exp['mcq']}/{exp['msq']}/{exp['nat']})")
    print(f"Marks by section:   GA={ga_marks:g} AE={ae_marks:g} "
          f"total={total_marks:g}   "
          f"(expect {exp['ga_marks']}/{exp['ae_marks']}/{exp['total_marks']})")
    print(f"Image extensions:   {sorted(used_ext)}")

    problems: list[str] = []
    if n != exp["total_questions"]:
        problems.append(f"question count {n} != {exp['total_questions']}")
    if (mcq, msq, nat) != (exp["mcq"], exp["msq"], exp["nat"]):
        problems.append(
            f"type counts {mcq}/{msq}/{nat} != "
            f"{exp['mcq']}/{exp['msq']}/{exp['nat']}"
        )
    if abs(ga_marks - exp["ga_marks"]) > 0.01:
        problems.append(f"GA marks {ga_marks:g} != {exp['ga_marks']}")
    if abs(ae_marks - exp["ae_marks"]) > 0.01:
        problems.append(f"AE marks {ae_marks:g} != {exp['ae_marks']}")
    if abs(total_marks - exp["total_marks"]) > 0.01:
        problems.append(f"total marks {total_marks:g} != {exp['total_marks']}")
    if missing_key:
        problems.append(f"missing key for qnos {sorted(missing_key)}")
    if short_crops:
        problems.append(f"short crops for qnos {sorted(short_crops)}")
    if type_mismatch:
        problems.append("type mismatch: " + "; ".join(type_mismatch))

    if problems:
        print("  ! " + "\n  ! ".join(problems))
    else:
        print("  ALL CHECKS PASSED")
    print()

    if args.report:
        write_contact_sheet(verify_dir / "contact_sheet.html", rows)
        if wm_previews:
            ensure_dir(preview_dir)
            for qno, before, after in wm_previews:
                (preview_dir / f"q{qno:03d}_before.png").write_bytes(before)
                (preview_dir / f"q{qno:03d}_after.png").write_bytes(after)
        print(f"Contact sheet:      {verify_dir / 'contact_sheet.html'}")
        print(f"Key debug:          {verify_dir / 'key_rows_debug.txt'}")
        if wm_previews:
            print(f"Watermark previews: {preview_dir}/")
    print(f"Images:             {images_dir}/  ({n} files)")
    print(f"Questions data:     {data_dir / 'questions.js'}")
    print(f"Answers data:       {data_dir / 'answers.js'}  "
          f"(do NOT load on exam page)")
    print()

    return 0 if not problems else 1

if __name__ == "__main__":
    sys.exit(main())
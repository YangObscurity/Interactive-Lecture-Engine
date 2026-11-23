#!/usr/bin/env python3
"""
Import and register a group-managed figure (WP-F8).

Reuses system tools already installed on the preparation host:
  - poppler (`pdfinfo`, `pdfimages`, `pdftocairo -svg`, `pdftoppm`)
  - ImageMagick 7 (`magick` with libwebp)
  - Ghostscript (`gs`, optional when cropping vector PDFs before SVG export)

Never relies on PyMuPDF or cwebp. Never imports browser-side PDF renderers.
Resolves the default `<figuresDir>` via `site/docs/.vitepress/content/paths.mts`
unless `--figures-dir` is explicitly provided.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SITE_DIR = REPO_ROOT / "site"
PATHS_MTS = SITE_DIR / "docs" / ".vitepress" / "content" / "paths.mts"

ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")
GROUP_RE = re.compile(r"^[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*$")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
PCT_RE = re.compile(r"%[0-9a-fA-F]{2}")
ALLOWED_OUT_EXTS = (".svg", ".webp", ".png", ".jpg", ".jpeg")


def validate_rel_path(raw: str, allowed_exts: tuple[str, ...] = ALLOWED_OUT_EXTS) -> str:
    if not raw or raw != raw.strip():
        raise ValueError(f"Invalid relative path (empty or whitespace-padded): {raw!r}")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw):
        raise ValueError(f"Control character in relative path: {raw!r}")
    for candidate in (raw, urllib.parse.unquote(raw)):
        if "\\" in candidate or "?" in candidate or "#" in candidate:
            raise ValueError(f"Unsafe delimiter in relative path: {raw!r}")
        if candidate.startswith("/") or (len(candidate) >= 2 and candidate[1] == ":" and candidate[0].isalpha()):
            raise ValueError(f"Absolute path not allowed: {raw!r}")
        if SCHEME_RE.match(candidate) or "//" in candidate:
            raise ValueError(f"Protocol or double slash not allowed: {raw!r}")
        if any(seg in ("", ".", "..") for seg in candidate.split("/")):
            raise ValueError(f"Relative escape segment not allowed: {raw!r}")
    if "%" in raw:
        dec = urllib.parse.unquote(raw)
        if dec != raw and ("%" in dec or PCT_RE.search(dec)):
            raise ValueError(f"Repeated percent-encoding not allowed: {raw!r}")
    if not raw.lower().endswith(allowed_exts):
        raise ValueError(f"Unsupported extension in {raw!r}; allowed: {', '.join(allowed_exts)}")
    return raw


def resolve_default_figures_dir() -> Path:
    cmd = [
        "node",
        "--input-type=module",
        "-e",
        (
            f"import {{ resolveContent }} from {json.dumps(PATHS_MTS.as_uri())};"
            "console.log(resolveContent().figuresDir);"
        ),
    ]
    res = subprocess.run(cmd, cwd=str(SITE_DIR), capture_output=True, text=True, check=True)
    out = res.stdout.strip().splitlines()[-1].strip()
    if not out:
        raise RuntimeError("Failed to resolve figuresDir from content/paths.mts")
    return Path(out)


def run_cmd(cmd: list[str], cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr.strip()}")
    return proc.stdout


def parse_crop_fractions(raw: str | None) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise ValueError("--crop expects 4 comma-separated fractions in [0,1]: x0,y0,x1,y1")
    x0, y0, x1, y1 = (float(p) for p in parts)
    if not (0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0):
        raise ValueError(f"Invalid --crop box (need 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1): {raw}")
    return (x0, y0, x1, y1)


def parse_pdf_page_size(pdf_path: Path, page: int) -> tuple[float, float]:
    out = run_cmd(["pdfinfo", "-f", str(page), "-l", str(page), "-box", str(pdf_path)])
    for pattern in (
        r"Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts",
        r"Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts",
        r"CropBox:\s+[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)",
    ):
        m = re.search(pattern, out)
        if m:
            return (float(m.group(1)), float(m.group(2)))
    raise RuntimeError(f"Could not determine PDF page size for {pdf_path} page {page}")


def pdf_has_raster_images(pdf_path: Path, page: int) -> bool:
    out = run_cmd(["pdfimages", "-list", "-f", str(page), "-l", str(page), str(pdf_path)])
    for line in out.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("page ") or stripped.startswith("-"):
            continue
        cols = stripped.split()
        if len(cols) >= 3 and cols[0].isdigit() and cols[2] in ("image", "smask"):
            return True
    return False


def parse_svg_size(svg_path: Path) -> tuple[int, int]:
    root = ET.parse(svg_path).getroot()
    def parse_len(val: str | None) -> float | None:
        if not val:
            return None
        m = re.match(r"^\s*([\d.]+)(?:px|pt)?\s*$", val)
        return float(m.group(1)) if m else None

    w = parse_len(root.attrib.get("width"))
    h = parse_len(root.attrib.get("height"))
    vb = root.attrib.get("viewBox")
    if (w is None or h is None) and vb:
        nums = [float(x) for x in re.split(r"[\s,]+", vb.strip()) if x]
        if len(nums) == 4:
            w = w or nums[2]
            h = h or nums[3]
    if not w or not h or w <= 0 or h <= 0:
        raise RuntimeError(f"Cannot extract SVG dimensions from {svg_path}")
    return (max(1, round(w)), max(1, round(h)))


def inspect_raster_size(img_path: Path) -> tuple[int, int]:
    out = run_cmd(["magick", "identify", "-format", "%w %h", str(img_path)]).strip()
    w_s, h_s = out.split()[:2]
    return (int(w_s), int(h_s))


def sha256_first12(path: Path) -> str:
    """Registry checksum. SVG is text: CRLF is folded to LF (a Windows checkout rewrites line endings), as the site check does."""
    data = path.read_bytes()
    if path.suffix.lower() == ".svg":
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()[:12]


def prepare_svg_from_pdf(
    pdf_path: Path,
    page: int,
    crop: tuple[float, float, float, float] | None,
    dest_svg: Path,
) -> None:
    dest_svg.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lec-fig-svg-") as tmp_str:
        tmp = Path(tmp_str)
        src_for_cairo = pdf_path
        cairo_page = page
        if crop is not None:
            w_pt, h_pt = parse_pdf_page_size(pdf_path, page)
            x0, y0, x1, y1 = crop
            # PDF user-space origin is bottom-left; `--crop` uses top-left normalized coordinates.
            llx = x0 * w_pt
            urx = x1 * w_pt
            lly = (1.0 - y1) * h_pt
            ury = (1.0 - y0) * h_pt
            gs_bin = shutil.which("gs")
            if not gs_bin:
                raise RuntimeError("Ghostscript (`gs`) is required for cropping vector PDFs")
            cropped_pdf = tmp / "cropped.pdf"
            run_cmd([
                gs_bin,
                "-q",
                "-o",
                str(cropped_pdf),
                "-sDEVICE=pdfwrite",
                f"-dFirstPage={page}",
                f"-dLastPage={page}",
                "-c",
                f"[/CropBox [{llx:.3f} {lly:.3f} {urx:.3f} {ury:.3f}] /PAGES pdfmark",
                "-f",
                str(pdf_path),
            ])
            src_for_cairo = cropped_pdf
            cairo_page = 1
        out_raw = tmp / "out.svg"
        run_cmd([
            "pdftocairo",
            "-svg",
            "-f",
            str(cairo_page),
            "-l",
            str(cairo_page),
            str(src_for_cairo),
            str(out_raw),
        ])
        shutil.copy2(out_raw, dest_svg)


def prepare_webp_from_pdf(
    pdf_path: Path,
    page: int,
    crop: tuple[float, float, float, float] | None,
    target_width: int,
    quality: int,
    trim: bool,
    fuzz_pct: float,
    dest_webp: Path,
) -> None:
    w_pt, h_pt = parse_pdf_page_size(pdf_path, page)
    crop_w_pt = ((crop[2] - crop[0]) * w_pt) if crop else w_pt
    # Render at least 300 ppi (or higher to hit target_width = 2x display width), clamped to 600 ppi.
    needed_dpi = math.ceil(target_width * 72.0 / max(crop_w_pt, 1.0))
    dpi = max(300, min(600, needed_dpi))
    dest_webp.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lec-fig-pdf-") as tmp_str:
        tmp = Path(tmp_str)
        prefix = tmp / "page"
        cmd = ["pdftoppm", "-png", "-r", str(dpi), "-f", str(page), "-l", str(page), "-cropbox"]
        if crop is not None:
            px_w = round(w_pt * dpi / 72.0)
            px_h = round(h_pt * dpi / 72.0)
            cx = round(crop[0] * px_w)
            cy = round(crop[1] * px_h)
            cw = max(1, round((crop[2] - crop[0]) * px_w))
            ch = max(1, round((crop[3] - crop[1]) * px_h))
            cmd += ["-x", str(cx), "-y", str(cy), "-W", str(cw), "-H", str(ch)]
        cmd += [str(pdf_path), str(prefix)]
        run_cmd(cmd)
        pngs = sorted(tmp.glob("page-*.png"))
        if not pngs:
            raise RuntimeError(f"pdftoppm produced no output for {pdf_path}")
        convert_raster_to_webp(pngs[0], None, target_width, quality, trim, fuzz_pct, dest_webp)


def convert_raster_to_webp(
    src_img: Path,
    crop: tuple[float, float, float, float] | None,
    target_width: int,
    quality: int,
    trim: bool,
    fuzz_pct: float,
    dest_webp: Path,
) -> None:
    dest_webp.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["magick", str(src_img)]
    if crop is not None:
        w_px, h_px = inspect_raster_size(src_img)
        x0, y0, x1, y1 = crop
        cx = max(0, round(x0 * w_px))
        cy = max(0, round(y0 * h_px))
        cw = max(1, round((x1 - x0) * w_px))
        ch = max(1, round((y1 - y0) * h_px))
        cmd += ["-crop", f"{cw}x{ch}+{cx}+{cy}", "+repage"]
    if trim:
        cmd += ["-fuzz", f"{fuzz_pct}%", "-trim", "+repage"]
    cmd += [
        "-strip",
        "-resize",
        f"{target_width}x>",
        "-quality",
        str(quality),
        str(dest_webp),
    ]
    run_cmd(cmd)


def update_registry(registry_path: Path, group: str, entry: dict[str, Any]) -> None:
    if registry_path.exists():
        reg = json.loads(registry_path.read_text(encoding="utf-8"))
    else:
        reg = {"version": 1, "group": group, "figures": []}

    if reg.get("group") != group:
        raise RuntimeError(f"Registry group mismatch in {registry_path}: {reg.get('group')!r} != {group!r}")

    figures: list[dict[str, Any]] = reg.get("figures", [])
    replaced = False
    for idx, cur in enumerate(figures):
        if cur.get("id") == entry["id"]:
            if cur.get("file") != entry["file"]:
                raise RuntimeError(
                    f"Refusing to overwrite existing figure id {entry['id']!r}: "
                    f"registered file is {cur.get('file')!r}, attempted {entry['file']!r}"
                )
            figures[idx] = entry
            replaced = True
            break
    if not replaced:
        figures.append(entry)

    tmp_path = registry_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, registry_path)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Prepare and register a figure/table in <figuresDir>/<group>/figures.json")
    p.add_argument("--source", required=True, type=Path, help="Input PDF, SVG, or raster image path")
    p.add_argument("--group", required=True, help="Target group directory name (e.g. lr, examples/g01)")
    p.add_argument("--id", required=True, help="Unique figure id within group")
    p.add_argument("--out-rel", help="Relative output file inside group dir (e.g. L01/hearthnet-arch.webp)")
    p.add_argument("--kind", choices=("figure", "table"), default="figure")
    p.add_argument("--mode", choices=("auto", "vector", "raster"), default="auto")
    p.add_argument("--page", type=int, default=1, help="1-based PDF page number (default: 1)")
    p.add_argument("--crop", help="Normalized crop box x0,y0,x1,y1 in [0,1] from top-left")
    p.add_argument("--width", type=int, default=1440, help="Max 2x raster width in pixels (default: 1440)")
    p.add_argument("--quality", type=int, default=88, help="WebP quality (default: 88)")
    p.add_argument("--trim", action="store_true", help="Trim outer whitespace margins after crop")
    p.add_argument("--fuzz", type=float, default=3.0, help="Color fuzz percentage for --trim (default: 3.0)")
    p.add_argument("--figures-dir", type=Path, help="Override resolved <figuresDir> from content/paths.mts")
    p.add_argument("--keep-original", action="store_true", help="Copy raw source file under originals/ and record `original`")
    p.add_argument("--caption-zh", required=True, help="Chinese figure caption")
    p.add_argument("--caption-en", required=True, help="English figure caption")
    p.add_argument("--paper", required=True, help="Source paper key or 'original'")
    p.add_argument("--source-num", help="Original figure/table number (e.g. 'Fig. 1')")
    p.add_argument("--source-page", help="Original page number in source paper")
    p.add_argument("--doi", help="Optional DOI (10.xxxx/...)")
    p.add_argument("--url", help="Optional source URL")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    src = args.source.resolve()
    if not src.is_file():
        raise SystemExit(f"Source file not found: {src}")
    if not GROUP_RE.match(args.group):
        raise SystemExit(f"Invalid group name: {args.group!r}")
    if not ID_RE.match(args.id):
        raise SystemExit(f"Invalid figure id: {args.id!r}")

    crop = parse_crop_fractions(args.crop)
    src_ext = src.suffix.lower()

    if args.mode == "auto":
        if src_ext == ".svg":
            mode = "svg-copy"
        elif src_ext == ".pdf":
            mode = "raster" if pdf_has_raster_images(src, args.page) else "vector"
        else:
            mode = "raster"
    elif args.mode == "vector":
        if src_ext == ".svg":
            mode = "svg-copy"
        elif src_ext == ".pdf":
            mode = "vector"
        else:
            raise SystemExit(f"Vector mode requires PDF or SVG input, got {src_ext}")
    else:
        mode = "raster"

    out_ext = ".svg" if mode in ("vector", "svg-copy") else ".webp"
    default_rel = f"{args.id}{out_ext}"
    rel_file = validate_rel_path(args.out_rel or default_rel)

    if out_ext == ".svg" and not rel_file.lower().endswith(".svg"):
        raise SystemExit(f"Vector output must end with .svg, got {rel_file!r}")
    if out_ext == ".webp" and not rel_file.lower().endswith(".webp"):
        raise SystemExit(f"Raster output must end with .webp, got {rel_file!r}")

    figures_root = (args.figures_dir.resolve() if args.figures_dir else resolve_default_figures_dir())
    group_dir = figures_root.joinpath(*args.group.split("/"))
    group_dir.mkdir(parents=True, exist_ok=True)
    registry_path = group_dir / "figures.json"
    dest_file = group_dir / rel_file

    # Check overwrite rule BEFORE writing output bytes so refusal leaves existing assets untouched.
    if registry_path.exists():
        cur_reg = json.loads(registry_path.read_text(encoding="utf-8"))
        for cur in cur_reg.get("figures", []):
            if cur.get("id") == args.id and cur.get("file") != rel_file:
                raise SystemExit(
                    f"Refusing to overwrite existing figure id {args.id!r} "
                    f"(existing file={cur.get('file')!r}, requested file={rel_file!r})"
                )

    if mode == "svg-copy":
        dest_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_file)
        w_px, h_px = parse_svg_size(dest_file)
    elif mode == "vector":
        prepare_svg_from_pdf(src, args.page, crop, dest_file)
        w_px, h_px = parse_svg_size(dest_file)
    else:
        if src_ext == ".pdf":
            prepare_webp_from_pdf(src, args.page, crop, args.width, args.quality, args.trim, args.fuzz, dest_file)
        else:
            convert_raster_to_webp(src, crop, args.width, args.quality, args.trim, args.fuzz, dest_file)
        w_px, h_px = inspect_raster_size(dest_file)

    digest = sha256_first12(dest_file)
    orig_rel: str | None = None
    if args.keep_original:
        orig_rel = validate_rel_path(f"originals/{args.id}{src_ext}", (".pdf", ".svg", ".webp", ".png", ".jpg", ".jpeg"))
        orig_dest = group_dir / orig_rel
        orig_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, orig_dest)

    source_obj: dict[str, Any] = {"paper": args.paper}
    if args.source_num:
        source_obj["number"] = args.source_num
    if args.source_page is not None and args.source_page != "":
        source_obj["page"] = int(args.source_page) if args.source_page.isdigit() else args.source_page

    entry: dict[str, Any] = {
        "id": args.id,
        "file": rel_file,
        "kind": args.kind,
        "width": w_px,
        "height": h_px,
        "caption": {"zh": args.caption_zh, "en": args.caption_en},
        "source": source_obj,
        "sha256": digest,
    }
    if args.doi:
        entry["doi"] = args.doi
    if args.url:
        entry["url"] = args.url
    if orig_rel:
        entry["original"] = orig_rel

    update_registry(registry_path, args.group, entry)
    print(f"[import_figure] {args.group}/{args.id} -> {rel_file} ({w_px}x{h_px}, sha256={digest})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

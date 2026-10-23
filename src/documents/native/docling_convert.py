"""
Layout-aware document conversion, one NDJSON line per input file.

Why this exists next to ocr.py's job rather than replacing it: OCR answers "what characters are on
this page", and that is not the same question as "what is this document". A thickness table read by
a recognizer arrives as a run of numbers with the column headers three lines above and no link
between them; the same table read by a layout model arrives as rows. Retrieval over the first is
what produces confident, unusable answers about equipment tags that were never in that column.

Contract, deliberately narrow so the TypeScript side can stay dumb:

  * stdin/argv: absolute input paths.
  * stdout: exactly one JSON object per line, in input order, ALWAYS one per input even on failure.
  * stderr: diagnostics only. Never parsed.
  * exit code: 0 if every file converted, 1 if any failed. The caller parses stdout either way,
    because one bad file in a 200-file drop must not discard the other 199.

Docling's Python API has moved more than once. Everything below is written against the surface that
has been stable (DocumentConverter -> result.document -> export_to_markdown), with the richer
per-page and per-table paths attempted and degraded from rather than assumed.
"""

import json
import sys
import traceback


def _page_texts(doc):
    """
    Group text items by the page they were found on.

    Page numbers are the whole point of this helper — a citation that cannot name a page is not a
    citation — so an item whose provenance is missing is attributed to page 0 and the caller can
    see that it was unplaced rather than silently inheriting its neighbour's page.
    """
    pages = {}
    try:
        items = doc.iterate_items()
    except Exception:
        return None

    for entry in items:
        item = entry[0] if isinstance(entry, tuple) else entry
        text = getattr(item, "text", None)
        if not text or not str(text).strip():
            continue
        page_no = 0
        prov = getattr(item, "prov", None)
        if prov:
            try:
                page_no = int(getattr(prov[0], "page_no", 0) or 0)
            except Exception:
                page_no = 0
        pages.setdefault(page_no, []).append(str(text))
    return pages


def _tables(doc):
    """Tables as markdown, keyed by page. Markdown keeps the row/column structure the layout model
    recovered, which is the only reason to run this instead of OCR."""
    out = {}
    for table in getattr(doc, "tables", None) or []:
        page_no = 0
        prov = getattr(table, "prov", None)
        if prov:
            try:
                page_no = int(getattr(prov[0], "page_no", 0) or 0)
            except Exception:
                page_no = 0
        rendered = None
        for attempt in ("export_to_markdown",):
            fn = getattr(table, attempt, None)
            if not fn:
                continue
            try:
                rendered = fn(doc)
            except TypeError:
                try:
                    rendered = fn()
                except Exception:
                    rendered = None
            except Exception:
                rendered = None
            if rendered:
                break
        if rendered:
            out.setdefault(page_no, []).append(str(rendered))
    return out


def convert_one(converter, path):
    result = converter.convert(path)
    doc = result.document

    pages = _page_texts(doc)
    tables = _tables(doc)

    if pages is None:
        # No per-item iteration on this Docling build. Fall back to whole-document markdown, and say
        # so: a segment with no page is still useful, but the caller must not cite a page it never
        # received.
        markdown = doc.export_to_markdown()
        return {
            "path": path,
            "ok": True,
            "paged": False,
            "pages": [{"page": 0, "text": markdown, "tables": []}],
            "error": None,
        }

    numbers = sorted(set(list(pages.keys()) + list(tables.keys())))
    return {
        "path": path,
        "ok": True,
        "paged": True,
        "pages": [
            {
                "page": n,
                "text": "\n".join(pages.get(n, [])),
                "tables": tables.get(n, []),
            }
            for n in numbers
        ],
        "error": None,
    }


def prefetch():
    """
    Download the layout and table models now, so conversion never needs the network.

    This matters more than it looks. `extract.ts` states that nothing in the extraction path reaches
    the network and that it is safe under --sovereign. Docling fetches its weights lazily on first
    convert, which would quietly make that false the first time somebody ingested a PDF on an
    air-gapped box — and the failure would arrive as a hung conversion, not as a clear refusal. So
    the download happens at install time, where a human is present and the network is expected.
    """
    try:
        from docling.utils.model_downloader import download_models

        download_models()
        return 0
    except Exception:
        # Older builds have no downloader module. Constructing a converter pulls the same weights,
        # so fall back to that rather than reporting success we did not achieve.
        try:
            from docling.document_converter import DocumentConverter

            DocumentConverter()
            return 0
        except Exception as exc:
            print(json.dumps({"error": f"model prefetch failed: {exc}"}), file=sys.stderr)
            return 1


def main(argv):
    args = argv[1:]
    if args and args[0] == "--prefetch":
        return prefetch()

    paths = args
    if not paths:
        return 0

    try:
        from docling.document_converter import DocumentConverter
    except Exception as exc:  # pragma: no cover - exercised only without the venv
        for path in paths:
            print(json.dumps({"path": path, "ok": False, "pages": [], "error": f"docling unavailable: {exc}"}), flush=True)
        return 1

    converter = DocumentConverter()
    failed = False
    for path in paths:
        try:
            print(json.dumps(convert_one(converter, path)), flush=True)
        except Exception as exc:
            failed = True
            print(traceback.format_exc(), file=sys.stderr)
            print(json.dumps({"path": path, "ok": False, "pages": [], "error": str(exc)}), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

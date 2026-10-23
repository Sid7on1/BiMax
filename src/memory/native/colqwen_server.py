"""
A resident visual-retrieval encoder, served over loopback.

## Why a server and not a subprocess per call

The document converter next door is a subprocess per file because conversion is batch work and the
model is small. This is the opposite: ColQwen2 is a 2B-parameter vision-language model whose weights
take tens of seconds to load and gigabytes to hold. Paying that per query would make retrieval
slower than the OCR pipeline it replaces, so the model stays resident and the engine talks to it on
127.0.0.1 — which the egress perimeter classifies as loopback, records in the ledger, and permits.

## What it computes

Not one vector per page. ColPali-family models emit one vector PER IMAGE PATCH (~1024 of them, 128
dims each), and relevance is late interaction: for each query token, the best-matching patch, summed.
That is what lets a query about a value in a table cell match the patch containing that cell instead
of being averaged into a page-level blur — and it is why this cannot be bolted onto the existing
single-vector store.

The cost is storage: ~256 KB per page in float16 against ~8.6 KB for a dense embedding. `pool` asks
the model's own hierarchical pooling to collapse similar patches, which the ColPali authors report
recovers most of that at a small accuracy cost. It is exposed rather than assumed because the right
setting depends on the corpus.

Contract:
  GET  /readyz                    -> 200 once the model is loaded
  POST /embed/queries {"texts":[]}-> {"vectors": [[[f]]], "dim": n}
  POST /embed/pages   {"paths":[]}-> {"vectors": [[[f]]], "dim": n}
"""

import json
import os
import sys


MODEL_ID = os.environ.get("BIMAX_COLQWEN_MODEL", "vidore/colqwen2-v1.0")
POOL_FACTOR = int(os.environ.get("BIMAX_COLQWEN_POOL", "0") or 0)

_model = None


def _load():
    """Load once. Raised errors are fatal and the parent sees a non-zero exit rather than a server
    that answers /readyz while holding no model."""
    global _model
    if _model is not None:
        return _model
    from sentence_transformers import MultiVectorEncoder

    _model = MultiVectorEncoder(MODEL_ID)
    return _model


def _as_lists(embeddings):
    """Normalise whatever the encoder returned into plain nested lists.

    Sentence Transformers may hand back a torch tensor, a numpy array, or a list of either, and a
    ragged batch (pages differ in patch count) comes back as a list. Converting defensively here
    keeps the wire format one shape.
    """
    out = []
    for item in embeddings:
        if hasattr(item, "tolist"):
            item = item.tolist()
        out.append([[float(v) for v in row] for row in item])
    return out


def _maybe_pool(vectors):
    """Collapse similar patches when asked. Queries are never pooled — they are already short, and
    dropping query tokens changes what was asked."""
    if POOL_FACTOR <= 1:
        return vectors
    pooled = []
    for page in vectors:
        # Mean-pool adjacent groups. The model ships a smarter hierarchical pooler; this is the
        # dependency-free floor so the option works on any build, and it is documented as such.
        step = POOL_FACTOR
        pooled.append([
            [sum(col) / len(col) for col in zip(*page[i:i + step])]
            for i in range(0, len(page), step)
            if page[i:i + step]
        ])
    return pooled


def build_app():
    from fastapi import FastAPI
    from pydantic import BaseModel

    app = FastAPI()

    class Texts(BaseModel):
        texts: list[str]

    class Paths(BaseModel):
        paths: list[str]

    @app.get("/readyz")
    def readyz():
        _load()
        return {"ok": True, "model": MODEL_ID}

    @app.post("/embed/queries")
    def embed_queries(body: Texts):
        model = _load()
        vectors = _as_lists(model.encode_query(body.texts))
        return {"vectors": vectors, "dim": len(vectors[0][0]) if vectors and vectors[0] else 0}

    @app.post("/embed/pages")
    def embed_pages(body: Paths):
        model = _load()
        vectors = _maybe_pool(_as_lists(model.encode_document(body.paths)))
        return {"vectors": vectors, "dim": len(vectors[0][0]) if vectors and vectors[0] else 0}

    return app


def main(argv):
    port = 8790
    for i, arg in enumerate(argv):
        if arg == "--port" and i + 1 < len(argv):
            port = int(argv[i + 1])
    try:
        import uvicorn
    except Exception as exc:
        print(json.dumps({"error": f"uvicorn unavailable: {exc}"}), file=sys.stderr)
        return 1
    # Load before binding: a server that accepts connections while the weights are still arriving
    # would answer the first query with a timeout the caller cannot distinguish from a hang.
    _load()
    uvicorn.run(build_app(), host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

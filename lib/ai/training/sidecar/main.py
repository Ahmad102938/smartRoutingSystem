"""
Ranker sidecar — FastAPI service that holds an XGBoost LambdaRank model in memory and
returns a relevance score per candidate.

Phase 4 scaffold. The model file (model.json) does NOT exist until ~1000 labeled tickets
have accumulated and `train.py` has been run. Until then, this service responds to /health
but /rank returns 503 — the Node client gracefully falls back to the heuristic.

Run locally:
    cd lib/ai/training/sidecar
    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8080
"""

from __future__ import annotations
from pathlib import Path
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_PATH = Path(__file__).parent / "model.json"
MODEL_VERSION_PATH = Path(__file__).parent / "model_version.txt"

app = FastAPI(title="Routing Ranker", version="0.1.0")

_model = None
_model_version = "untrained"


def _load_model():
    """Load XGBoost model from disk if it exists. Reload safely on signal."""
    global _model, _model_version
    if not MODEL_PATH.exists():
        _model = None
        _model_version = "untrained"
        return
    try:
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(str(MODEL_PATH))
        _model = booster
        if MODEL_VERSION_PATH.exists():
            _model_version = MODEL_VERSION_PATH.read_text().strip()
    except Exception as e:
        _model = None
        _model_version = f"load-failed:{e}"


_load_model()


# ---- Pydantic schemas mirror lib/ai/training/feature-builder.ts ----

class Features(BaseModel):
    skill_match: float
    distance_km: float
    distance_score: float
    availability: float
    performance_ratio: float
    priority_high: int
    priority_medium: int
    priority_low: int
    semantic_similarity: float
    asset_history_good_ratio: float
    asset_history_total: int
    was_exploration: int
    hour_of_day: int
    day_of_week: int
    current_load_count: int
    recent_rejections: int


class RankRequest(BaseModel):
    features: List[Features]
    request_id: Optional[str] = None


class RankResponse(BaseModel):
    scores: List[float]
    model_version: str


# ---- Endpoints ----

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None, "version": _model_version}


@app.post("/reload")
def reload():
    """Hot-reload the model from disk. Called by the retrain pipeline after a new model is written."""
    _load_model()
    return {"version": _model_version, "loaded": _model is not None}


@app.post("/rank", response_model=RankResponse)
def rank(req: RankRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    feature_keys = list(Features.model_fields.keys())
    matrix = np.array(
        [[getattr(f, k) for k in feature_keys] for f in req.features],
        dtype=np.float32
    )

    import xgboost as xgb
    dmatrix = xgb.DMatrix(matrix, feature_names=feature_keys)
    scores = _model.predict(dmatrix)
    return RankResponse(scores=[float(s) for s in scores], model_version=_model_version)

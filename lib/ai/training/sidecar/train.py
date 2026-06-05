"""
Train an XGBoost LambdaRank model from training_data.jsonl produced by exporter.ts.

Usage:
    npx tsx lib/ai/training/exporter.ts > training_data.jsonl
    cd lib/ai/training/sidecar
    python train.py ../../training_data.jsonl

Gating: this script will refuse to train on fewer than 200 labeled rows. Cold-start
realistically needs ~1000 to be useful.
"""

from __future__ import annotations
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

MIN_LABELED_ROWS = 200

FEATURE_COLUMNS = [
    "skill_match",
    "distance_km",
    "distance_score",
    "availability",
    "performance_ratio",
    "priority_high",
    "priority_medium",
    "priority_low",
    "semantic_similarity",
    "asset_history_good_ratio",
    "asset_history_total",
    "was_exploration",
    "hour_of_day",
    "day_of_week",
    "current_load_count",
    "recent_rejections",
]


def load_jsonl(path: Path) -> pd.DataFrame:
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return pd.DataFrame(rows)


def main(jsonl_path: str):
    df = load_jsonl(Path(jsonl_path))
    print(f"Loaded {len(df)} rows total")

    # Only the picked candidates have labels (1=good outcome, 0=bad). The unpicked rows
    # are counterfactuals — we can use them later for IPS-corrected ranking, but the v1
    # model just trains pointwise on labeled rows.
    labeled = df[df["label"].notna()].copy()
    print(f"  → {len(labeled)} labeled rows")

    if len(labeled) < MIN_LABELED_ROWS:
        print(f"Refusing to train: need ≥{MIN_LABELED_ROWS} labeled rows, have {len(labeled)}.")
        sys.exit(1)

    # Features come from candidate_breakdown (computed at decision time). For the picked
    # candidate, we re-derive the wider feature set from the breakdown plus stored fields.
    # For now, the breakdown JSON has skill_match/availability/proximity/performance/
    # semantic_similarity/asset_history — extend exporter.ts to capture the rest before
    # this script can produce a useful model.
    features_df = pd.json_normalize(labeled["candidate_breakdown"])
    features_df = features_df.reindex(columns=FEATURE_COLUMNS, fill_value=0.0)
    X = features_df.values.astype(np.float32)
    y = labeled["label"].astype(int).values

    print(f"Training on X.shape={X.shape}, label pos rate={y.mean():.3f}")

    dmatrix = xgb.DMatrix(X, label=y, feature_names=FEATURE_COLUMNS)

    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "max_depth": 4,
        "eta": 0.1,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
    }
    booster = xgb.train(params, dmatrix, num_boost_round=200)

    out_dir = Path(__file__).parent
    booster.save_model(str(out_dir / "model.json"))
    version = datetime.utcnow().strftime("v%Y%m%d-%H%M%S")
    (out_dir / "model_version.txt").write_text(version)
    print(f"Saved model.json (version {version})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python train.py training_data.jsonl")
        sys.exit(1)
    main(sys.argv[1])

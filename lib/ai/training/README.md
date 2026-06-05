# Routing Ranker — Phase 4 Scaffold

This directory holds the learned-ranker pipeline. It's **scaffolded but inert** until the
system has accumulated enough labeled data (≈1000 ticket outcomes with moderator
verifications). Until then, [routing-agent.ts](../agents/routing-agent.ts) uses the
deterministic heuristic and ignores the sidecar.

## Components

- **`feature-builder.ts`** — single source of truth for the feature vector. Used at both
  request time and training time, identical inputs produce identical features (no
  train/serve skew).
- **`exporter.ts`** — joins `RoutingDecisionLog × TicketOutcome × TicketRating` into
  per-candidate JSONL rows. Counterfactual candidates (the ones the policy didn't pick)
  carry `label=null`; only picked candidates have ground truth.
- **`ranker-client.ts`** — Node client. Calls the Python sidecar over loopback HTTP with a
  100ms timeout. Disabled by default (`ENABLE_LEARNED_RANKER=1` env to enable).
- **`sidecar/main.py`** — FastAPI service holding the XGBoost model in memory. Hot-reload
  via `POST /reload` after retraining.
- **`sidecar/train.py`** — XGBoost training script. Refuses to run with < 200 labeled rows.

## Lifecycle

1. **Cold start** (months 0-7): heuristic only. `ENABLE_LEARNED_RANKER=0` (default).
2. **First model**: when ≥1000 labeled outcomes exist:
   ```
   npx tsx lib/ai/training/exporter.ts > training_data.jsonl
   cd lib/ai/training/sidecar
   pip install -r requirements.txt
   python train.py ../training_data.jsonl
   uvicorn main:app --host 127.0.0.1 --port 8080
   ```
   Then set `RANKER_SIDECAR_URL=http://127.0.0.1:8080` and `ENABLE_LEARNED_RANKER=1`.
3. **Production**: weekly cron retrains, blue/green swap (Phase 5).

## Why a Python sidecar instead of ONNX-in-Node

XGBoost → ONNX has rough edges around categorical features and missing-value handling. A
Python sidecar lets data folks iterate on the model, eval, and feature engineering without
touching the Node app. At one extra service for the lifetime of one model, the cost is
negligible — re-evaluate when adding a second model.

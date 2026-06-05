import { NextRequest, NextResponse } from 'next/server';
import { exportTrainingData } from '@/lib/ai/training/exporter';
import { rankerClient } from '@/lib/ai/training/ranker-client';

/**
 * Weekly retrain stub. The actual training runs on a separate machine (Python sidecar
 * lifecycle); this endpoint exports the latest training data, hands it off, and triggers
 * a model reload via the sidecar's /reload endpoint.
 *
 * Environment:
 *   CRON_SECRET — shared secret for the X-Cron-Secret header.
 *   RANKER_SIDECAR_URL — base URL of the FastAPI sidecar. If unset, retraining is skipped.
 *   RANKER_TRAINING_EXPORT_URL — optional webhook to POST exported JSONL to (e.g. an S3
 *                                presigned URL). If unset, the endpoint just returns the
 *                                row count for inspection.
 *
 * This is a stub — it does not yet actually train. The training script (sidecar/train.py)
 * runs out-of-band today; this endpoint will eventually orchestrate it via a worker.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 });
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rows = await exportTrainingData({
      since: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    });

    const labeledRows = rows.filter(r => r.label !== null).length;

    let exported = false;
    const exportUrl = process.env.RANKER_TRAINING_EXPORT_URL;
    if (exportUrl) {
      const body = rows.map(r => JSON.stringify(r)).join('\n');
      const res = await fetch(exportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-jsonl' },
        body
      });
      exported = res.ok;
    }

    let reloaded = false;
    if (rankerClient.enabled() && process.env.RANKER_SIDECAR_URL) {
      try {
        const res = await fetch(`${process.env.RANKER_SIDECAR_URL}/reload`, { method: 'POST' });
        reloaded = res.ok;
      } catch {
        reloaded = false;
      }
    }

    return NextResponse.json({
      total_rows: rows.length,
      labeled_rows: labeledRows,
      exported,
      reloaded,
      ready_to_train: labeledRows >= 1000,
      note:
        labeledRows < 1000
          ? `Need ${1000 - labeledRows} more labeled outcomes before training is meaningful.`
          : 'Training set is ready. Run sidecar/train.py.'
    });
  } catch (error) {
    console.error('Retrain cron error:', error);
    return NextResponse.json({ error: 'Failed to export training data' }, { status: 500 });
  }
}

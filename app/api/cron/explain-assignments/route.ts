import { NextRequest, NextResponse } from 'next/server';
import { explainerAgent } from '@/lib/ai/agents/explainer-agent';

/**
 * Cron-triggered worker for the async explainer.
 *
 * Designed to be called every 30-60s by an external scheduler (Vercel Cron, GitHub Actions,
 * etc.) using a shared secret in the X-Cron-Secret header. Picks up any TicketAssignment
 * rows whose explanation_status=PENDING (e.g. ones the orchestrator's fire-and-forget
 * setImmediate failed on, or that piled up during a Gemini outage).
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 });
  }

  const provided = request.headers.get('x-cron-secret');
  if (provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const batchSize = Number(url.searchParams.get('batch') ?? '20');
    const processed = await explainerAgent.processPending(Math.min(50, Math.max(1, batchSize)));
    return NextResponse.json({ processed });
  } catch (error) {
    console.error('Explainer cron error:', error);
    return NextResponse.json({ error: 'Failed to process pending explanations' }, { status: 500 });
  }
}

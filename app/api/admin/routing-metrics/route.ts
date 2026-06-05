import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { computeRoutingMetrics, computeCategoryAccuracy, computeProviderPerformance } from '@/lib/ai/metrics';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (session.user.role !== 'ADMIN' && session.user.role !== 'MODERATOR') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const days = Math.min(365, Math.max(1, Number(searchParams.get('days') ?? '30')));

    const [overall, byCategory, byProvider] = await Promise.all([
      computeRoutingMetrics(days),
      computeCategoryAccuracy(days),
      computeProviderPerformance(days)
    ]);

    return NextResponse.json({ overall, byCategory, byProvider });
  } catch (error) {
    console.error('Routing metrics error:', error);
    return NextResponse.json({ error: 'Failed to compute metrics' }, { status: 500 });
  }
}

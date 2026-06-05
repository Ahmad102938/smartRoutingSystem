import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const UpdateAssetSchema = z.object({
  qr_code: z.string().min(1),
  store_id: z.string().min(1),
  category: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  install_date: z.string().datetime().optional(),
  description: z.string().optional()
});

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const qrCode = searchParams.get('qr_code');
    const storeId = searchParams.get('store_id');

    if (qrCode) {
      const asset = await prisma.asset.findUnique({
        where: { qr_code: qrCode },
        include: {
          tickets: {
            orderBy: { created_at: 'desc' },
            take: 10,
            select: {
              id: true,
              created_at: true,
              ai_classification_category: true,
              ai_classification_subcategory: true,
              status: true
            }
          }
        }
      });
      if (!asset) {
        return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
      }
      return NextResponse.json(asset);
    }

    const assets = await prisma.asset.findMany({
      where: storeId ? { store_id: storeId } : undefined,
      orderBy: { first_seen_at: 'desc' },
      take: 200
    });
    return NextResponse.json(assets);
  } catch (error) {
    console.error('Get assets error:', error);
    return NextResponse.json({ error: 'Failed to fetch assets' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const data = UpdateAssetSchema.parse(body);

    const asset = await prisma.asset.upsert({
      where: { qr_code: data.qr_code },
      update: {
        category: data.category,
        make: data.make,
        model: data.model,
        install_date: data.install_date ? new Date(data.install_date) : undefined,
        description: data.description
      },
      create: {
        qr_code: data.qr_code,
        store_id: data.store_id,
        category: data.category,
        make: data.make,
        model: data.model,
        install_date: data.install_date ? new Date(data.install_date) : undefined,
        description: data.description
      }
    });

    return NextResponse.json(asset);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    console.error('Upsert asset error:', error);
    return NextResponse.json({ error: 'Failed to upsert asset' }, { status: 500 });
  }
}

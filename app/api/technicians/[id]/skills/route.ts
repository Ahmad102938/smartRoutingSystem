import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { requirePermission } from '@/lib/auth/rbac';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const SkillSchema = z.object({
  skill: z.string().min(1).max(100),
  proficiency: z.enum(['NOVICE', 'COMPETENT', 'EXPERT']).default('COMPETENT'),
  years_experience: z.number().int().nonnegative().optional()
});

const PutSkillsSchema = z.object({
  skills: z.array(SkillSchema)
});

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const skills = await prisma.technicianSkill.findMany({
      where: { user_id: params.id },
      orderBy: { skill: 'asc' }
    });

    return NextResponse.json(skills);
  } catch (error) {
    console.error('Get skills error:', error);
    return NextResponse.json({ error: 'Failed to fetch skills' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Self-edit allowed for the technician; otherwise needs skill:update privilege.
    const isSelf = session.user.id === params.id;
    if (!isSelf) {
      await requirePermission('skill', 'update');
    }

    const body = await request.json();
    const data = PutSkillsSchema.parse(body);

    // Replace-set semantics: delete all existing rows for this user, insert the new set.
    // Wrapped in a transaction for atomicity.
    await prisma.$transaction([
      prisma.technicianSkill.deleteMany({ where: { user_id: params.id } }),
      prisma.technicianSkill.createMany({
        data: data.skills.map(s => ({
          user_id: params.id,
          skill: s.skill,
          proficiency: s.proficiency,
          years_experience: s.years_experience
        }))
      })
    ]);

    const skills = await prisma.technicianSkill.findMany({
      where: { user_id: params.id },
      orderBy: { skill: 'asc' }
    });

    return NextResponse.json(skills);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    console.error('Update skills error:', error);
    return NextResponse.json({ error: 'Failed to update skills' }, { status: 500 });
  }
}

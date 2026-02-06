

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, email, password } = body;

    if (!username || !email || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { email }
        ]
      }
    });

    if (existingAdmin) {
      return NextResponse.json({ error: 'Admin user already exists' }, { status: 400 });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Create admin user
    const admin = await prisma.user.create({
      data: {
        username,
        email,
        password_hash,
        role: UserRole.ADMIN,
        registration_status: 'APPROVED',
        is_active: true
      }
    });

    return NextResponse.json({
      message: 'Admin user created successfully',
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        role: admin.role
      }
    });
  } catch (error: any) {
    console.error('Admin creation error:', error);
    return NextResponse.json({ error: 'Failed to create admin user', details: error.message }, { status: 500 });
  }
} 
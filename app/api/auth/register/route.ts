import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UserRole, StoreStatus, ServiceProviderStatus } from '@prisma/client';

import fs from 'fs';
import cloudinary from '@/lib/cloudinary';
import path from 'path';

const StoreRegisterSchema = z.object({
  type: z.literal('store'),
  username: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(8),
  phone_number: z.string().optional(),
  store_name: z.string().min(1),
  store_id: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  zip_code: z.string().min(1),
  latitude: z.string(),
  longitude: z.string()
});

const ServiceProviderRegisterSchema = z.object({
  type: z.literal('service_provider'),
  username: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(8),
  phone_number: z.string().optional(),
  company_name: z.string().min(1),
  unique_company_id: z.string().min(1),
  address: z.string().min(1),
  latitude: z.string(),
  longitude: z.string(),
  skills: z.string(),
  capacity_per_day: z.string()
});

export async function POST(request: NextRequest) {
  try {
    // Upload directory creation removed for Cloudinary migration

    // Convert NextRequest to Node.js request for formidable
    const formData = await request.formData();

    // Helper to get string value from FormData
    const getField = (field: FormDataEntryValue | null) => {
      if (field === null) return '';
      return typeof field === 'string' ? field : field.name;
    };

    const type = getField(formData.get('type'));

    if (!type) {
      return NextResponse.json({ error: 'Missing registration type' }, { status: 400 });
    }

    if (type === 'store') {
      try {
        const validatedData = StoreRegisterSchema.parse({
          type,
          username: getField(formData.get('username')),
          email: getField(formData.get('email')),
          password: getField(formData.get('password')),
          phone_number: getField(formData.get('phone_number')),
          store_name: getField(formData.get('store_name')),
          store_id: getField(formData.get('store_id')),
          address: getField(formData.get('address')),
          city: getField(formData.get('city')),
          state: getField(formData.get('state')),
          zip_code: getField(formData.get('zip_code')),
          latitude: getField(formData.get('latitude')),
          longitude: getField(formData.get('longitude')),
        });

        // Check if username or email already exists
        const existingUser = await prisma.user.findFirst({
          where: {
            OR: [
              { username: validatedData.username },
              { email: validatedData.email }
            ]
          }
        });
        if (existingUser) {
          return NextResponse.json({ error: 'Username or email already exists' }, { status: 400 });
        }

        // Check if store_id already exists
        const existingStore = await prisma.store.findUnique({
          where: { store_id: validatedData.store_id }
        });
        if (existingStore) {
          return NextResponse.json({ error: 'Store ID already exists' }, { status: 400 });
        }

        // Hash password
        const password_hash = await bcrypt.hash(validatedData.password, 12);

        // Create store and user in transaction
        const result = await prisma.$transaction(async (tx) => {
          const store = await tx.store.create({
            data: {
              name: validatedData.store_name,
              store_id: validatedData.store_id,
              address: validatedData.address,
              city: validatedData.city,
              state: validatedData.state,
              zip_code: validatedData.zip_code,
              location_coordinates: {
                latitude: parseFloat(validatedData.latitude),
                longitude: parseFloat(validatedData.longitude)
              },
              status: StoreStatus.PENDING_APPROVAL
            }
          });

          const user = await tx.user.create({
            data: {
              username: validatedData.username,
              email: validatedData.email,
              password_hash,
              phone_number: validatedData.phone_number,
              role: UserRole.STORE_REGISTER,
              associated_store_id: store.id,
              registration_status: 'PENDING',
            }
          });

          // Handle file uploads if any
          const documents = formData.getAll('documents');
          if (documents.length > 0) {
            const uploadPromises = documents
              .filter((doc): doc is File => doc instanceof File)
              .map(async (file) => {
                const buffer = Buffer.from(await file.arrayBuffer());
                const tempPath = path.join('/tmp', `${Date.now()}-${file.name}`);
                await fs.promises.writeFile(tempPath, buffer as any);
                try {
                  const result = await cloudinary.uploader.upload(tempPath, {
                    folder: 'store_documents',
                  });
                  return {
                    url: result.secure_url,
                    type: file.type,
                    userId: user.id
                  };
                } finally {
                  await fs.promises.unlink(tempPath).catch(() => { });
                }
              });

            const documentData = await Promise.all(uploadPromises);

            if (documentData.length > 0) {
              await tx.document.createMany({
                data: documentData
              });
            }
          }

          return { store, user };
        });

        return NextResponse.json({
          message: 'Store registration submitted for approval',
          store_id: result.store.id
        });
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
        }
        return NextResponse.json({ error: 'Registration failed', details: error.message }, { status: 500 });
      }
    }

    if (type === 'service_provider') {
      try {
        const validatedData = ServiceProviderRegisterSchema.parse({
          type,
          username: getField(formData.get('username')),
          email: getField(formData.get('email')),
          password: getField(formData.get('password')),
          phone_number: getField(formData.get('phone_number')),
          company_name: getField(formData.get('company_name')),
          unique_company_id: getField(formData.get('unique_company_id')),
          address: getField(formData.get('address')),
          latitude: getField(formData.get('latitude')),
          longitude: getField(formData.get('longitude')),
          skills: getField(formData.get('skills')),
          capacity_per_day: getField(formData.get('capacity_per_day')),
        });

        // Check if username or email already exists
        const existingUser = await prisma.user.findFirst({
          where: {
            OR: [
              { username: validatedData.username },
              { email: validatedData.email }
            ]
          }
        });
        if (existingUser) {
          return NextResponse.json({ error: 'Username or email already exists' }, { status: 400 });
        }

        // Check if company_id already exists
        const existingProvider = await prisma.serviceProvider.findUnique({
          where: { unique_company_id: validatedData.unique_company_id }
        });
        if (existingProvider) {
          return NextResponse.json({ error: 'Company ID already exists' }, { status: 400 });
        }

        // Hash password
        const password_hash = await bcrypt.hash(validatedData.password, 12);

        // Create service provider and user in transaction
        const result = await prisma.$transaction(async (tx) => {
          const serviceProvider = await tx.serviceProvider.create({
            data: {
              company_name: validatedData.company_name,
              unique_company_id: validatedData.unique_company_id,
              primary_location_address: validatedData.address,
              primary_location_coordinates: {
                latitude: parseFloat(validatedData.latitude),
                longitude: parseFloat(validatedData.longitude)
              },
              skills: validatedData.skills.split(',').map((s: string) => s.trim()),
              capacity_per_day: parseInt(validatedData.capacity_per_day, 10),
              status: ServiceProviderStatus.PENDING_APPROVAL
            }
          });

          const user = await tx.user.create({
            data: {
              username: validatedData.username,
              email: validatedData.email,
              password_hash,
              phone_number: validatedData.phone_number,
              role: UserRole.SERVICE_PROVIDER,
              associated_provider_id: serviceProvider.id,
              registration_status: 'PENDING',
            }
          });

          // Handle file uploads if any
          const documents = formData.getAll('documents');
          if (documents.length > 0) {
            const uploadPromises = documents
              .filter((doc): doc is File => doc instanceof File)
              .map(async (file) => {
                const buffer = Buffer.from(await file.arrayBuffer());
                const tempPath = path.join('/tmp', `${Date.now()}-${file.name}`);
                await fs.promises.writeFile(tempPath, buffer as any);
                try {
                  const result = await cloudinary.uploader.upload(tempPath, {
                    folder: 'provider_documents',
                  });
                  return {
                    url: result.secure_url,
                    type: file.type,
                    userId: user.id
                  };
                } finally {
                  await fs.promises.unlink(tempPath).catch(() => { });
                }
              });

            const documentData = await Promise.all(uploadPromises);

            if (documentData.length > 0) {
              await tx.document.createMany({
                data: documentData
              });
            }
          }

          return { serviceProvider, user };
        });

        return NextResponse.json({
          message: 'Service provider registration submitted for approval',
          provider_id: result.serviceProvider.id
        });
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
        }
        return NextResponse.json({ error: 'Registration failed', details: error.message }, { status: 500 });
      }
    }

    // Moderator/Admin registration (basic, no files)
    if (type === 'moderator' || type === 'admin') {
      const username = getField(formData.get('username'));
      const email = getField(formData.get('email'));
      const password = getField(formData.get('password'));

      if (!username || !email || !password) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
      }

      // Check if username or email already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { username },
            { email }
          ]
        }
      });
      if (existingUser) {
        return NextResponse.json({ error: 'Username or email already exists' }, { status: 400 });
      }

      const password_hash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          username,
          email,
          password_hash,
          role: type === 'admin' ? UserRole.ADMIN : UserRole.MODERATOR
        }
      });

      return NextResponse.json({
        message: `${type.charAt(0).toUpperCase() + type.slice(1)} registration submitted for approval`,
        user_id: user.id
      });
    }

    return NextResponse.json({ error: 'Invalid registration type' }, { status: 400 });
  } catch (error: any) {
    console.error('Registration error:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Registration failed', details: error.message }, { status: 500 });
  }
}

// Admin approval endpoint
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, action, moderator_id } = body;

    if (!userId || !action) {
      return NextResponse.json({ error: 'Missing userId or action' }, { status: 400 });
    }

    // Get the user to approve/reject
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        store: true,
        service_provider: true
      }
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (action === 'APPROVE') {
      // Update user registration status
      await prisma.user.update({
        where: { id: userId },
        data: {
          registration_status: 'APPROVED',
          is_active: true
        }
      });

      // Update associated entity status based on user role
      if (user.role === 'STORE_REGISTER' && user.store) {
        await prisma.store.update({
          where: { id: user.store.id },
          data: {
            status: 'APPROVED',
            approved_at: new Date()
          }
        });
      } else if (user.role === 'SERVICE_PROVIDER' && user.service_provider) {
        // For service providers, check if approved by moderator
        const updateData: any = {
          status: 'APPROVED',
          approved_at: new Date()
        };

        if (moderator_id) {
          // Verify the moderator exists and is assigned to a store
          const moderator = await prisma.user.findUnique({
            where: { id: moderator_id },
            include: { moderated_stores: true }
          });

          if (moderator && moderator.role === 'MODERATOR' && moderator.moderated_stores.length > 0) {
            updateData.approved_by_moderator_id = moderator_id;
          }
        }

        await prisma.serviceProvider.update({
          where: { id: user.service_provider.id },
          data: updateData
        });
      }

      return NextResponse.json({
        message: 'User approved successfully',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          registration_status: 'APPROVED'
        }
      });
    } else if (action === 'REJECT') {
      // Update user registration status
      await prisma.user.update({
        where: { id: userId },
        data: {
          registration_status: 'REJECTED',
          is_active: false
        }
      });

      // Update associated entity status based on user role
      if (user.role === 'STORE_REGISTER' && user.store) {
        await prisma.store.update({
          where: { id: user.store.id },
          data: { status: 'REJECTED' }
        });
      } else if (user.role === 'SERVICE_PROVIDER' && user.service_provider) {
        await prisma.serviceProvider.update({
          where: { id: user.service_provider.id },
          data: { status: 'REJECTED' }
        });
      }

      return NextResponse.json({
        message: 'User rejected successfully',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          registration_status: 'REJECTED'
        }
      });
    } else if (action === 'ACTIVATE') {
      // Activate user account
      await prisma.user.update({
        where: { id: userId },
        data: {
          is_active: true
        }
      });

      return NextResponse.json({
        message: 'User activated successfully',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          is_active: true
        }
      });
    } else if (action === 'DEACTIVATE') {
      // Deactivate user account
      await prisma.user.update({
        where: { id: userId },
        data: {
          is_active: false
        }
      });

      return NextResponse.json({
        message: 'User deactivated successfully',
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          is_active: false
        }
      });
    } else {
      return NextResponse.json({ error: 'Invalid action. Use APPROVE, REJECT, ACTIVATE, or DEACTIVATE' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('Approval error:', error);
    return NextResponse.json({ error: 'Approval failed', details: error.message }, { status: 500 });
  }
}

// GET endpoint to fetch pending registrations for admin dashboard
export async function GET(request: NextRequest) {
  try {
    const users = await prisma.user.findMany({
      include: {
        store: true,
        service_provider: true,
        documents: true
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    return NextResponse.json(users);
  } catch (error: any) {
    console.error('Fetch users error:', error);
    // Return empty array instead of error when database is not available
    if (error.code === 'P1001' || error.message?.includes('Can\'t reach database server')) {
      return NextResponse.json([]);
    }
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}
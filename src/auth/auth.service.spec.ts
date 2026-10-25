import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('AuthService', () => {
  let authService: AuthService;

  const mockPrismaService = {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };

  const mockJwtService = {
    signAsync: vi.fn().mockResolvedValue('mock-jwt-token'),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('should register a new user and return an access token', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        displayName: 'Test User',
        passwordHash: 'hashed-password',
        createdAt: new Date(),
      });

      const result = await authService.register({
        email: 'Test@Example.com',
        password: 'password123',
        displayName: 'Test User',
      });

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.user.email).toBe('test@example.com');
      expect(mockPrismaService.user.create).toHaveBeenCalled();
    });

    it('should throw ConflictException if email is already taken', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        authService.register({
          email: 'test@example.com',
          password: 'password123',
          displayName: 'Test User',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('should login an existing user with valid password', async () => {
      const hashedPassword = await bcrypt.hash('password123', 10);
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        displayName: 'Test User',
        passwordHash: hashedPassword,
        createdAt: new Date(),
      });

      const result = await authService.login({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.accessToken).toBe('mock-jwt-token');
      expect(result.user.id).toBe('user-uuid-1');
    });

    it('should throw UnauthorizedException if user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        authService.login({
          email: 'nonexistent@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if password is wrong', async () => {
      const hashedPassword = await bcrypt.hash('correctpassword', 10);
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@example.com',
        displayName: 'Test User',
        passwordHash: hashedPassword,
      });

      await expect(
        authService.login({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});

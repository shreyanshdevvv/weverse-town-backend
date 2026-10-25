import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RoomsService } from './rooms.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('RoomsService', () => {
  let roomsService: RoomsService;

  const mockPrismaService = {
    $transaction: vi.fn(),
    room: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    roomMember: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    roomsService = module.get<RoomsService>(RoomsService);
  });

  describe('create', () => {
    it('should create a room and assign creator as OWNER in a transaction', async () => {
      const mockCreatedRoom = {
        id: 'room-uuid-1',
        name: 'Town Square',
        inviteCode: 'A3F9B1',
        createdById: 'user-uuid-1',
        maxPlayers: 25,
      };

      // Mock $transaction executing the callback
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const tx = {
          room: { create: vi.fn().mockResolvedValue(mockCreatedRoom) },
          roomMember: { create: vi.fn().mockResolvedValue({}) },
        };
        return callback(tx);
      });

      const result = await roomsService.create('user-uuid-1', {
        name: 'Town Square',
      });

      expect(result.id).toBe('room-uuid-1');
      expect(result.name).toBe('Town Square');
      expect(mockPrismaService.$transaction).toHaveBeenCalled();
    });
  });

  describe('join', () => {
    it('should throw NotFoundException if room invite code does not exist', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue(null);

      await expect(
        roomsService.join('user-uuid-2', { inviteCode: 'INVALID' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if room has reached max capacity', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-uuid-1',
        name: 'Full Room',
        maxPlayers: 2,
        _count: { members: 2 },
      });

      await expect(
        roomsService.join('user-uuid-3', { inviteCode: 'FULLRM' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should join successfully via upsert if room has capacity', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-uuid-1',
        name: 'Open Room',
        maxPlayers: 10,
        _count: { members: 2 },
      });

      mockPrismaService.roomMember.upsert.mockResolvedValue({
        id: 'member-uuid-1',
        userId: 'user-uuid-2',
        roomId: 'room-uuid-1',
        role: 'MEMBER',
      });

      const result = await roomsService.join('user-uuid-2', {
        inviteCode: 'OPENRM',
      });

      expect(result.message).toBe('Joined room successfully');
      expect(result.roomId).toBe('room-uuid-1');
      expect(result.role).toBe('MEMBER');
    });
  });

  describe('isUserInRoom', () => {
    it('should return true if membership exists', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        id: 'member-1',
      });

      const result = await roomsService.isUserInRoom('user-1', 'room-1');
      expect(result).toBe(true);
    });

    it('should return false if membership does not exist', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue(null);

      const result = await roomsService.isUserInRoom('user-1', 'room-1');
      expect(result).toBe(false);
    });
  });
});

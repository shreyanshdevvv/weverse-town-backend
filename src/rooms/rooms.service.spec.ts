import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { RoomsService } from './rooms.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppEventsService } from '../common/events/events.service.js';

describe('RoomsService', () => {
  let roomsService: RoomsService;

  const mockPrismaService = {
    $transaction: vi.fn(),
    room: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    roomMember: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  };

  const mockEventsService = {
    emit: vi.fn(),
    on: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AppEventsService, useValue: mockEventsService },
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

  describe('update', () => {
    it('should update room if requester is OWNER', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'user-owner',
      });

      mockPrismaService.room.update.mockResolvedValue({
        id: 'room-1',
        name: 'Renamed Room',
        width: 1500,
        height: 1500,
        maxPlayers: 30,
      });

      const result = await roomsService.update('room-1', 'user-owner', {
        name: 'Renamed Room',
        width: 1500,
      });

      expect(result.name).toBe('Renamed Room');
      expect(mockEventsService.emit).toHaveBeenCalledWith('room:updated', expect.any(Object));
    });

    it('should throw ForbiddenException if requester is not OWNER', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'user-owner',
      });

      await expect(
        roomsService.update('room-1', 'user-imposter', { name: 'Hack' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('delete', () => {
    it('should delete room and emit room:deleted if requester is OWNER', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'user-owner',
      });
      mockPrismaService.room.delete.mockResolvedValue({ id: 'room-1' });

      const result = await roomsService.delete('room-1', 'user-owner');

      expect(result.message).toBe('Room deleted successfully');
      expect(mockPrismaService.room.delete).toHaveBeenCalledWith({ where: { id: 'room-1' } });
      expect(mockEventsService.emit).toHaveBeenCalledWith('room:deleted', {
        roomId: 'room-1',
        reason: 'The room has been deleted by the owner',
      });
    });

    it('should throw ForbiddenException if non-owner tries to delete', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'user-owner',
      });

      await expect(roomsService.delete('room-1', 'user-other')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('leave', () => {
    it('should allow normal member to leave room', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'user-member',
        roomId: 'room-1',
        role: 'MEMBER',
      });
      mockPrismaService.roomMember.delete.mockResolvedValue({});

      const result = await roomsService.leave('room-1', 'user-member');

      expect(result.message).toBe('Left room successfully');
      expect(mockEventsService.emit).toHaveBeenCalledWith('room:member-left', {
        roomId: 'room-1',
        userId: 'user-member',
      });
    });

    it('should block owner from leaving if other members exist', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'user-owner',
        roomId: 'room-1',
        role: 'OWNER',
      });
      mockPrismaService.roomMember.count.mockResolvedValue(3); // 3 members

      await expect(roomsService.leave('room-1', 'user-owner')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('regenerateInviteCode', () => {
    it('should allow OWNER or MODERATOR to regenerate invite code', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'user-owner',
        roomId: 'room-1',
        role: 'OWNER',
      });
      mockPrismaService.room.update.mockResolvedValue({
        id: 'room-1',
        name: 'Room',
        inviteCode: 'NEW123',
      });

      const result = await roomsService.regenerateInviteCode('room-1', 'user-owner');

      expect(result.message).toBe('Invite code regenerated successfully');
      expect(result.inviteCode).toBe('NEW123');
    });

    it('should reject normal member from regenerating invite code', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'user-member',
        roomId: 'room-1',
        role: 'MEMBER',
      });

      await expect(
        roomsService.regenerateInviteCode('room-1', 'user-member'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('kickMember', () => {
    it('should allow OWNER to kick a member', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'owner-id',
      });
      mockPrismaService.roomMember.findUnique
        .mockResolvedValueOnce({ userId: 'owner-id', roomId: 'room-1', role: 'OWNER' })
        .mockResolvedValueOnce({ userId: 'target-id', roomId: 'room-1', role: 'MEMBER' });
      mockPrismaService.roomMember.delete.mockResolvedValue({});

      const result = await roomsService.kickMember('room-1', 'owner-id', 'target-id');

      expect(result.message).toBe('Member kicked successfully');
      expect(mockEventsService.emit).toHaveBeenCalledWith(
        'room:member-kicked',
        expect.objectContaining({
          roomId: 'room-1',
          memberUserId: 'target-id',
          kickedByUserId: 'owner-id',
        }),
      );
    });

    it('should allow MODERATOR to kick a MEMBER', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'owner-id',
      });
      mockPrismaService.roomMember.findUnique
        .mockResolvedValueOnce({ userId: 'mod-id', roomId: 'room-1', role: 'MODERATOR' })
        .mockResolvedValueOnce({ userId: 'target-id', roomId: 'room-1', role: 'MEMBER' });
      mockPrismaService.roomMember.delete.mockResolvedValue({});

      const result = await roomsService.kickMember('room-1', 'mod-id', 'target-id');
      expect(result.message).toBe('Member kicked successfully');
    });

    it('should prevent MODERATOR from kicking another MODERATOR', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'owner-id',
      });
      mockPrismaService.roomMember.findUnique
        .mockResolvedValueOnce({ userId: 'mod-1', roomId: 'room-1', role: 'MODERATOR' })
        .mockResolvedValueOnce({ userId: 'mod-2', roomId: 'room-1', role: 'MODERATOR' });

      await expect(
        roomsService.kickMember('room-1', 'mod-1', 'mod-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should prevent anyone from kicking the room OWNER', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'owner-id',
      });
      mockPrismaService.roomMember.findUnique
        .mockResolvedValueOnce({ userId: 'mod-id', roomId: 'room-1', role: 'MODERATOR' })
        .mockResolvedValueOnce({ userId: 'owner-id', roomId: 'room-1', role: 'OWNER' });

      await expect(
        roomsService.kickMember('room-1', 'mod-id', 'owner-id'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should prevent user from kicking themselves', async () => {
      await expect(
        roomsService.kickMember('room-1', 'user-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateMemberRole', () => {
    it('should allow room OWNER to promote a MEMBER to MODERATOR', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'owner-id',
      });
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'target-id',
        roomId: 'room-1',
        role: 'MEMBER',
      });
      mockPrismaService.roomMember.update.mockResolvedValue({
        userId: 'target-id',
        roomId: 'room-1',
        role: 'MODERATOR',
      });

      const result = await roomsService.updateMemberRole(
        'room-1',
        'owner-id',
        'target-id',
        'MODERATOR',
      );

      expect(result.role).toBe('MODERATOR');
      expect(mockEventsService.emit).toHaveBeenCalledWith(
        'room:member-role-updated',
        {
          roomId: 'room-1',
          memberUserId: 'target-id',
          role: 'MODERATOR',
        },
      );
    });

    it('should prevent non-owner from updating roles', async () => {
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        createdById: 'owner-id',
      });

      await expect(
        roomsService.updateMemberRole('room-1', 'non-owner-id', 'target-id', 'MODERATOR'),
      ).rejects.toThrow(ForbiddenException);
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

  describe('findOne', () => {
    it('should return room details if user is a member', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        roomId: 'room-1',
      });
      mockPrismaService.room.findUnique.mockResolvedValue({
        id: 'room-1',
        name: 'Design Room',
        width: 2000,
        height: 2000,
        spawnX: 1000,
        spawnY: 860,
      });

      const result = await roomsService.findOne('room-1', 'user-1');
      expect(result.id).toBe('room-1');
      expect(result.name).toBe('Design Room');
    });

    it('should throw ForbiddenException if user is not a member of the room', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue(null);

      await expect(roomsService.findOne('room-1', 'intruder-id')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException if room does not exist', async () => {
      mockPrismaService.roomMember.findUnique.mockResolvedValue({
        userId: 'user-1',
        roomId: 'room-1',
      });
      mockPrismaService.room.findUnique.mockResolvedValue(null);

      await expect(roomsService.findOne('room-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

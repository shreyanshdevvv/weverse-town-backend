import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import crypto from 'crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppEventsService } from '../common/events/events.service.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { UpdateRoomDto } from './dto/update-room.dto.js';
import { JoinRoomDto } from './dto/join-room.dto.js';

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AppEventsService,
  ) {}

  async create(userId: string, dto: CreateRoomDto) {
    const inviteCode = this.generateInviteCode();

    const defaultZones = [
      {
        id: 'zone-pod-alpha',
        name: 'Design Room',
        x: 450,
        y: 150,
        width: 1100,
        height: 640,
      },
      {
        id: 'zone-pod-beta',
        name: 'Focus Zone',
        x: 100,
        y: 960,
        width: 820,
        height: 940,
      },
      {
        id: 'zone-lounge',
        name: 'Team Lounge',
        x: 1080,
        y: 960,
        width: 820,
        height: 940,
      },
    ];

    const defaultObstacles = [
      // Outer perimeter walls
      { id: 'wall-top', x: 0, y: 0, width: 2000, height: 32 },
      { id: 'wall-bottom', x: 0, y: 1968, width: 2000, height: 32 },
      { id: 'wall-left', x: 0, y: 0, width: 32, height: 2000 },
      { id: 'wall-right', x: 1968, y: 0, width: 32, height: 2000 },

      // Design Room (x: 450..1550, y: 150..790)
      { id: 'design-wall-north', x: 450, y: 138, width: 1100, height: 24 },
      { id: 'design-wall-west', x: 438, y: 150, width: 24, height: 640 },
      { id: 'design-wall-east', x: 1538, y: 150, width: 24, height: 640 },
      // South wall with central doorway (doorway: x: 920 to 1080)
      { id: 'design-wall-south-left', x: 450, y: 778, width: 470, height: 24 },
      { id: 'design-wall-south-right', x: 1080, y: 778, width: 470, height: 24 },
      // Design room furniture
      { id: 'design-table', x: 830, y: 432, width: 340, height: 96 },
      { id: 'design-whiteboard', x: 932, y: 171, width: 136, height: 48 },

      // Focus Zone (x: 100..920, y: 960..1900)
      // North wall with doorway at 800-920
      { id: 'focus-wall-north', x: 100, y: 948, width: 700, height: 24 },
      { id: 'focus-wall-west', x: 88, y: 960, width: 24, height: 940 },
      { id: 'focus-wall-south', x: 100, y: 1888, width: 820, height: 24 },
      // East wall with doorway at 1200-1360
      { id: 'focus-wall-east-top', x: 908, y: 960, width: 24, height: 240 },
      { id: 'focus-wall-east-bottom', x: 908, y: 1360, width: 24, height: 540 },
      // Focus workstations
      { id: 'focus-desk-1', x: 265, y: 1162, width: 150, height: 76 },
      { id: 'focus-desk-2', x: 605, y: 1162, width: 150, height: 76 },
      { id: 'focus-desk-3', x: 265, y: 1502, width: 150, height: 76 },
      { id: 'focus-desk-4', x: 605, y: 1502, width: 150, height: 76 },

      // Team Lounge (x: 1080..1900, y: 960..1900)
      // North wall with doorway at 1080-1200
      { id: 'lounge-wall-north', x: 1200, y: 948, width: 700, height: 24 },
      { id: 'lounge-wall-east', x: 1888, y: 960, width: 24, height: 940 },
      { id: 'lounge-wall-south', x: 1080, y: 1888, width: 820, height: 24 },
      // West wall with doorway at 1200-1360
      { id: 'lounge-wall-west-top', x: 1068, y: 960, width: 24, height: 240 },
      { id: 'lounge-wall-west-bottom', x: 1068, y: 1360, width: 24, height: 540 },
      // Lounge furniture
      { id: 'lounge-sofa', x: 1340, y: 1250, width: 300, height: 160 },
      { id: 'lounge-coffee-table', x: 1430, y: 1445, width: 120, height: 50 },
      { id: 'lounge-counter', x: 1370, y: 1715, width: 240, height: 50 },
    ];

    // Atomic transaction: create Room + set creator as OWNER
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: {
          name: dto.name,
          inviteCode,
          createdById: userId,
          maxPlayers: dto.maxPlayers ?? 25,
          width: dto.width ?? 2000,
          height: dto.height ?? 2000,
          spawnX: dto.spawnX ?? 1000,
          spawnY: dto.spawnY ?? 860,
          zones: (dto.zones ?? defaultZones) as any,
          obstacles: (dto.obstacles ?? defaultObstacles) as any,
        },
      });

      await tx.roomMember.create({
        data: {
          userId,
          roomId: room.id,
          role: 'OWNER',
        },
      });

      return room;
    });
  }

  async update(roomId: string, userId: string, dto: UpdateRoomDto) {
    await this.ensureRoomOwner(roomId, userId);

    const updated = await this.prisma.room.update({
      where: { id: roomId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.maxPlayers !== undefined && { maxPlayers: dto.maxPlayers }),
        ...(dto.width !== undefined && { width: dto.width }),
        ...(dto.height !== undefined && { height: dto.height }),
        ...(dto.spawnX !== undefined && { spawnX: dto.spawnX }),
        ...(dto.spawnY !== undefined && { spawnY: dto.spawnY }),
        ...(dto.zones !== undefined && { zones: dto.zones as any }),
        ...(dto.obstacles !== undefined && { obstacles: dto.obstacles as any }),
      },
    });

    // Notify real-time engine of changed room metadata/bounds
    this.events.emit('room:updated', {
      roomId,
      name: updated.name,
      width: updated.width,
      height: updated.height,
      maxPlayers: updated.maxPlayers,
      spawnX: updated.spawnX,
      spawnY: updated.spawnY,
      zones: updated.zones,
      obstacles: updated.obstacles,
    });

    return updated;
  }

  async delete(roomId: string, userId: string) {
    await this.ensureRoomOwner(roomId, userId);

    // Cascades automatically in PostgreSQL to room_members and messages
    await this.prisma.room.delete({
      where: { id: roomId },
    });

    // Tell the real-time gateway to kick out active players and wipe RAM
    this.events.emit('room:deleted', {
      roomId,
      reason: 'The room has been deleted by the owner',
    });

    return { message: 'Room deleted successfully' };
  }

  async leave(roomId: string, userId: string) {
    const membership = await this.prisma.roomMember.findUnique({
      where: {
        userId_roomId: {
          userId,
          roomId,
        },
      },
    });

    if (!membership) {
      throw new NotFoundException('You are not a member of this room');
    }

    if (membership.role === 'OWNER') {
      const memberCount = await this.prisma.roomMember.count({
        where: { roomId },
      });

      if (memberCount > 1) {
        throw new BadRequestException(
          'Room owner cannot leave while other members are present. Transfer ownership or delete the room.',
        );
      }

      // If owner is the only member, deleting the room closes it cleanly
      return this.delete(roomId, userId);
    }

    await this.prisma.roomMember.delete({
      where: {
        userId_roomId: {
          userId,
          roomId,
        },
      },
    });

    this.events.emit('room:member-left', { roomId, userId });

    return { message: 'Left room successfully' };
  }

  async regenerateInviteCode(roomId: string, userId: string) {
    const membership = await this.prisma.roomMember.findUnique({
      where: {
        userId_roomId: {
          userId,
          roomId,
        },
      },
    });

    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'MODERATOR')) {
      throw new ForbiddenException(
        'Only room owners and moderators can regenerate invite codes',
      );
    }

    const newInviteCode = this.generateInviteCode();

    const updated = await this.prisma.room.update({
      where: { id: roomId },
      data: { inviteCode: newInviteCode },
      select: { id: true, name: true, inviteCode: true },
    });

    return {
      message: 'Invite code regenerated successfully',
      inviteCode: updated.inviteCode,
    };
  }

  async kickMember(roomId: string, requesterUserId: string, targetMemberId: string) {
    if (requesterUserId === targetMemberId) {
      throw new BadRequestException('Cannot kick yourself; use leave instead');
    }

    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, createdById: true },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const [requesterMembership, targetMembership] = await Promise.all([
      this.prisma.roomMember.findUnique({
        where: { userId_roomId: { userId: requesterUserId, roomId } },
      }),
      this.prisma.roomMember.findUnique({
        where: { userId_roomId: { userId: targetMemberId, roomId } },
      }),
    ]);

    if (!requesterMembership) {
      throw new ForbiddenException('You are not a member of this room');
    }

    if (!targetMembership) {
      throw new NotFoundException('Target user is not a member of this room');
    }

    if (targetMembership.role === 'OWNER' || room.createdById === targetMemberId) {
      throw new ForbiddenException('Cannot kick the room owner');
    }

    // Role hierarchy check
    if (requesterMembership.role === 'MEMBER') {
      throw new ForbiddenException('Members cannot kick other players');
    }

    if (requesterMembership.role === 'MODERATOR' && targetMembership.role === 'MODERATOR') {
      throw new ForbiddenException('Moderators cannot kick other moderators');
    }

    // Remove from DB
    await this.prisma.roomMember.delete({
      where: { userId_roomId: { userId: targetMemberId, roomId } },
    });

    // Notify realtime gateway to evict socket and update players
    this.events.emit('room:member-kicked', {
      roomId,
      memberUserId: targetMemberId,
      kickedByUserId: requesterUserId,
      reason: 'You have been kicked from the room by a moderator or owner',
    });

    return {
      message: 'Member kicked successfully',
      roomId,
      memberId: targetMemberId,
    };
  }

  async updateMemberRole(
    roomId: string,
    requesterUserId: string,
    targetMemberId: string,
    newRole: Role,
  ) {
    await this.ensureRoomOwner(roomId, requesterUserId);

    if (requesterUserId === targetMemberId) {
      throw new BadRequestException('Cannot change the owner role');
    }

    if (newRole === Role.OWNER) {
      throw new BadRequestException('Cannot assign OWNER role via this endpoint');
    }

    const targetMembership = await this.prisma.roomMember.findUnique({
      where: { userId_roomId: { userId: targetMemberId, roomId } },
    });

    if (!targetMembership) {
      throw new NotFoundException('Target user is not a member of this room');
    }

    const updated = await this.prisma.roomMember.update({
      where: { userId_roomId: { userId: targetMemberId, roomId } },
      data: { role: newRole },
    });

    this.events.emit('room:member-role-updated', {
      roomId,
      memberUserId: targetMemberId,
      role: newRole,
    });

    return {
      message: 'Member role updated successfully',
      roomId,
      memberId: targetMemberId,
      role: updated.role,
    };
  }

  async join(userId: string, dto: JoinRoomDto) {
    const room = await this.prisma.room.findUnique({
      where: { inviteCode: dto.inviteCode.toUpperCase().trim() },
      include: {
        _count: {
          select: { members: true },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found with this invite code');
    }

    if (room._count.members >= room.maxPlayers) {
      throw new BadRequestException('Room has reached maximum capacity');
    }

    const membership = await this.prisma.roomMember.upsert({
      where: {
        userId_roomId: {
          userId,
          roomId: room.id,
        },
      },
      update: {},
      create: {
        userId,
        roomId: room.id,
        role: 'MEMBER',
      },
    });

    return {
      message: 'Joined room successfully',
      roomId: room.id,
      roomName: room.name,
      role: membership.role,
    };
  }

  async findOne(roomId: string, userId: string) {
    const isMember = await this.isUserInRoom(userId, roomId);
    if (!isMember) {
      throw new ForbiddenException(
        'You must be a member of this room to view its details',
      );
    }

    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        createdBy: {
          select: { id: true, displayName: true, email: true },
        },
        members: {
          include: {
            user: {
              select: { id: true, displayName: true },
            },
          },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    return room;
  }

  async findMyRooms(userId: string) {
    return this.prisma.room.findMany({
      where: {
        members: {
          some: { userId },
        },
      },
      include: {
        _count: {
          select: { members: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async isUserInRoom(userId: string, roomId: string): Promise<boolean> {
    const membership = await this.prisma.roomMember.findUnique({
      where: {
        userId_roomId: {
          userId,
          roomId,
        },
      },
    });
    return !!membership;
  }

  private async ensureRoomOwner(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, createdById: true },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.createdById !== userId) {
      throw new ForbiddenException('Only the room owner is authorized to perform this action');
    }

    return room;
  }

  private generateInviteCode(): string {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }
}

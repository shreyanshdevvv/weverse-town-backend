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
        name: 'Meeting Pod Alpha',
        x: 100,
        y: 100,
        width: 250,
        height: 200,
      },
      {
        id: 'zone-pod-beta',
        name: 'Executive Lounge',
        x: 650,
        y: 100,
        width: 250,
        height: 200,
      },
    ];

    // Atomic transaction: create Room + set creator as OWNER
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: {
          name: dto.name,
          inviteCode,
          createdById: userId,
          maxPlayers: dto.maxPlayers ?? 25,
          width: dto.width ?? 1000,
          height: dto.height ?? 1000,
          spawnX: dto.spawnX ?? 500,
          spawnY: dto.spawnY ?? 500,
          zones: dto.zones ?? defaultZones,
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
        ...(dto.name && { name: dto.name }),
        ...(dto.maxPlayers && { maxPlayers: dto.maxPlayers }),
        ...(dto.width && { width: dto.width }),
        ...(dto.height && { height: dto.height }),
        ...(dto.spawnX !== undefined && { spawnX: dto.spawnX }),
        ...(dto.spawnY !== undefined && { spawnY: dto.spawnY }),
        ...(dto.zones !== undefined && { zones: dto.zones }),
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

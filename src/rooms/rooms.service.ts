import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { JoinRoomDto } from './dto/join-room.dto.js';

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateRoomDto) {
    const inviteCode = this.generateInviteCode();

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

    // Check capacity limit
    if (room._count.members >= room.maxPlayers) {
      throw new BadRequestException('Room has reached maximum capacity');
    }

    // Upsert membership: if already joined, don't fail, just return membership
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

  private generateInviteCode(): string {
    // 6-character random hex string e.g. "A3F9B1"
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }
}

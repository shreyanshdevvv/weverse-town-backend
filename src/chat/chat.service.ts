import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  async saveMessage(
    roomId: string,
    senderId: string,
    content: string,
    options?: { recipientId?: string; zoneId?: string },
  ) {
    const trimmed = content?.trim();
    if (!trimmed) {
      throw new BadRequestException('Message content cannot be empty');
    }

    if (trimmed.length > 500) {
      throw new BadRequestException('Message cannot exceed 500 characters');
    }

    if (options?.recipientId && options.recipientId === senderId) {
      throw new BadRequestException('Cannot send direct message to yourself');
    }

    return this.prisma.message.create({
      data: {
        roomId,
        senderId,
        recipientId: options?.recipientId ?? null,
        zoneId: options?.zoneId ?? null,
        content: trimmed,
      },
      include: {
        sender: {
          select: {
            id: true,
            displayName: true,
          },
        },
        recipient: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });
  }

  async getRoomMessages(roomId: string, limit = 50) {
    // Uses composite index @@index([roomId, createdAt])
    const messages = await this.prisma.message.findMany({
      where: {
        roomId,
        recipientId: null,
        zoneId: null,
      },
      take: Math.min(limit, 100),
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });

    // Return in chronological order (oldest to newest)
    return messages.reverse();
  }

  async getDirectMessages(
    roomId: string,
    userAId: string,
    userBId: string,
    limit = 50,
  ) {
    const messages = await this.prisma.message.findMany({
      where: {
        roomId,
        OR: [
          { senderId: userAId, recipientId: userBId },
          { senderId: userBId, recipientId: userAId },
        ],
      },
      take: Math.min(limit, 100),
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: {
            id: true,
            displayName: true,
          },
        },
        recipient: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });

    return messages.reverse();
  }

  async getZoneMessages(roomId: string, zoneId: string, limit = 50) {
    const messages = await this.prisma.message.findMany({
      where: {
        roomId,
        zoneId,
      },
      take: Math.min(limit, 100),
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });

    return messages.reverse();
  }
}

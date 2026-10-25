import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  async saveMessage(roomId: string, senderId: string, content: string) {
    const trimmed = content?.trim();
    if (!trimmed) {
      throw new BadRequestException('Message content cannot be empty');
    }

    if (trimmed.length > 500) {
      throw new BadRequestException('Message cannot exceed 500 characters');
    }

    return this.prisma.message.create({
      data: {
        roomId,
        senderId,
        content: trimmed,
      },
      include: {
        sender: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });
  }

  async getRoomMessages(roomId: string, limit = 50) {
    // Uses our composite index @@index([roomId, createdAt])
    const messages = await this.prisma.message.findMany({
      where: { roomId },
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
}

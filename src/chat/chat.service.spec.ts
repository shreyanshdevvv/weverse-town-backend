import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('ChatService', () => {
  let chatService: ChatService;

  const mockPrismaService = {
    message: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    chatService = module.get<ChatService>(ChatService);
  });

  describe('saveMessage', () => {
    it('should save and return message with sender info', async () => {
      const mockSaved = {
        id: 'msg-1',
        roomId: 'room-1',
        senderId: 'user-1',
        content: 'Hello world!',
        createdAt: new Date(),
        sender: { id: 'user-1', displayName: 'Alice' },
      };

      mockPrismaService.message.create.mockResolvedValue(mockSaved);

      const result = await chatService.saveMessage('room-1', 'user-1', 'Hello world!');

      expect(result.id).toBe('msg-1');
      expect(result.content).toBe('Hello world!');
      expect(mockPrismaService.message.create).toHaveBeenCalledWith({
        data: {
          roomId: 'room-1',
          senderId: 'user-1',
          content: 'Hello world!',
        },
        include: {
          sender: {
            select: { id: true, displayName: true },
          },
        },
      });
    });

    it('should throw BadRequestException if message is empty', async () => {
      await expect(
        chatService.saveMessage('room-1', 'user-1', '   '),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if message exceeds 500 characters', async () => {
      const longMessage = 'a'.repeat(501);
      await expect(
        chatService.saveMessage('room-1', 'user-1', longMessage),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getRoomMessages', () => {
    it('should fetch recent messages ordered chronologically', async () => {
      const msg1 = { id: '1', content: 'First', createdAt: new Date(1000) };
      const msg2 = { id: '2', content: 'Second', createdAt: new Date(2000) };

      // Prisma returns newest first (desc)
      mockPrismaService.message.findMany.mockResolvedValue([msg2, msg1]);

      const result = await chatService.getRoomMessages('room-1', 50);

      // reverse() gives chronological order: First then Second
      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('2');
    });
  });
});

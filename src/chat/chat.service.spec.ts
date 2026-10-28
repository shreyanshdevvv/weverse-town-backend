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
          recipientId: null,
          zoneId: null,
          content: 'Hello world!',
        },
        include: {
          sender: {
            select: { id: true, displayName: true },
          },
          recipient: {
            select: { id: true, displayName: true },
          },
        },
      });
    });

    it('should save direct message with recipientId', async () => {
      mockPrismaService.message.create.mockResolvedValue({
        id: 'msg-dm',
        roomId: 'room-1',
        senderId: 'user-1',
        recipientId: 'user-2',
        content: 'Secret message',
        sender: { id: 'user-1', displayName: 'Alice' },
        recipient: { id: 'user-2', displayName: 'Bob' },
      });

      const result = await chatService.saveMessage(
        'room-1',
        'user-1',
        'Secret message',
        { recipientId: 'user-2' },
      );

      expect(result.recipientId).toBe('user-2');
      expect(mockPrismaService.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recipientId: 'user-2',
            zoneId: null,
          }),
        }),
      );
    });

    it('should reject direct message to self', async () => {
      await expect(
        chatService.saveMessage('room-1', 'user-1', 'Hello me', {
          recipientId: 'user-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should save zone message with zoneId', async () => {
      mockPrismaService.message.create.mockResolvedValue({
        id: 'msg-zone',
        roomId: 'room-1',
        senderId: 'user-1',
        zoneId: 'pod-alpha',
        content: 'Zone message',
      });

      const result = await chatService.saveMessage(
        'room-1',
        'user-1',
        'Zone message',
        { zoneId: 'pod-alpha' },
      );

      expect(result.zoneId).toBe('pod-alpha');
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

    it('should fetch direct messages between two users ordered chronologically', async () => {
      const msg1 = { id: '1', content: 'Hi Bob', createdAt: new Date(1000) };
      const msg2 = { id: '2', content: 'Hey Alice', createdAt: new Date(2000) };

      mockPrismaService.message.findMany.mockResolvedValue([msg2, msg1]);

      const result = await chatService.getDirectMessages('room-1', 'user-alice', 'user-bob', 50);

      expect(result[0].id).toBe('1');
      expect(result[1].id).toBe('2');
      expect(mockPrismaService.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: 'room-1',
            OR: [
              { senderId: 'user-alice', recipientId: 'user-bob' },
              { senderId: 'user-bob', recipientId: 'user-alice' },
            ],
          }),
        }),
      );
    });

    it('should fetch meeting zone messages ordered chronologically', async () => {
      const msg1 = { id: '1', content: 'Meeting starting', createdAt: new Date(1000) };
      mockPrismaService.message.findMany.mockResolvedValue([msg1]);

      const result = await chatService.getZoneMessages('room-1', 'pod-alpha', 50);

      expect(result[0].id).toBe('1');
      expect(mockPrismaService.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            roomId: 'room-1',
            zoneId: 'pod-alpha',
          },
        }),
      );
    });
  });
});

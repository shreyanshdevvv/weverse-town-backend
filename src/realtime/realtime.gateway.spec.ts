import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway, AuthenticatedSocket } from './realtime.gateway.js';
import { AuthService } from '../auth/auth.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { ChatService } from '../chat/chat.service.js';

describe('RealtimeGateway', () => {
  let gateway: RealtimeGateway;

  const mockJwtService = {
    verifyAsync: vi.fn(),
  };

  const mockAuthService = {
    validateUserById: vi.fn(),
  };

  const mockRoomsService = {
    isUserInRoom: vi.fn(),
    findOne: vi.fn(),
  };

  const mockChatService = {
    saveMessage: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: JwtService, useValue: mockJwtService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: RoomsService, useValue: mockRoomsService },
        { provide: ChatService, useValue: mockChatService },
      ],
    }).compile();

    gateway = module.get<RealtimeGateway>(RealtimeGateway);
    gateway.server = {
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    } as any;
  });

  describe('handleConnection', () => {
    it('should disconnect client if no token is provided', async () => {
      const mockClient = {
        id: 'socket-1',
        handshake: { auth: {}, headers: {} },
        disconnect: vi.fn(),
      } as unknown as AuthenticatedSocket;

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it('should authenticate and store user on socket if token is valid', async () => {
      const mockClient = {
        id: 'socket-1',
        handshake: { auth: { token: 'valid-token' }, headers: {} },
        disconnect: vi.fn(),
        data: {},
      } as unknown as AuthenticatedSocket;

      mockJwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
      mockAuthService.validateUserById.mockResolvedValue({
        id: 'user-1',
        email: 'alice@test.com',
        displayName: 'Alice',
      });

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).not.toHaveBeenCalled();
      expect(mockClient.data.user.displayName).toBe('Alice');
    });
  });

  describe('WebRTC Proximity Signaling', () => {
    let client1: AuthenticatedSocket;
    let client2: AuthenticatedSocket;
    let mockServerTo: { emit: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      mockServerTo = { emit: vi.fn() };
      (gateway.server.to as any).mockReturnValue(mockServerTo);

      mockRoomsService.isUserInRoom.mockResolvedValue(true);
      mockRoomsService.findOne.mockResolvedValue({
        id: 'room-1',
        width: 1000,
        height: 1000,
      });

      client1 = {
        id: 'socket-alice',
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
        data: { user: { id: 'alice-id', displayName: 'Alice' } },
        handshake: { auth: { token: 't1' } },
      } as unknown as AuthenticatedSocket;

      client2 = {
        id: 'socket-bob',
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
        data: { user: { id: 'bob-id', displayName: 'Bob' } },
        handshake: { auth: { token: 't2' } },
      } as unknown as AuthenticatedSocket;

      mockJwtService.verifyAsync
        .mockResolvedValueOnce({ sub: 'alice-id' })
        .mockResolvedValueOnce({ sub: 'bob-id' });

      mockAuthService.validateUserById
        .mockResolvedValueOnce({ id: 'alice-id', displayName: 'Alice' })
        .mockResolvedValueOnce({ id: 'bob-id', displayName: 'Bob' });

      await gateway.handleConnection(client1);
      await gateway.handleConnection(client2);

      await gateway.handleJoinRoom(client1, { roomId: 'room-1' });
      await gateway.handleJoinRoom(client2, { roomId: 'room-1' });
    });

    it('should forward webrtc:offer to target peer when in proximity', () => {
      const result = gateway.handleWebRtcOffer(client1, {
        targetUserId: 'bob-id',
        sdp: { type: 'offer', sdp: 'v=0...' },
      });

      expect(result.success).toBe(true);
      expect(gateway.server.to).toHaveBeenCalledWith('socket-bob');
      expect(mockServerTo.emit).toHaveBeenCalledWith('webrtc:offer', {
        fromUserId: 'alice-id',
        sdp: { type: 'offer', sdp: 'v=0...' },
      });
    });

    it('should forward webrtc:answer to offer initiator', () => {
      const result = gateway.handleWebRtcAnswer(client2, {
        targetUserId: 'alice-id',
        sdp: { type: 'answer', sdp: 'v=0...' },
      });

      expect(result.success).toBe(true);
      expect(gateway.server.to).toHaveBeenCalledWith('socket-alice');
      expect(mockServerTo.emit).toHaveBeenCalledWith('webrtc:answer', {
        fromUserId: 'bob-id',
        sdp: { type: 'answer', sdp: 'v=0...' },
      });
    });

    it('should forward webrtc:ice-candidate to target peer', () => {
      const result = gateway.handleIceCandidate(client1, {
        targetUserId: 'bob-id',
        candidate: { candidate: 'candidate:1 1 UDP ...' },
      });

      expect(result.success).toBe(true);
      expect(gateway.server.to).toHaveBeenCalledWith('socket-bob');
      expect(mockServerTo.emit).toHaveBeenCalledWith('webrtc:ice-candidate', {
        fromUserId: 'alice-id',
        candidate: { candidate: 'candidate:1 1 UDP ...' },
      });
    });

    it('should reject signaling if target is not within proximity', () => {
      // Simulate Alice and Bob moving apart
      const room = (gateway as any).rooms.get('room-1');
      const alice = room.players.get('alice-id');
      alice.nearbyPeers.delete('bob-id');

      const result = gateway.handleWebRtcOffer(client1, {
        targetUserId: 'bob-id',
        sdp: { type: 'offer' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not within proximity range');
    });

    it('should handle screen share toggle and notify nearby peers', () => {
      const result = gateway.handleScreenShareToggle(client1, {
        isSharing: true,
      });

      expect(result.success).toBe(true);
      expect(result.isSharing).toBe(true);
      expect(gateway.server.to).toHaveBeenCalledWith('socket-bob');
      expect(mockServerTo.emit).toHaveBeenCalledWith('screen:user-sharing', {
        userId: 'alice-id',
        isSharing: true,
      });
    });
  });
});

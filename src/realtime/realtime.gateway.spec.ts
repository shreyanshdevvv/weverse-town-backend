import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway, AuthenticatedSocket } from './realtime.gateway.js';
import { AuthService } from '../auth/auth.service.js';
import { RoomsService } from '../rooms/rooms.service.js';

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

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: JwtService, useValue: mockJwtService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: RoomsService, useValue: mockRoomsService },
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

    it('should disconnect client if token verification fails', async () => {
      const mockClient = {
        id: 'socket-1',
        handshake: { auth: { token: 'invalid-token' }, headers: {} },
        disconnect: vi.fn(),
      } as unknown as AuthenticatedSocket;

      mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

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

  describe('handleJoinRoom', () => {
    it('should reject if user is not an authorized room member', async () => {
      const mockClient = {
        data: {
          user: { id: 'user-1', displayName: 'Alice' },
        },
      } as unknown as AuthenticatedSocket;

      mockRoomsService.isUserInRoom.mockResolvedValue(false);

      const result = await gateway.handleJoinRoom(mockClient, {
        roomId: 'room-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unauthorized');
    });

    it('should join room, cache dimensions, and broadcast player:joined', async () => {
      const mockTo = { emit: vi.fn() };
      const mockClient = {
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        to: vi.fn().mockReturnValue(mockTo),
        data: {
          user: { id: 'user-1', displayName: 'Alice' },
        },
      } as unknown as AuthenticatedSocket;

      mockRoomsService.isUserInRoom.mockResolvedValue(true);
      mockRoomsService.findOne.mockResolvedValue({
        id: 'room-1',
        width: 1000,
        height: 1000,
      });

      const result = await gateway.handleJoinRoom(mockClient, {
        roomId: 'room-1',
      });

      expect(result.success).toBe(true);
      expect(mockClient.join).toHaveBeenCalledWith('room-1');
      expect(mockClient.emit).toHaveBeenCalledWith(
        'room:state',
        expect.objectContaining({ players: expect.any(Array) }),
      );
      expect(mockClient.to).toHaveBeenCalledWith('room-1');
      expect(mockTo.emit).toHaveBeenCalledWith(
        'player:joined',
        expect.objectContaining({ userId: 'user-1', displayName: 'Alice' }),
      );
    });
  });

  describe('handleMove (Server-Authoritative Validation)', () => {
    let mockClient: AuthenticatedSocket;
    let mockTo: { emit: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      mockTo = { emit: vi.fn() };
      mockClient = {
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        to: vi.fn().mockReturnValue(mockTo),
        data: {
          user: { id: 'user-1', displayName: 'Alice' },
        },
      } as unknown as AuthenticatedSocket;

      mockRoomsService.isUserInRoom.mockResolvedValue(true);
      mockRoomsService.findOne.mockResolvedValue({
        id: 'room-1',
        width: 1000,
        height: 1000,
      });

      await gateway.handleJoinRoom(mockClient, { roomId: 'room-1' });
    });

    it('should accept valid move and broadcast player:moved', () => {
      // Player spawns at (500, 500)
      const result = gateway.handleMove(mockClient, {
        x: 510,
        y: 505,
        direction: 'right',
      });

      expect(result.success).toBe(true);
      expect(result.x).toBe(510);
      expect(result.y).toBe(505);
      expect(mockTo.emit).toHaveBeenCalledWith(
        'player:moved',
        expect.objectContaining({ userId: 'user-1', x: 510, y: 505 }),
      );
    });

    it('should reject move if coordinates exceed map boundaries', () => {
      mockTo.emit.mockClear();

      const result = gateway.handleMove(mockClient, {
        x: 1200, // Room width is 1000!
        y: 500,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of map bounds');
      expect(mockTo.emit).not.toHaveBeenCalled();
    });

    it('should reject impossible speed / teleportation attempts', () => {
      mockTo.emit.mockClear();

      // Trying to teleport from (500, 500) to (900, 900) in 1ms
      const result = gateway.handleMove(mockClient, {
        x: 900,
        y: 900,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Speed violation');
      expect(mockTo.emit).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should clean up player and broadcast player:left', async () => {
      const mockTo = { emit: vi.fn() };
      const mockClient = {
        join: vi.fn(),
        leave: vi.fn(),
        emit: vi.fn(),
        to: vi.fn().mockReturnValue(mockTo),
        data: {
          user: { id: 'user-1', displayName: 'Alice' },
        },
      } as unknown as AuthenticatedSocket;

      mockRoomsService.isUserInRoom.mockResolvedValue(true);
      mockRoomsService.findOne.mockResolvedValue({
        id: 'room-1',
        width: 1000,
        height: 1000,
      });

      await gateway.handleJoinRoom(mockClient, { roomId: 'room-1' });

      // Disconnect
      gateway.handleDisconnect(mockClient);

      expect(mockClient.to).toHaveBeenCalledWith('room-1');
      expect(mockTo.emit).toHaveBeenCalledWith('player:left', {
        userId: 'user-1',
      });
    });
  });
});

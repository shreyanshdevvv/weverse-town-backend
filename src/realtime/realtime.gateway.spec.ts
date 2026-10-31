import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway, AuthenticatedSocket } from './realtime.gateway.js';
import { AuthService } from '../auth/auth.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { ChatService } from '../chat/chat.service.js';
import { AppEventsService } from '../common/events/events.service.js';

describe('RealtimeGateway', () => {
  let gateway: RealtimeGateway;
  let events: AppEventsService;

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
        AppEventsService,
      ],
    }).compile();

    gateway = module.get<RealtimeGateway>(RealtimeGateway);
    events = module.get<AppEventsService>(AppEventsService);
    gateway.server = {
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      socketsLeave: vi.fn(),
      use: vi.fn(),
      sockets: {
        sockets: new Map(),
      },
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

  describe('Event Listeners (AppEventsService)', () => {
    let mockServerTo: { emit: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockServerTo = { emit: vi.fn() };
      (gateway.server.to as any).mockReturnValue(mockServerTo);
      gateway.afterInit(gateway.server);
    });

    it('should broadcast room:deleted, disconnect room sockets, and purge memory on room:deleted event', () => {
      // Setup room state in memory
      (gateway as any).rooms.set('room-1', {
        width: 1000,
        height: 1000,
        players: new Map(),
      });

      events.emit('room:deleted', {
        roomId: 'room-1',
        reason: 'The room has been deleted by the owner',
      });

      expect(gateway.server.to).toHaveBeenCalledWith('room-1');
      expect(mockServerTo.emit).toHaveBeenCalledWith('room:deleted', {
        roomId: 'room-1',
        reason: 'The room has been deleted by the owner',
      });
      expect(gateway.server.socketsLeave).toHaveBeenCalledWith('room-1');
      expect((gateway as any).rooms.has('room-1')).toBe(false);
    });

    it('should update in-memory room dimensions and broadcast room:updated', () => {
      (gateway as any).rooms.set('room-1', {
        width: 1000,
        height: 1000,
        players: new Map(),
      });

      events.emit('room:updated', {
        roomId: 'room-1',
        width: 2000,
        height: 1600,
      });

      const updated = (gateway as any).rooms.get('room-1');
      expect(updated.width).toBe(2000);
      expect(updated.height).toBe(1600);
      expect(gateway.server.to).toHaveBeenCalledWith('room-1');
      expect(mockServerTo.emit).toHaveBeenCalledWith('room:updated', {
        roomId: 'room-1',
        width: 2000,
        height: 1600,
      });
    });

    it('should evict kicked player, notify socket, and broadcast player:left', () => {
      const mockKickedSocket = {
        emit: vi.fn(),
        leave: vi.fn(),
        data: { roomId: 'room-1' },
      };
      (gateway.server.sockets.sockets as Map<string, any>).set(
        'socket-kicked',
        mockKickedSocket,
      );
      (gateway as any).userSockets.set('user-kicked', 'socket-kicked');

      (gateway as any).rooms.set('room-1', {
        width: 1000,
        height: 1000,
        players: new Map([
          [
            'user-kicked',
            {
              userId: 'user-kicked',
              nearbyPeers: new Set(),
            },
          ],
        ]),
      });

      events.emit('room:member-kicked', {
        roomId: 'room-1',
        memberUserId: 'user-kicked',
        kickedByUserId: 'user-owner',
        reason: 'Violation of rules',
      });

      expect(mockKickedSocket.emit).toHaveBeenCalledWith('player:kicked', {
        roomId: 'room-1',
        reason: 'Violation of rules',
      });
      expect(mockKickedSocket.leave).toHaveBeenCalledWith('room-1');
      expect((gateway as any).rooms.get('room-1').players.has('user-kicked')).toBe(false);
      expect(gateway.server.to).toHaveBeenCalledWith('room-1');
      expect(mockServerTo.emit).toHaveBeenCalledWith('player:left', {
        userId: 'user-kicked',
        reason: 'kicked',
      });
    });

    it('should broadcast room:member-role-updated to the room', () => {
      events.emit('room:member-role-updated', {
        roomId: 'room-1',
        memberUserId: 'user-bob',
        role: 'MODERATOR',
      });

      expect(gateway.server.to).toHaveBeenCalledWith('room-1');
      expect(mockServerTo.emit).toHaveBeenCalledWith('room:member-role-updated', {
        roomId: 'room-1',
        userId: 'user-bob',
        role: 'MODERATOR',
      });
    });
  });

  describe('Gather.town Private Meeting Zones & Soundproofing', () => {
    let mockClientAlice: any;
    let mockClientBob: any;

    beforeEach(() => {
      mockClientAlice = {
        id: 'socket-alice',
        emit: vi.fn(),
        data: { roomId: 'room-1', user: { id: 'alice', displayName: 'Alice' } },
        handshake: { auth: {} },
      };
      mockClientBob = {
        id: 'socket-bob',
        emit: vi.fn(),
        data: { roomId: 'room-1', user: { id: 'bob', displayName: 'Bob' } },
        handshake: { auth: {} },
      };

      (gateway as any).userSockets.set('alice', 'socket-alice');
      (gateway as any).userSockets.set('bob', 'socket-bob');

      // Define room with a private meeting pod
      (gateway as any).rooms.set('room-1', {
        width: 1000,
        height: 1000,
        zones: [
          {
            id: 'zone-pod-alpha',
            name: 'Meeting Pod Alpha',
            x: 100,
            y: 100,
            width: 200,
            height: 200,
          },
        ],
        players: new Map(),
      });
    });

    it('should connect peers when both are inside the same private meeting zone', () => {
      const room = (gateway as any).rooms.get('room-1');

      const playerAlice: any = {
        userId: 'alice',
        displayName: 'Alice',
        x: 150,
        y: 150,
        currentZoneId: 'zone-pod-alpha',
        nearbyPeers: new Set(),
      };
      const playerBob: any = {
        userId: 'bob',
        displayName: 'Bob',
        x: 250,
        y: 250,
        currentZoneId: 'zone-pod-alpha',
        nearbyPeers: new Set(),
      };

      room.players.set('alice', playerAlice);
      room.players.set('bob', playerBob);

      (gateway as any).updateProximity('room-1', playerAlice, mockClientAlice);

      expect(playerAlice.nearbyPeers.has('bob')).toBe(true);
      expect(playerBob.nearbyPeers.has('alice')).toBe(true);
      expect(mockClientAlice.emit).toHaveBeenCalledWith('proximity:enter', {
        peerId: 'bob',
        displayName: 'Bob',
        zoneId: 'zone-pod-alpha',
        distance: expect.any(Number),
      });
    });

    it('should isolate peers if one is in a private zone and the other is outside, even if 10px apart', () => {
      const room = (gateway as any).rooms.get('room-1');

      // Alice is inside the pod (at x: 295, inside the [100, 300] box)
      const playerAlice: any = {
        userId: 'alice',
        displayName: 'Alice',
        x: 295,
        y: 150,
        currentZoneId: 'zone-pod-alpha',
        nearbyPeers: new Set(),
      };
      // Bob is right outside the glass wall (at x: 305, distance = 10px)
      const playerBob: any = {
        userId: 'bob',
        displayName: 'Bob',
        x: 305,
        y: 150,
        currentZoneId: null,
        nearbyPeers: new Set(),
      };

      room.players.set('alice', playerAlice);
      room.players.set('bob', playerBob);

      (gateway as any).updateProximity('room-1', playerAlice, mockClientAlice);

      // Soundproof barrier: NO proximity connection formed!
      expect(playerAlice.nearbyPeers.has('bob')).toBe(false);
      expect(playerBob.nearbyPeers.has('alice')).toBe(false);
      expect(mockClientAlice.emit).not.toHaveBeenCalledWith('proximity:enter', expect.anything());
    });
  });

  describe('Teams-Style Direct Messaging (chat:dm) & Zone Chat (chat:zone)', () => {
    let mockClientAlice: any;

    beforeEach(() => {
      mockClientAlice = {
        id: 'socket-alice',
        emit: vi.fn(),
        data: { roomId: 'room-1', user: { id: 'alice', displayName: 'Alice' } },
        handshake: { auth: {} },
      };

      (gateway as any).userSockets.set('alice', 'socket-alice');
      (gateway as any).userSockets.set('bob', 'socket-bob');
    });

    it('should deliver chat:dm to recipient socket and sender socket only', async () => {
      mockChatService.saveMessage.mockResolvedValue({
        id: 'msg-dm-1',
        roomId: 'room-1',
        senderId: 'alice',
        recipientId: 'bob',
        content: 'Hey Bob, let us sync',
        createdAt: new Date(),
        sender: { displayName: 'Alice' },
      });

      const result = await gateway.handleDirectMessage(mockClientAlice, {
        recipientId: 'bob',
        content: 'Hey Bob, let us sync',
      });

      expect(result.success).toBe(true);
      expect(gateway.server.to).toHaveBeenCalledWith('socket-bob');
      expect(mockClientAlice.emit).toHaveBeenCalledWith('chat:dm', expect.objectContaining({
        content: 'Hey Bob, let us sync',
        recipientId: 'bob',
      }));
    });

    it('should deliver chat:zone only to members inside the same meeting pod', async () => {
      const mockClientBob = { id: 'socket-bob', emit: vi.fn() };
      const mockClientCharlie = { id: 'socket-charlie', emit: vi.fn() };

      (gateway.server.to as any).mockImplementation((socketId: string) => {
        if (socketId === 'socket-bob') return mockClientBob;
        if (socketId === 'socket-charlie') return mockClientCharlie;
        return { emit: vi.fn() };
      });

      (gateway as any).userSockets.set('charlie', 'socket-charlie');

      // Alice and Bob in pod-alpha; Charlie in pod-beta
      (gateway as any).rooms.set('room-1', {
        width: 1000,
        height: 1000,
        players: new Map([
          ['alice', { userId: 'alice', currentZoneId: 'pod-alpha' }],
          ['bob', { userId: 'bob', currentZoneId: 'pod-alpha' }],
          ['charlie', { userId: 'charlie', currentZoneId: 'pod-beta' }],
        ]),
      });

      mockChatService.saveMessage.mockResolvedValue({
        id: 'msg-zone-1',
        roomId: 'room-1',
        senderId: 'alice',
        zoneId: 'pod-alpha',
        content: 'Meeting notes here',
        createdAt: new Date(),
        sender: { displayName: 'Alice' },
      });

      const result = await gateway.handleZoneMessage(mockClientAlice, {
        content: 'Meeting notes here',
      });

      expect(result.success).toBe(true);
      // Bob should receive the zone message
      expect(mockClientBob.emit).toHaveBeenCalledWith('chat:zone', expect.objectContaining({
        zoneId: 'pod-alpha',
        content: 'Meeting notes here',
      }));
      // Charlie is in pod-beta, so Charlie should NOT receive it
      expect(mockClientCharlie.emit).not.toHaveBeenCalled();
    });
  });

  describe('Gather.town Authoritative Collision Physics & Audio Distance', () => {
    it('should reject movement that collides with an obstacle and return correctedPosition', async () => {
      const mockClient: any = {
        data: { user: { id: 'alice', displayName: 'Alice' }, roomId: 'room-1' },
        emit: vi.fn(),
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      };

      (gateway as any).rooms.set('room-1', {
        width: 2000,
        height: 2000,
        obstacles: [
          // Wall from x: 100 to 300, y: 100 to 120
          { id: 'wall-1', x: 100, y: 100, width: 200, height: 20 },
        ],
        players: new Map([
          [
            'alice',
            {
              userId: 'alice',
              displayName: 'Alice',
              x: 1000,
              y: 860,
              direction: 'down',
              lastMoveTime: Date.now() - 500,
              nearbyPeers: new Set(),
            },
          ],
        ]),
      });

      // Try moving into obstacle at x: 200, y: 110
      const result = await gateway.handleMove(mockClient, { x: 200, y: 110, direction: 'up' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path blocked by obstacle');
      expect(result.correctedPosition).toEqual({ x: 1000, y: 860 });
    });

    it('should allow movement into clear areas without obstacles', async () => {
      const mockClient: any = {
        data: { user: { id: 'alice', displayName: 'Alice' }, roomId: 'room-1' },
        emit: vi.fn(),
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      };

      (gateway as any).rooms.set('room-1', {
        width: 2000,
        height: 2000,
        obstacles: [
          { id: 'wall-1', x: 100, y: 100, width: 200, height: 20 },
        ],
        players: new Map([
          [
            'alice',
            {
              userId: 'alice',
              displayName: 'Alice',
              x: 1000,
              y: 860,
              direction: 'down',
              lastMoveTime: Date.now() - 500,
              nearbyPeers: new Set(),
            },
          ],
        ]),
      });

      // Move into open hallway at x: 1000, y: 880
      const result = await gateway.handleMove(mockClient, { x: 1000, y: 880, direction: 'down' });

      expect(result.success).toBe(true);
      expect(result.x).toBe(1000);
      expect(result.y).toBe(880);
    });

    it('should emit proximity:distance for volume attenuation when moving within proximity range', () => {
      const mockClientAlice: any = {
        data: { user: { id: 'alice', displayName: 'Alice' }, roomId: 'room-1' },
        emit: vi.fn(),
      };
      const mockClientBob: any = {
        data: { user: { id: 'bob', displayName: 'Bob' }, roomId: 'room-1' },
        emit: vi.fn(),
      };

      (gateway as any).userSockets.set('alice', 'socket-alice');
      (gateway as any).userSockets.set('bob', 'socket-bob');

      const playerAlice: any = {
        userId: 'alice',
        displayName: 'Alice',
        x: 500,
        y: 500,
        currentZoneId: null,
        nearbyPeers: new Set(['bob']), // Already in proximity!
      };
      const playerBob: any = {
        userId: 'bob',
        displayName: 'Bob',
        x: 550,
        y: 500,
        currentZoneId: null,
        nearbyPeers: new Set(['alice']),
      };

      (gateway as any).rooms.set('room-1', {
        width: 2000,
        height: 2000,
        players: new Map([
          ['alice', playerAlice],
          ['bob', playerBob],
        ]),
      });

      // Update proximity: distance is 50px
      (gateway as any).updateProximity('room-1', playerAlice, mockClientAlice);

      expect(mockClientAlice.emit).toHaveBeenCalledWith('proximity:distance', {
        peerId: 'bob',
        distance: 50,
      });
    });
  });
});

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { ChatService } from '../chat/chat.service.js';
import { AppEventsService } from '../common/events/events.service.js';

export interface RoomZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerState {
  userId: string;
  displayName: string;
  avatar: string;
  x: number;
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
  lastMoveTime: number;
  nearbyPeers: Set<string>; // userIds currently within proximity range (150px)
  isScreenSharing?: boolean;
  currentZoneId?: string | null;
}

export interface RoomState {
  width: number;
  height: number;
  spawnX?: number;
  spawnY?: number;
  zones?: RoomZone[];
  players: Map<string, PlayerState>;
}

export interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      email: string;
      displayName: string;
      avatar: string;
    };
    roomId?: string;
  };
}

export interface MovePayload {
  x: number;
  y: number;
  direction?: 'up' | 'down' | 'left' | 'right';
}

export interface ChatSendPayload {
  content: string;
}

export interface DirectMessagePayload {
  recipientId: string;
  content: string;
}

export interface ZoneMessagePayload {
  content: string;
}

export interface WebRtcSignalPayload {
  targetUserId: string;
  sdp?: any;
  candidate?: any;
}

export interface ScreenSharePayload {
  isSharing: boolean;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  // In-memory room cache: Map<roomId, RoomState>
  private readonly rooms = new Map<string, RoomState>();

  // Map userId -> socketId for direct targeted messaging (WebRTC & Proximity)
  private readonly userSockets = new Map<string, string>();

  // Maximum allowed speed: 400 pixels per second
  private readonly MAX_PLAYER_SPEED = 400;

  // Proximity threshold for audio/video range
  private readonly PROXIMITY_RADIUS = 150;

  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly roomsService: RoomsService,
    private readonly chatService: ChatService,
    private readonly events: AppEventsService,
  ) {}

  afterInit(server: Server) {
    // Listen for room deletion event from REST service
    this.events.on('room:deleted', ({ roomId, reason }) => {
      this.server.to(roomId).emit('room:deleted', {
        roomId,
        reason: reason || 'The room has been deleted by the owner',
      });
      // Force all sockets to leave the channel
      this.server.socketsLeave(roomId);
      // Clean up in-memory room state
      this.rooms.delete(roomId);
      this.logger.log(`Room ${roomId} deleted. Active sockets notified and evacuated.`);
    });

    // Listen for room update event from REST service
    this.events.on('room:updated', (data) => {
      const room = this.rooms.get(data.roomId);
      if (room) {
        if (data.width) room.width = data.width;
        if (data.height) room.height = data.height;
        if (data.spawnX !== undefined) room.spawnX = data.spawnX;
        if (data.spawnY !== undefined) room.spawnY = data.spawnY;
        if (data.zones !== undefined) room.zones = data.zones;
      }
      this.server.to(data.roomId).emit('room:updated', data);
    });

    // Listen for member departure
    this.events.on('room:member-left', ({ roomId, userId }) => {
      const room = this.rooms.get(roomId);
      if (room) {
        room.players.delete(userId);
      }
      this.server.to(roomId).emit('player:left', { userId });
      const userSocketId = this.userSockets.get(userId);
      if (userSocketId) {
        const socket = this.server.sockets.sockets.get(userSocketId);
        socket?.leave(roomId);
      }
    });

    // Listen for member kicked
    this.events.on(
      'room:member-kicked',
      ({ roomId, memberUserId, kickedByUserId, reason }) => {
        const room = this.rooms.get(roomId);
        if (room) {
          // If the player had active proximity connections, alert them
          const player = room.players.get(memberUserId);
          if (player) {
            for (const peerId of player.nearbyPeers) {
              const peerSocketId = this.userSockets.get(peerId);
              if (peerSocketId) {
                this.server.to(peerSocketId).emit('proximity:leave', {
                  peerId: memberUserId,
                });
              }
              const peer = room.players.get(peerId);
              peer?.nearbyPeers.delete(memberUserId);
            }
          }
          room.players.delete(memberUserId);
        }

        // Notify and evict the kicked user's socket directly
        const userSocketId = this.userSockets.get(memberUserId);
        if (userSocketId) {
          const socket = this.server.sockets.sockets?.get(userSocketId);
          if (socket) {
            socket.emit('player:kicked', {
              roomId,
              reason: reason || 'You have been kicked from this room',
            });
            socket.leave(roomId);
            if (socket.data) {
              delete socket.data.roomId;
            }
          }
        }

        // Notify the remaining room peers
        this.server.to(roomId).emit('player:left', {
          userId: memberUserId,
          reason: 'kicked',
        });
      },
    );

    // Listen for member role updated
    this.events.on('room:member-role-updated', ({ roomId, memberUserId, role }) => {
      this.server.to(roomId).emit('room:member-role-updated', {
        roomId,
        userId: memberUserId,
        role,
      });
    });

    server.use(async (socket: any, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.replace('Bearer ', '');

        if (!token) {
          return next(new Error('Unauthorized: No token provided'));
        }

        const payload = await this.jwtService.verifyAsync(token);
        const user = await this.authService.validateUserById(payload.sub);
        if (!user) {
          return next(new Error('Unauthorized: User not found'));
        }

        socket.data = socket.data || {};
        socket.data.user = user;
        next();
      } catch (err) {
        next(new Error('Unauthorized: Invalid token'));
      }
    });
  }

  async getOrAuthenticateUser(client: AuthenticatedSocket) {
    if (client.data?.user) return client.data.user;

    const token =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization?.replace('Bearer ', '');

    if (token) {
      try {
        const payload = await this.jwtService.verifyAsync(token);
        const user = await this.authService.validateUserById(payload.sub);
        if (user) {
          client.data = client.data || {};
          client.data.user = user;
          this.userSockets.set(user.id, client.id);
          return user;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const user = await this.getOrAuthenticateUser(client);

      if (!user) {
        this.logger.warn(`Connection rejected: User not found or invalid token (${client.id})`);
        client.disconnect(true);
        return;
      }

      this.userSockets.set(user.id, client.id);
      this.logger.log(`Player connected: ${user.displayName} (${client.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Connection rejected: Invalid token (${client.id}) - ${message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const user = client.data?.user;
    const roomId = client.data?.roomId;

    if (user) {
      this.userSockets.delete(user.id);
    }

    if (user && roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
        const leavingPlayer = room.players.get(user.id);

        if (leavingPlayer) {
          for (const peerId of leavingPlayer.nearbyPeers) {
            const peer = room.players.get(peerId);
            if (peer) {
              peer.nearbyPeers.delete(user.id);
              const peerSocketId = this.userSockets.get(peerId);
              if (peerSocketId) {
                this.server.to(peerSocketId).emit('proximity:leave', {
                  peerId: user.id,
                });
              }
            }
          }
        }

        room.players.delete(user.id);
        if (room.players.size === 0) {
          this.rooms.delete(roomId);
        }
      }

      client.to(roomId).emit('player:left', {
        userId: user.id,
      });

      this.logger.log(`Player left room ${roomId}: ${user.displayName}`);
    }

    if (user) {
      this.logger.log(`Player disconnected: ${user.displayName} (${client.id})`);
    }
  }

  @SubscribeMessage('room:join')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const user = await this.getOrAuthenticateUser(client);

    if (!user) {
      return { success: false, error: 'Unauthorized: User session not found on socket' };
    }

    if (!data?.roomId) {
      return { success: false, error: 'roomId is required' };
    }

    const isMember = await this.roomsService.isUserInRoom(user.id, data.roomId);
    if (!isMember) {
      return { success: false, error: 'Unauthorized: You are not a member of this room' };
    }

    if (!this.rooms.has(data.roomId)) {
      const roomDetails = await this.roomsService.findOne(data.roomId, user.id);
      this.rooms.set(data.roomId, {
        width: roomDetails.width,
        height: roomDetails.height,
        spawnX: (roomDetails as any).spawnX ?? 500,
        spawnY: (roomDetails as any).spawnY ?? 500,
        zones: (roomDetails as any).zones || [],
        players: new Map(),
      });
    }

    const room = this.rooms.get(data.roomId)!;

    if (client.data.roomId && client.data.roomId !== data.roomId) {
      client.leave(client.data.roomId);
      const prevRoom = this.rooms.get(client.data.roomId);
      if (prevRoom) {
        prevRoom.players.delete(user.id);
        client.to(client.data.roomId).emit('player:left', { userId: user.id });
      }
    }

    client.join(data.roomId);
    client.data.roomId = data.roomId;

    const playerCount = room.players.size;
    // Stagger horizontal spawn positions: +0, +44, -44, +88, -88... so players do not overlap
    const spread = (playerCount % 2 === 0 ? 1 : -1) * Math.ceil(playerCount / 2) * 44;
    const baseSpawnX = room.spawnX ?? Math.floor(room.width / 2);
    const baseSpawnY = room.spawnY ?? 480;
    const spawnX = Math.max(20, Math.min(room.width - 20, baseSpawnX + spread));
    const spawnY = baseSpawnY;

    const initialZone = this.getZoneAt(room, spawnX, spawnY);

    const playerState: PlayerState = {
      userId: user.id,
      displayName: user.displayName,
      avatar: user.avatar || 'avatar-1',
      x: spawnX,
      y: spawnY,
      direction: 'down',
      lastMoveTime: Date.now(),
      nearbyPeers: new Set(),
      isScreenSharing: false,
      currentZoneId: initialZone ? initialZone.id : null,
    };

    room.players.set(user.id, playerState);

    this.updateProximity(data.roomId, playerState, client);

    if (initialZone) {
      client.emit('zone:entered', {
        zoneId: initialZone.id,
        zoneName: initialZone.name,
      });
    }

    const serializedPlayers = Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      avatar: p.avatar,
      x: p.x,
      y: p.y,
      direction: p.direction,
      nearbyPeers: Array.from(p.nearbyPeers),
      isScreenSharing: !!p.isScreenSharing,
      currentZoneId: p.currentZoneId ?? null,
    }));

    client.emit('room:state', {
      roomId: data.roomId,
      width: room.width,
      height: room.height,
      spawnX: room.spawnX ?? 500,
      spawnY: room.spawnY ?? 500,
      zones: room.zones || [],
      players: serializedPlayers,
    });

    client.to(data.roomId).emit('player:joined', {
      userId: playerState.userId,
      displayName: playerState.displayName,
      avatar: playerState.avatar,
      x: playerState.x,
      y: playerState.y,
      direction: playerState.direction,
    });

    this.logger.log(`Player ${user.displayName} joined room ${data.roomId}`);

    return {
      success: true,
      roomId: data.roomId,
      player: {
        userId: playerState.userId,
        displayName: playerState.displayName,
        avatar: playerState.avatar,
        x: playerState.x,
        y: playerState.y,
        direction: playerState.direction,
      },
    };
  }

  @SubscribeMessage('player:move')
  async handleMove(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: MovePayload,
  ) {
    const user = await this.getOrAuthenticateUser(client);
    const roomId = client.data?.roomId;

    if (!user) {
      return { success: false, error: 'Unauthorized: User session not found' };
    }

    if (!roomId) {
      return { success: false, error: 'You must join a room first' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'Room does not exist in memory' };
    }

    const currentPlayer = room.players.get(user.id);
    if (!currentPlayer) {
      return { success: false, error: 'Player presence not found in room' };
    }

    if (
      typeof data.x !== 'number' ||
      typeof data.y !== 'number' ||
      isNaN(data.x) ||
      isNaN(data.y)
    ) {
      return { success: false, error: 'Coordinates must be valid numbers' };
    }

    if (data.x < 0 || data.x > room.width || data.y < 0 || data.y > room.height) {
      return {
        success: false,
        error: 'Move out of map bounds',
        correctedPosition: { x: currentPlayer.x, y: currentPlayer.y },
      };
    }

    const now = Date.now();
    const timeDeltaSeconds = Math.max((now - currentPlayer.lastMoveTime) / 1000, 0.05);

    const distance = Math.sqrt(
      Math.pow(data.x - currentPlayer.x, 2) + Math.pow(data.y - currentPlayer.y, 2),
    );

    const calculatedSpeed = distance / timeDeltaSeconds;

    if (calculatedSpeed > this.MAX_PLAYER_SPEED && distance > 50) {
      return {
        success: false,
        error: 'Speed violation / teleportation detected',
        correctedPosition: { x: currentPlayer.x, y: currentPlayer.y },
      };
    }

    currentPlayer.x = data.x;
    currentPlayer.y = data.y;
    currentPlayer.direction = data.direction ?? currentPlayer.direction;
    currentPlayer.lastMoveTime = now;

    // Detect meeting zone transitions (entering/leaving private soundproof spaces)
    const prevZoneId = currentPlayer.currentZoneId ?? null;
    const newZone = this.getZoneAt(room, currentPlayer.x, currentPlayer.y);
    const newZoneId = newZone ? newZone.id : null;

    if (prevZoneId !== newZoneId) {
      currentPlayer.currentZoneId = newZoneId;
      if (newZone) {
        client.emit('zone:entered', {
          zoneId: newZone.id,
          zoneName: newZone.name,
        });
      } else if (prevZoneId) {
        client.emit('zone:left', {
          zoneId: prevZoneId,
        });
      }
    }

    this.updateProximity(roomId, currentPlayer, client);

    const moveEvent = {
      userId: user.id,
      x: currentPlayer.x,
      y: currentPlayer.y,
      direction: currentPlayer.direction,
      currentZoneId: currentPlayer.currentZoneId ?? null,
      timestamp: now,
    };

    client.to(roomId).emit('player:moved', moveEvent);

    return { success: true, ...moveEvent };
  }

  @SubscribeMessage('player:update-avatar')
  async handleUpdateAvatar(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { avatar: string },
  ) {
    const user = await this.getOrAuthenticateUser(client);
    const roomId = client.data?.roomId;

    if (!user) {
      return { success: false, error: 'Unauthorized: User session not found' };
    }

    if (!data?.avatar) {
      return { success: false, error: 'avatar is required' };
    }

    const updated = await this.authService.updateAvatar(user.id, data.avatar);
    user.avatar = updated.avatar;

    if (roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
        const player = room.players.get(user.id);
        if (player) {
          player.avatar = updated.avatar;
        }
      }
      this.server.to(roomId).emit('player:avatar-updated', {
        userId: user.id,
        avatar: updated.avatar,
      });
    }

    return { success: true, avatar: updated.avatar };
  }

  @SubscribeMessage('chat:send')
  async handleChatMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ChatSendPayload,
  ) {
    const user = await this.getOrAuthenticateUser(client);
    const roomId = client.data?.roomId;

    if (!user) {
      return { success: false, error: 'Unauthorized: User session not found' };
    }

    if (!roomId) {
      return { success: false, error: 'You must join a room before chatting' };
    }

    if (!data?.content?.trim()) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const saved = await this.chatService.saveMessage(
      roomId,
      user.id,
      data.content,
    );

    const chatEvent = {
      id: saved.id,
      roomId: saved.roomId,
      senderId: saved.senderId,
      senderName: saved.sender.displayName,
      content: saved.content,
      createdAt: saved.createdAt.toISOString(),
    };

    this.server.to(roomId).emit('chat:message', chatEvent);

    return { success: true, message: chatEvent };
  }

  @SubscribeMessage('chat:dm')
  async handleDirectMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: DirectMessagePayload,
  ) {
    const user = await this.getOrAuthenticateUser(client);
    const roomId = client.data?.roomId;

    if (!user) {
      return { success: false, error: 'Unauthorized: User session not found' };
    }

    if (!roomId) {
      return { success: false, error: 'You must join a room before chatting' };
    }

    if (!data?.recipientId) {
      return { success: false, error: 'recipientId is required' };
    }

    if (!data?.content?.trim()) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const saved = await this.chatService.saveMessage(
      roomId,
      user.id,
      data.content,
      { recipientId: data.recipientId },
    );

    const dmEvent = {
      id: saved.id,
      roomId: saved.roomId,
      senderId: saved.senderId,
      senderName: saved.sender.displayName,
      recipientId: saved.recipientId,
      content: saved.content,
      createdAt: saved.createdAt.toISOString(),
    };

    // Deliver to recipient socket if online
    const targetSocketId = this.userSockets.get(data.recipientId);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('chat:dm', dmEvent);
    }

    // Deliver confirmation back to sender socket
    client.emit('chat:dm', dmEvent);

    return { success: true, message: dmEvent };
  }

  @SubscribeMessage('chat:zone')
  async handleZoneMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ZoneMessagePayload,
  ) {
    const user = await this.getOrAuthenticateUser(client);
    const roomId = client.data?.roomId;

    if (!user) {
      return { success: false, error: 'Unauthorized: User session not found' };
    }

    if (!roomId) {
      return { success: false, error: 'You must join a room before chatting' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    const player = room.players.get(user.id);
    if (!player || !player.currentZoneId) {
      return {
        success: false,
        error: 'You must be inside a private meeting zone to use zone chat',
      };
    }

    if (!data?.content?.trim()) {
      return { success: false, error: 'Message cannot be empty' };
    }

    const saved = await this.chatService.saveMessage(
      roomId,
      user.id,
      data.content,
      { zoneId: player.currentZoneId },
    );

    const zoneEvent = {
      id: saved.id,
      roomId: saved.roomId,
      zoneId: player.currentZoneId,
      senderId: saved.senderId,
      senderName: saved.sender.displayName,
      content: saved.content,
      createdAt: saved.createdAt.toISOString(),
    };

    // Deliver only to users currently inside this same private zone
    for (const [peerId, peerPlayer] of room.players) {
      if (peerPlayer.currentZoneId === player.currentZoneId) {
        const peerSocketId = this.userSockets.get(peerId);
        if (peerSocketId) {
          this.server.to(peerSocketId).emit('chat:zone', zoneEvent);
        }
      }
    }

    return { success: true, message: zoneEvent };
  }

  // ==========================================
  // WebRTC Proximity Signaling Handlers
  // ==========================================

  /**
   * Relay SDP Offer to a peer within proximity
   */
  @SubscribeMessage('webrtc:offer')
  handleWebRtcOffer(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: WebRtcSignalPayload,
  ) {
    const check = this.validateSignalTarget(client, data?.targetUserId);
    if (!check.valid) {
      return { success: false, error: check.error };
    }

    this.server.to(check.targetSocketId!).emit('webrtc:offer', {
      fromUserId: client.data.user.id,
      sdp: data.sdp,
    });

    return { success: true };
  }

  /**
   * Relay SDP Answer back to the offer initiator
   */
  @SubscribeMessage('webrtc:answer')
  handleWebRtcAnswer(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: WebRtcSignalPayload,
  ) {
    const check = this.validateSignalTarget(client, data?.targetUserId);
    if (!check.valid) {
      return { success: false, error: check.error };
    }

    this.server.to(check.targetSocketId!).emit('webrtc:answer', {
      fromUserId: client.data.user.id,
      sdp: data.sdp,
    });

    return { success: true };
  }

  /**
   * Relay ICE Candidate for NAT traversal
   */
  @SubscribeMessage('webrtc:ice-candidate')
  handleIceCandidate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: WebRtcSignalPayload,
  ) {
    const check = this.validateSignalTarget(client, data?.targetUserId);
    if (!check.valid) {
      return { success: false, error: check.error };
    }

    this.server.to(check.targetSocketId!).emit('webrtc:ice-candidate', {
      fromUserId: client.data.user.id,
      candidate: data.candidate,
    });

    return { success: true };
  }

  /**
   * Screen Sharing Toggle: Broadcast to nearby peers
   */
  @SubscribeMessage('screen:share-toggle')
  handleScreenShareToggle(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ScreenSharePayload,
  ) {
    const user = client.data?.user;
    const roomId = client.data?.roomId;

    if (!user) return { success: false, error: 'Unauthorized: User session not found' };
    if (!roomId) return { success: false, error: 'Not in a room' };

    const room = this.rooms.get(roomId);
    if (!room) return { success: false, error: 'Room not found' };

    const player = room.players.get(user.id);
    if (!player) return { success: false, error: 'Player not found' };

    player.isScreenSharing = !!data.isSharing;

    // Notify all nearby peers in audio/video range
    for (const peerId of player.nearbyPeers) {
      const peerSocketId = this.userSockets.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('screen:user-sharing', {
          userId: user.id,
          isSharing: player.isScreenSharing,
        });
      }
    }

    return { success: true, isSharing: player.isScreenSharing };
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  private validateSignalTarget(
    client: AuthenticatedSocket,
    targetUserId: string,
  ): { valid: boolean; targetSocketId?: string; error?: string } {
    const user = client.data?.user;
    const roomId = client.data?.roomId;

    if (!roomId || !user) {
      return { valid: false, error: 'You are not in an active room' };
    }

    if (!targetUserId) {
      return { valid: false, error: 'targetUserId is required' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return { valid: false, error: 'Room state not found in memory' };
    }

    const player = room.players.get(user.id);
    if (!player) {
      return { valid: false, error: 'Your presence is not active in this room' };
    }

    // Security: Only allow signaling if target is within proximity range
    if (!player.nearbyPeers.has(targetUserId)) {
      return {
        valid: false,
        error: 'Target user is not within proximity range for media connection',
      };
    }

    const targetSocketId = this.userSockets.get(targetUserId);
    if (!targetSocketId) {
      return { valid: false, error: 'Target user socket is no longer connected' };
    }

    return { valid: true, targetSocketId };
  }

  private getZoneAt(room: RoomState, x: number, y: number): RoomZone | null {
    if (!room.zones || !Array.isArray(room.zones)) return null;
    for (const zone of room.zones) {
      if (
        x >= zone.x &&
        x <= zone.x + zone.width &&
        y >= zone.y &&
        y <= zone.y + zone.height
      ) {
        return zone;
      }
    }
    return null;
  }

  private updateProximity(
    roomId: string,
    player: PlayerState,
    client: AuthenticatedSocket,
  ) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [otherId, otherPlayer] of room.players) {
      if (otherId === player.userId) continue;

      let isNearby = false;

      // Case 1: Both players in the same private meeting zone
      if (
        player.currentZoneId &&
        otherPlayer.currentZoneId &&
        player.currentZoneId === otherPlayer.currentZoneId
      ) {
        isNearby = true;
      }
      // Case 2: One player in a private zone, the other is outside (or in a different private zone)
      else if (player.currentZoneId || otherPlayer.currentZoneId) {
        isNearby = false; // Soundproof barrier!
      }
      // Case 3: Both players in the general/commons area
      else {
        const distance = Math.sqrt(
          Math.pow(player.x - otherPlayer.x, 2) +
            Math.pow(player.y - otherPlayer.y, 2),
        );
        isNearby = distance <= this.PROXIMITY_RADIUS;
      }

      const wasNearby = player.nearbyPeers.has(otherId);
      const otherSocketId = this.userSockets.get(otherId);

      if (isNearby && !wasNearby) {
        player.nearbyPeers.add(otherId);
        otherPlayer.nearbyPeers.add(player.userId);

        client.emit('proximity:enter', {
          peerId: otherId,
          displayName: otherPlayer.displayName,
          zoneId: player.currentZoneId ?? null,
        });

        if (otherSocketId) {
          this.server.to(otherSocketId).emit('proximity:enter', {
            peerId: player.userId,
            displayName: player.displayName,
            zoneId: otherPlayer.currentZoneId ?? null,
          });
        }
      } else if (!isNearby && wasNearby) {
        player.nearbyPeers.delete(otherId);
        otherPlayer.nearbyPeers.delete(player.userId);

        client.emit('proximity:leave', {
          peerId: otherId,
        });

        if (otherSocketId) {
          this.server.to(otherSocketId).emit('proximity:leave', {
            peerId: player.userId,
          });
        }
      }
    }
  }
}

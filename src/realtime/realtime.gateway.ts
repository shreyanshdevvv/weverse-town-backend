import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
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

export interface PlayerState {
  userId: string;
  displayName: string;
  x: number;
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
  lastMoveTime: number;
  nearbyPeers: Set<string>; // userIds currently within proximity range (150px)
}

export interface RoomState {
  width: number;
  height: number;
  players: Map<string, PlayerState>;
}

export interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      email: string;
      displayName: string;
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

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
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
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Connection rejected: No token provided (${client.id})`);
        client.disconnect(true);
        return;
      }

      const payload = await this.jwtService.verifyAsync(token);
      const user = await this.authService.validateUserById(payload.sub);
      if (!user) {
        this.logger.warn(`Connection rejected: User not found (${client.id})`);
        client.disconnect(true);
        return;
      }

      client.data.user = user;
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

        // Notify all nearby peers that this player left proximity
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
    const user = client.data.user;

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

    const spawnX = Math.floor(room.width / 2);
    const spawnY = Math.floor(room.height / 2);

    const playerState: PlayerState = {
      userId: user.id,
      displayName: user.displayName,
      x: spawnX,
      y: spawnY,
      direction: 'down',
      lastMoveTime: Date.now(),
      nearbyPeers: new Set(),
    };

    room.players.set(user.id, playerState);

    // Check proximity on spawn
    this.updateProximity(data.roomId, playerState, client);

    const serializedPlayers = Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      x: p.x,
      y: p.y,
      direction: p.direction,
      nearbyPeers: Array.from(p.nearbyPeers),
    }));

    client.emit('room:state', {
      roomId: data.roomId,
      width: room.width,
      height: room.height,
      players: serializedPlayers,
    });

    client.to(data.roomId).emit('player:joined', {
      userId: playerState.userId,
      displayName: playerState.displayName,
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
        x: playerState.x,
        y: playerState.y,
        direction: playerState.direction,
      },
    };
  }

  @SubscribeMessage('player:move')
  handleMove(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: MovePayload,
  ) {
    const user = client.data.user;
    const roomId = client.data.roomId;

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

    // Run Proximity Engine checks
    this.updateProximity(roomId, currentPlayer, client);

    const moveEvent = {
      userId: user.id,
      x: currentPlayer.x,
      y: currentPlayer.y,
      direction: currentPlayer.direction,
      timestamp: now,
    };

    client.to(roomId).emit('player:moved', moveEvent);

    return { success: true, ...moveEvent };
  }

  /**
   * In-Room Chat: Persists to PostgreSQL and broadcasts to the room channel
   */
  @SubscribeMessage('chat:send')
  async handleChatMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: ChatSendPayload,
  ) {
    const user = client.data.user;
    const roomId = client.data.roomId;

    if (!roomId) {
      return { success: false, error: 'You must join a room before chatting' };
    }

    if (!data?.content?.trim()) {
      return { success: false, error: 'Message cannot be empty' };
    }

    // Save to PostgreSQL via ChatService
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

    // Broadcast to EVERYONE in the room (including sender)
    this.server.to(roomId).emit('chat:message', chatEvent);

    return { success: true, message: chatEvent };
  }

  /**
   * Proximity Engine: Calculates distance to other players in room
   * Emits proximity:enter when d <= 150px
   * Emits proximity:leave when d > 150px
   */
  private updateProximity(
    roomId: string,
    player: PlayerState,
    client: AuthenticatedSocket,
  ) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [otherId, otherPlayer] of room.players) {
      if (otherId === player.userId) continue;

      const distance = Math.sqrt(
        Math.pow(player.x - otherPlayer.x, 2) +
          Math.pow(player.y - otherPlayer.y, 2),
      );

      const isNearby = distance <= this.PROXIMITY_RADIUS;
      const wasNearby = player.nearbyPeers.has(otherId);

      const otherSocketId = this.userSockets.get(otherId);

      if (isNearby && !wasNearby) {
        // ENTER proximity
        player.nearbyPeers.add(otherId);
        otherPlayer.nearbyPeers.add(player.userId);

        client.emit('proximity:enter', {
          peerId: otherId,
          displayName: otherPlayer.displayName,
        });

        if (otherSocketId) {
          this.server.to(otherSocketId).emit('proximity:enter', {
            peerId: player.userId,
            displayName: player.displayName,
          });
        }
      } else if (!isNearby && wasNearby) {
        // LEAVE proximity
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

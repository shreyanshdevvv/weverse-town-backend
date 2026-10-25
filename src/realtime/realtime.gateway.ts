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

export interface PlayerState {
  userId: string;
  displayName: string;
  x: number;
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
  lastMoveTime: number;
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

  // Maximum allowed speed: 400 pixels per second (with buffer for network latency/jitter)
  private readonly MAX_PLAYER_SPEED = 400;

  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly roomsService: RoomsService,
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

    if (user && roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
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

    // 1. Authorize against PostgreSQL
    const isMember = await this.roomsService.isUserInRoom(user.id, data.roomId);
    if (!isMember) {
      return { success: false, error: 'Unauthorized: You are not a member of this room' };
    }

    // 2. Fetch room details to cache dimensions in RAM if not already cached
    if (!this.rooms.has(data.roomId)) {
      const roomDetails = await this.roomsService.findOne(data.roomId, user.id);
      this.rooms.set(data.roomId, {
        width: roomDetails.width,
        height: roomDetails.height,
        players: new Map(),
      });
    }

    const room = this.rooms.get(data.roomId)!;

    // 3. Leave any previous room
    if (client.data.roomId && client.data.roomId !== data.roomId) {
      client.leave(client.data.roomId);
      const prevRoom = this.rooms.get(client.data.roomId);
      if (prevRoom) {
        prevRoom.players.delete(user.id);
        client.to(client.data.roomId).emit('player:left', { userId: user.id });
      }
    }

    // 4. Join Socket.IO channel
    client.join(data.roomId);
    client.data.roomId = data.roomId;

    // 5. Spawn at center of the room map
    const spawnX = Math.floor(room.width / 2);
    const spawnY = Math.floor(room.height / 2);

    const playerState: PlayerState = {
      userId: user.id,
      displayName: user.displayName,
      x: spawnX,
      y: spawnY,
      direction: 'down',
      lastMoveTime: Date.now(),
    };

    room.players.set(user.id, playerState);

    // 6. Send current room snapshot to the joining player
    client.emit('room:state', {
      roomId: data.roomId,
      width: room.width,
      height: room.height,
      players: Array.from(room.players.values()),
    });

    // 7. Broadcast new player presence to everyone else in the room
    client.to(data.roomId).emit('player:joined', playerState);

    this.logger.log(`Player ${user.displayName} joined room ${data.roomId}`);

    return {
      success: true,
      roomId: data.roomId,
      player: playerState,
    };
  }

  /**
   * Server-Authoritative Movement Validation
   */
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

    // Validation 1: Numbers check
    if (
      typeof data.x !== 'number' ||
      typeof data.y !== 'number' ||
      isNaN(data.x) ||
      isNaN(data.y)
    ) {
      return { success: false, error: 'Coordinates must be valid numbers' };
    }

    // Validation 2: Bounding Box (Clamp to map limits)
    if (data.x < 0 || data.x > room.width || data.y < 0 || data.y > room.height) {
      return {
        success: false,
        error: 'Move out of map bounds',
        correctedPosition: { x: currentPlayer.x, y: currentPlayer.y },
      };
    }

    // Validation 3: Speed & Teleportation Check
    const now = Date.now();
    const timeDeltaSeconds = Math.max((now - currentPlayer.lastMoveTime) / 1000, 0.05); // min 50ms interval

    const distance = Math.sqrt(
      Math.pow(data.x - currentPlayer.x, 2) + Math.pow(data.y - currentPlayer.y, 2),
    );

    const calculatedSpeed = distance / timeDeltaSeconds;

    // Reject impossible jumps (speedhack or teleportation)
    if (calculatedSpeed > this.MAX_PLAYER_SPEED && distance > 50) {
      return {
        success: false,
        error: 'Speed violation / teleportation detected',
        correctedPosition: { x: currentPlayer.x, y: currentPlayer.y },
      };
    }

    // Update in-memory state
    currentPlayer.x = data.x;
    currentPlayer.y = data.y;
    currentPlayer.direction = data.direction ?? currentPlayer.direction;
    currentPlayer.lastMoveTime = now;

    const moveEvent = {
      userId: user.id,
      x: currentPlayer.x,
      y: currentPlayer.y,
      direction: currentPlayer.direction,
      timestamp: now,
    };

    // Broadcast movement to all other players in the room
    client.to(roomId).emit('player:moved', moveEvent);

    return { success: true, ...moveEvent };
  }
}

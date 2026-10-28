import {
  Controller,
  Get,
  Param,
  UseGuards,
  ParseUUIDPipe,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

@Controller('rooms/:roomId/messages')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly roomsService: RoomsService,
  ) {}

  @Get()
  async getMessages(
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
  ) {
    const isMember = await this.roomsService.isUserInRoom(user.id, roomId);
    if (!isMember) {
      throw new ForbiddenException('You must be a member of this room to view chat');
    }

    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.chatService.getRoomMessages(roomId, isNaN(parsedLimit) ? 50 : parsedLimit);
  }

  @Get('dm/:peerId')
  async getDirectMessages(
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Param('peerId', new ParseUUIDPipe()) peerId: string,
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
  ) {
    const isMember = await this.roomsService.isUserInRoom(user.id, roomId);
    if (!isMember) {
      throw new ForbiddenException('You must be a member of this room to view chat');
    }

    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.chatService.getDirectMessages(
      roomId,
      user.id,
      peerId,
      isNaN(parsedLimit) ? 50 : parsedLimit,
    );
  }

  @Get('zone/:zoneId')
  async getZoneMessages(
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Param('zoneId') zoneId: string,
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
  ) {
    const isMember = await this.roomsService.isUserInRoom(user.id, roomId);
    if (!isMember) {
      throw new ForbiddenException('You must be a member of this room to view chat');
    }

    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.chatService.getZoneMessages(
      roomId,
      zoneId,
      isNaN(parsedLimit) ? 50 : parsedLimit,
    );
  }
}

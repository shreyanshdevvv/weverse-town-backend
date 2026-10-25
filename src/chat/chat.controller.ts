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
}

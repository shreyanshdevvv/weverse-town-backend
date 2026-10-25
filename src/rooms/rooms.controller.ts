import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { RoomsService } from './rooms.service.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { JoinRoomDto } from './dto/join-room.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';

@Controller('rooms')
@UseGuards(JwtAuthGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  create(@CurrentUser() user: any, @Body() dto: CreateRoomDto) {
    return this.roomsService.create(user.id, dto);
  }

  @Post('join')
  join(@CurrentUser() user: any, @Body() dto: JoinRoomDto) {
    return this.roomsService.join(user.id, dto);
  }

  @Get('my')
  findMyRooms(@CurrentUser() user: any) {
    return this.roomsService.findMyRooms(user.id);
  }

  @Get(':id')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: any,
  ) {
    return this.roomsService.findOne(id, user.id);
  }
}

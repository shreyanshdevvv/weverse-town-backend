import {
  IsString,
  MinLength,
  MaxLength,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RoomZoneDto } from './room-zone.dto.js';
import { RoomObstacleDto } from './room-obstacle.dto.js';

export class CreateRoomDto {
  @IsString()
  @MinLength(2, { message: 'Room name must be at least 2 characters' })
  @MaxLength(50, { message: 'Room name cannot exceed 50 characters' })
  name: string;

  @IsOptional()
  @IsInt()
  @Min(2, { message: 'Room must allow at least 2 players' })
  @Max(100, { message: 'Room cannot exceed 100 players' })
  maxPlayers?: number;

  @IsOptional()
  @IsInt()
  @Min(500, { message: 'Width must be at least 500' })
  @Max(5000, { message: 'Width cannot exceed 5000' })
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(500, { message: 'Height must be at least 500' })
  @Max(5000, { message: 'Height cannot exceed 5000' })
  height?: number;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'spawnX must be non-negative' })
  spawnX?: number;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'spawnY must be non-negative' })
  spawnY?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomZoneDto)
  zones?: RoomZoneDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomObstacleDto)
  obstacles?: RoomObstacleDto[];
}

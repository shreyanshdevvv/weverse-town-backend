import {
  IsString,
  MinLength,
  MaxLength,
  IsInt,
  Min,
  Max,
  IsOptional,
} from 'class-validator';

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
  spawnX?: number;

  @IsOptional()
  @IsInt()
  spawnY?: number;

  @IsOptional()
  zones?: any[];
}

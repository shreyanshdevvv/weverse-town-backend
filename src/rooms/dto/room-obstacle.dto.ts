import { IsString, IsInt, Min, Max } from 'class-validator';

export class RoomObstacleDto {
  @IsString()
  id: string;

  @IsInt()
  @Min(0)
  x: number;

  @IsInt()
  @Min(0)
  y: number;

  @IsInt()
  @Min(1)
  @Max(5000)
  width: number;

  @IsInt()
  @Min(1)
  @Max(5000)
  height: number;
}

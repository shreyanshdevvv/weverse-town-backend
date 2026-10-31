import { IsString, IsInt, Min, Max } from 'class-validator';

export class RoomZoneDto {
  @IsString()
  id: string;

  @IsString()
  name: string;

  @IsInt()
  @Min(0)
  x: number;

  @IsInt()
  @Min(0)
  y: number;

  @IsInt()
  @Min(10)
  @Max(5000)
  width: number;

  @IsInt()
  @Min(10)
  @Max(5000)
  height: number;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class SuggestionDto {
  @IsIn(['issue', 'workstream', 'decision']) kind:
    'issue' | 'workstream' | 'decision';
  @IsString() @MaxLength(300) title: string;
  @IsString() @MaxLength(12000) description: string;
}

class MessageDto {
  @IsIn(['user', 'assistant']) role: 'user' | 'assistant';
  @IsString() @MinLength(1) @MaxLength(16000) content: string;
}

export class ChatContextDto {
  @IsIn(['page', 'issue', 'workstream', 'project', 'decision']) kind:
    'page' | 'issue' | 'workstream' | 'project' | 'decision';
  @IsString() @MaxLength(160) label: string;
  @IsOptional() @IsString() @MaxLength(160) id?: string;
}

export class ChatDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages: MessageDto[];
  @IsOptional()
  @ValidateNested()
  @Type(() => ChatContextDto)
  context?: ChatContextDto;
}

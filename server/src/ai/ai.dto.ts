import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

class DraftOptionDto {
  @IsString() @MaxLength(160) id: string;
  @IsString() @MaxLength(240) label: string;
}

class DraftWorkstreamOptionDto {
  @IsString() @MaxLength(160) id: string;
  @IsString() @MaxLength(40) key: string;
  @IsString() @MaxLength(240) title: string;
  @IsString() @MaxLength(500) objective: string;
}

class DraftSimilarIssueDto {
  @IsString() @MaxLength(40) key: string;
  @IsString() @MaxLength(240) title: string;
  @IsString() @MaxLength(40) kind: string;
  @IsString() @MaxLength(40) priority: string;
  @IsOptional() @IsNumber() estimate: number | null;
  @IsOptional() @IsNumber() cycleDays: number | null;
}

class IssueDraftOptionsDto {
  @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true }) kinds: string[];
  @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(40, { each: true }) priorities: string[];
  @IsArray() @ArrayMaxSize(12) @IsNumber({}, { each: true }) estimates: number[];
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => DraftOptionDto) teams: DraftOptionDto[];
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DraftOptionDto) assignees: DraftOptionDto[];
  @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => DraftWorkstreamOptionDto) workstreams: DraftWorkstreamOptionDto[];
  @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => DraftSimilarIssueDto) similar: DraftSimilarIssueDto[];
}

export class SuggestionDto {
  @IsIn(['issue', 'workstream', 'decision']) kind:
    'issue' | 'workstream' | 'decision';
  @IsString() @MaxLength(300) title: string;
  @IsString() @MaxLength(12000) description: string;
  @IsOptional() @ValidateNested() @Type(() => IssueDraftOptionsDto) issueOptions?: IssueDraftOptionsDto;
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

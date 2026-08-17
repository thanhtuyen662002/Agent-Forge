import crypto from 'crypto';
import {
  ManagerProtocol,
  ManagerProtocolSchema,
  CoderProtocol,
  CoderProtocolSchema,
  HandoffProtocol,
  HandoffProtocolSchema,
  CoderReportProtocol,
  CoderReportProtocolSchema,
} from '../types/protocols';

export type ParsedProtocolData =
  | { type: 'manager.v1'; data: ManagerProtocol }
  | { type: 'coder.v1'; data: CoderProtocol }
  | { type: 'handoff.v1'; data: HandoffProtocol }
  | { type: 'coder-report.v1'; data: CoderReportProtocol };

export interface ParseResult {
  success: boolean;
  protocolType?: string;
  data?: ParsedProtocolData;
  payloadHash?: string;
  rawJson?: string;
  error?: string;
}

export class ProtocolParser {
  public static extractJsonString(rawInput: string): string | null {
    const trimmed = rawInput.trim();

    // 1. Direct JSON Check
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        // Fall through to regex/block search
      }
    }

    // 2. Markdown Code Fence Extraction (```json ... ``` or ``` ... ```)
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(rawInput)) !== null) {
      const blockContent = match[1].trim();
      if (blockContent.startsWith('{') && blockContent.endsWith('}')) {
        try {
          JSON.parse(blockContent);
          return blockContent;
        } catch {
          // Keep searching
        }
      }
    }

    // 3. Balanced Curly Braces Extraction in Prose
    const firstBrace = rawInput.indexOf('{');
    const lastBrace = rawInput.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = rawInput.substring(firstBrace, lastBrace + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Cannot parse balanced block
      }
    }

    return null;
  }

  public static parse(input: string): ParseResult {
    if (!input || input.trim().length === 0) {
      return { success: false, error: 'Empty protocol input.' };
    }

    const jsonString = this.extractJsonString(input);
    if (!jsonString) {
      return {
        success: false,
        error: 'No valid JSON protocol block found in the provided text. Ensure the response contains a JSON object.',
      };
    }

    let parsedObj: Record<string, unknown>;
    try {
      parsedObj = JSON.parse(jsonString);
    } catch (err: unknown) {
      return {
        success: false,
        error: `JSON syntax error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const protocol = parsedObj.protocol;
    if (!protocol || typeof protocol !== 'string') {
      return {
        success: false,
        error: 'Missing required "protocol" discriminator field in JSON payload.',
      };
    }

    const payloadHash = crypto.createHash('sha256').update(jsonString, 'utf8').digest('hex');

    try {
      switch (protocol) {
        case 'manager.v1': {
          const validated = ManagerProtocolSchema.parse(parsedObj);
          return {
            success: true,
            protocolType: 'manager.v1',
            data: { type: 'manager.v1', data: validated },
            payloadHash,
            rawJson: jsonString,
          };
        }
        case 'coder.v1': {
          const validated = CoderProtocolSchema.parse(parsedObj);
          return {
            success: true,
            protocolType: 'coder.v1',
            data: { type: 'coder.v1', data: validated },
            payloadHash,
            rawJson: jsonString,
          };
        }
        case 'handoff.v1': {
          const validated = HandoffProtocolSchema.parse(parsedObj);
          return {
            success: true,
            protocolType: 'handoff.v1',
            data: { type: 'handoff.v1', data: validated },
            payloadHash,
            rawJson: jsonString,
          };
        }
        case 'coder-report.v1': {
          const validated = CoderReportProtocolSchema.parse(parsedObj);
          return {
            success: true,
            protocolType: 'coder-report.v1',
            data: { type: 'coder-report.v1', data: validated },
            payloadHash,
            rawJson: jsonString,
          };
        }
        default:
          return {
            success: false,
            error: `Unsupported protocol version: "${protocol}". Supported versions: manager.v1, coder.v1, handoff.v1, coder-report.v1.`,
          };
      }
    } catch (validationErr: any) {
      const issues = validationErr.errors
        ? validationErr.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')
        : validationErr.message;
      return {
        success: false,
        protocolType: protocol,
        error: `Protocol validation failed: ${issues}`,
      };
    }
  }
}

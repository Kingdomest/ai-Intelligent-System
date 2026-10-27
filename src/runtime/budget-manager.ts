import type { Attachment } from '../domain/contracts.js';

export interface BudgetConfig {
  maxContextTokens: number;
  outputReserveTokens: number;
  maxTaskDurationMs?: number;
  maxSteps?: number;
  maxRetries?: number;
}

export interface BudgetInput {
  message: string;
  attachments: Array<Pick<Attachment, 'filename'> & { content?: string }>;
}

export interface BudgetSnapshot {
  estimatedInputTokens: number;
  outputReserveTokens: number;
  fits: boolean;
  reason?: string;
}

export class BudgetManager {
  public readonly config: Required<BudgetConfig>;

  constructor(config: BudgetConfig) {
    this.config = {
      maxTaskDurationMs: 120_000,
      maxSteps: 50,
      maxRetries: 5,
      ...config,
    };
  }

  check(input: BudgetInput): BudgetSnapshot {
    const estimatedInputTokens = this.estimateTokens(input);
    const available = this.config.maxContextTokens - this.config.outputReserveTokens;
    return {
      estimatedInputTokens,
      outputReserveTokens: this.config.outputReserveTokens,
      fits: estimatedInputTokens <= available,
      reason: estimatedInputTokens > available ? 'context budget exceeded' : undefined,
    };
  }

  compact(input: BudgetInput): BudgetInput {
    const availableCharacters = Math.max(
      input.message.length + 80,
      (this.config.maxContextTokens - this.config.outputReserveTokens) * 4,
    );
    const remaining = Math.max(160, availableCharacters - input.message.length);
    const perAttachment = Math.max(80, Math.floor(remaining / Math.max(1, input.attachments.length)));
    return {
      message: input.message,
      attachments: input.attachments.map((attachment) => ({
        ...attachment,
        content: attachment.content && attachment.content.length > perAttachment
          ? `${attachment.content.slice(0, Math.floor(perAttachment * 0.75))}\n...[内容已压缩，保留来源索引]...\n${attachment.content.slice(-Math.floor(perAttachment * 0.2))}`
          : attachment.content,
      })),
    };
  }

  private estimateTokens(input: BudgetInput): number {
    const characters = input.message.length + input.attachments.reduce(
      (total, attachment) => total + attachment.filename.length + (attachment.content?.length ?? 0),
      0,
    );
    return Math.ceil(characters / 4);
  }
}

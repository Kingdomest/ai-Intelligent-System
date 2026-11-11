import type { TaskEvent } from '../domain/contracts.js';
import { sanitizeAnswerSources, type AnswerSource } from '../domain/answer-sources.js';
export { sanitizeAnswerSources, type AnswerSource } from '../domain/answer-sources.js';

export function answerSourcesFromEvents(events: TaskEvent[]): AnswerSource[] {
  return sanitizeAnswerSources(events.flatMap(event =>
    event.type === 'research.searched' || event.type === 'answer.sources'
      ? Array.isArray(event.payload.sources) ? event.payload.sources : []
      : []));
}

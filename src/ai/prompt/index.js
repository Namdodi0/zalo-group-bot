import { renderSearchContext, needsTimeContext, timeContextText } from './entries.js';
import { createPromptRegistry } from './registry.js';
import { registerZaloSections } from './sections.js';

export { createPromptRegistry } from './registry.js';

/**
 * Build the prompt registry for one turn: static sections + tool guidance + runtime context.
 * @param {{botName?: string, chatType?: string, searchEnabled?: boolean, imageEnabled?: boolean, stickerEnabled?: boolean, tone?: string, tools?: any[]}} [options]
 */
export function createZaloPrompt(options = {}) {
  const registry = createPromptRegistry();
  registerZaloSections(registry, options);

  // Tool guidance follows the schemas actually sent; flags are a fallback for older callers.
  /** @type {string[]} */
  const toolNames = options.tools
    ? options.tools.map((tool) => tool?.function?.name).filter(Boolean)
    : [
        ...(options.searchEnabled ? ['web_search'] : []),
        ...(options.imageEnabled ? ['send_image'] : []),
        ...(options.stickerEnabled ? ['send_sticker'] : []),
      ];
  registry.tools(() => ({ schemas: options.tools ?? [], names: toolNames }));

  registry.context({
    name: 'runtime:time',
    order: 0,
    text: (ctx) => (needsTimeContext(ctx.text) ? timeContextText(ctx.now) : ''),
  });

  return registry;
}

export const buildSearchContext = renderSearchContext;

export const SUMMARY_SYSTEM_PROMPT =
  'You summarise conversations. Write one short paragraph in English (max 600 characters) keeping: personal details the user stated, the topic under discussion, decisions and important answers. Return only the summary, no preamble.';

/** @param {Array<{role: string, text: string, name?: string}>} messages */
export function buildSummaryInput(messages) {
  return messages
    .map((message) => `${message.role === 'assistant' ? 'Bot' : message.name || 'User'}: ${message.text}`)
    .join('\n')
    .slice(0, 12_000);
}

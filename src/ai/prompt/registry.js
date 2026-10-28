export class PromptVariableError extends Error {
  /** @param {string} message @param {{section?: string, variable?: string}} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PromptVariableError';
    this.section = meta.section;
    this.variable = meta.variable;
  }
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const REFERENCE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** @param {string} text @param {Record<string,string>} variables @param {string} section */
export function interpolate(text, variables, section) {
  return String(text ?? '').replace(REFERENCE, (_match, name) => {
    const value = variables[name];
    if (value === undefined) {
      throw new PromptVariableError(`Prompt variable "${name}" is not registered or has no value (section ${section})`, {
        section,
        variable: name,
      });
    }
    return String(value);
  });
}

/**
 * Registry of sections (static/dynamic text) + runtime context + variables + tool schemas.
 * @param {{onChange?: (event: string, name: string) => void}} [options]
 */
export function createPromptRegistry(options = {}) {
  const notify = options.onChange ?? (() => {});
  /** @type {Map<string, any>} */
  const sections = new Map();
  /** @type {Map<string, any>} */
  const contexts = new Map();
  /** @type {Map<string, (ctx: any) => string|undefined>} */
  const variables = new Map();
  /** @type {Array<(ctx: any) => {schemas?: any[], names?: string[]}>} */
  const toolProviders = [];

  /** @param {number} order @param {string} name */
  function checkOrder(order, name) {
    if (!Number.isFinite(order)) throw new Error(`Prompt section "${name}" requires a finite order`);
  }

  function sortEntries(entries) {
    return [...entries].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  /** @param {{name: string, order: number, text: string|((ctx: any) => string), interpolate?: boolean, complete?: boolean}} section */
  function section(section) {
    if (!section?.name) throw new Error('Prompt section requires a name');
    if (sections.has(section.name)) throw new Error(`Duplicate prompt section name: ${section.name}`);
    checkOrder(section.order, section.name);
    sections.set(section.name, { ...section, interpolate: section.interpolate !== false, complete: Boolean(section.complete) });
    notify('section', section.name);
    return () => {
      sections.delete(section.name);
      notify('section', section.name);
    };
  }

  /** @param {{name: string, order: number, text: string|((ctx: any) => string), interpolate?: boolean, required?: boolean}} context */
  function context(context) {
    if (!context?.name) throw new Error('Prompt context requires a name');
    if (contexts.has(context.name)) throw new Error(`Duplicate prompt context name: ${context.name}`);
    checkOrder(context.order, context.name);
    contexts.set(context.name, { ...context, interpolate: context.interpolate !== false, required: Boolean(context.required) });
    notify('context', context.name);
    return () => {
      contexts.delete(context.name);
      notify('context', context.name);
    };
  }

  /** @param {string} name @param {(ctx: any) => string|undefined} provider */
  function variable(name, provider) {
    if (!VARIABLE_NAME.test(name)) throw new Error(`Invalid prompt variable name: ${name}`);
    if (variables.has(name)) throw new Error(`Duplicate prompt variable name: ${name}`);
    variables.set(name, provider);
    notify('variable', name);
    return () => {
      variables.delete(name);
      notify('variable', name);
    };
  }

  /** @param {(ctx: any) => {schemas?: any[], names?: string[]}} provider */
  function tools(provider) {
    toolProviders.push(provider);
    notify('tools', String(toolProviders.length));
    return () => {
      const index = toolProviders.indexOf(provider);
      if (index >= 0) toolProviders.splice(index, 1);
      notify('tools', String(index));
    };
  }

  /** @param {any} entry @param {any} ctx */
  function resolveText(entry, ctx) {
    return typeof entry.text === 'function' ? entry.text(ctx) : entry.text;
  }

  /**
   * Assemble one turn: resolve sections/contexts/variables and tool names.
   * @param {any} [ctx]
   */
  function assemble(ctx = {}) {
    /** @type {Record<string,string>} */
    const resolvedVariables = {};
    for (const [name, provider] of variables) {
      const value = provider(ctx);
      if (value !== undefined) resolvedVariables[name] = String(value);
    }

    const toolNames = new Set();
    for (const provider of toolProviders) {
      const result = provider({ ...ctx, variables: resolvedVariables }) ?? {};
      for (const name of result.names ?? []) toolNames.add(name);
      for (const schema of result.schemas ?? []) {
        const name = schema?.function?.name;
        if (name) toolNames.add(name);
      }
    }

    const view = { ...ctx, variables: resolvedVariables, toolNames };
    /** @type {any[]} */
    const resolvedSections = [];
    /** @type {any[]} */
    const completeSections = [];
    for (const entry of sortEntries(sections.values())) {
      const text = String(resolveText(entry, view) ?? '');
      const resolved = { name: entry.name, order: entry.order, text, interpolate: entry.interpolate };
      if (entry.complete) completeSections.push(resolved);
      else resolvedSections.push(resolved);
    }
    if (completeSections.length > 1) {
      throw new Error(`Only one complete prompt section is allowed, got: ${completeSections.map((s) => s.name).join(', ')}`);
    }

    const resolvedContexts = sortEntries(contexts.values()).map((entry) => ({
      name: entry.name,
      order: entry.order,
      text: String(resolveText(entry, view) ?? '').trim(),
      interpolate: entry.interpolate,
      required: entry.required,
    }));

    return {
      sections: completeSections.length ? completeSections : resolvedSections,
      contexts: resolvedContexts,
      variables: resolvedVariables,
      toolNames,
    };
  }

  /** @param {ReturnType<typeof assemble>} assembly */
  function render(assembly) {
    /** @type {string[]} */
    const parts = [];
    for (const section of assembly.sections) {
      let text = section.text;
      if (!text || !text.trim()) continue;
      if (section.interpolate !== false) text = interpolate(text, assembly.variables, section.name);
      if (!text.trim()) continue;
      parts.push(text);
    }
    return parts.join('\n');
  }

  return { section, context, variable, tools, assemble, render, has: (name) => sections.has(name) };
}

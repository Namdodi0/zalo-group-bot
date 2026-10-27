import { formatDuration } from '../text/format.js';

/**
 * @param {string} text
 * @returns {{name: string, args: string}|null}
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/**
 * @param {{config: any, store: ReturnType<typeof import('../context/store.js').createContextStore>, metrics: ReturnType<typeof import('../metrics.js').createMetrics>, zalo: ReturnType<typeof import('../zalo/client.js').createZaloClient>, http: ReturnType<typeof import('../http.js').createHttp>, models: ReturnType<typeof import('../ai/router.js').createModelRouter>, stickers?: ReturnType<typeof import('../ai/stickers.js').createStickerStore>, logger?: import('../logger.js').Logger}} deps
 */
export function createCommands(deps) {
  const { config, store, metrics, zalo, models } = deps;
  const http = deps.http;
  const stickers = deps.stickers;
  const logger = deps.logger;

  function canManage(ctx) {
    if (!config.adminIds.length) return true;
    if (ctx.chatType !== 'GROUP') return true;
    return config.adminIds.includes(ctx.senderId);
  }

  function helpText() {
    const lines = [
      '**Các lệnh của bot**',
      '• `/help` — danh sách lệnh',
      '• `/status` — trạng thái bot, context, độ trễ',
      '• `/id` — id của chat hiện tại',
      '• `/reset` — xoá ngữ cảnh của chat này (giữ model/tone); `/reset all` xoá cả cài đặt',
      '• `/search <câu hỏi>` — bắt buộc tìm web cho câu hỏi',
      '• `/image <từ khoá>` — tìm và gửi ảnh',
      '• `/sticker [cảm xúc]` — gửi sticker; `/sticker add <id> [tên]` để thêm ID',
      '• `/model` — xem/đổi model cho chat này',
      '• `/tone` — xem/đổi giọng điệu (roast = cà khịa)',
      '• `/think on|off|low|high` — bật/tắt suy luận cho chat này',
      '• `/ping` — kiểm tra kết nối tới Zalo',
      '',
      config.mode === 'polling'
        ? 'Bot đang chạy chế độ polling (local).'
        : 'Bot đang chạy chế độ webhook.',
      'Trong group, hãy **@mention bot** hoặc **reply** vào tin của bot để bot trả lời.',
    ];
    return lines.join('\n');
  }

  /** @param {{chatId: string, chatType: string, senderId: string}} ctx @param {any} record */
  async function statusText(ctx, record) {
    const snapshot = metrics.snapshot();
    const nimLatency = snapshot.latency['llm.latency'];
    const replyLatency = snapshot.latency['agent.reply'];
    const count = (name) => snapshot.counters[name] ?? 0;
    const messages = record?.messages?.length ?? 0;
    const thinking = record?.meta?.thinking ?? 'theo cấu hình';
    const current = models.resolve(record);
    const contextBudget =
      config.context.maxTokens > 0 || config.context.maxMessages > 0
        ? `${config.context.maxTokens > 0 ? `${config.context.maxTokens} token` : '∞ token'} / ${
            config.context.maxMessages > 0 ? `${config.context.maxMessages} tin` : '∞ tin'
          }`
        : 'không giới hạn';
    const replyLimit =
      config.maxMessagesPerReply > 0 ? `${config.maxMessagesPerReply} tin` : 'không giới hạn';
    const generationSpeed = Number(snapshot.gauges?.['llm.tokensPerSec'] ?? 0);
    const contextFiles = typeof store.count === 'function' ? await store.count() : null;
    const contextStore = `• Lưu context: \`${config.context.dir}\`${
      contextFiles === null ? '' : ` · ${contextFiles} file`
    } · TTL ${config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'không xoá'}`;

    /** @type {string[]} */
    const lines = [
      '**Trạng thái bot**',
      `• Model: \`${current.alias}\` — ${current.label} (\`${current.model}\`, ${current.provider})`,
      `• Mode: ${config.mode} · Reasoning: ${config.ai.reasoning} (chat này: ${thinking})`,
      `• max_tokens: ${config.ai.maxTokens ?? 'không giới hạn'}`,
      `• Uptime: ${formatDuration(snapshot.uptimeSec * 1000)} · bot v${config.version ?? '?'}`,
      `• Context: ${messages} tin · ${record?.turns ?? 0} lượt · ngân sách: ${contextBudget} · tóm tắt: ${record?.summary ? 'có' : 'chưa'}`,
      contextStore,      `• Giới hạn tin trả lời: ${replyLimit}`,
      `• Độ trễ LLM: p50 ${nimLatency ? `${nimLatency.p50}ms` : 'n/a'} · p95 ${nimLatency ? `${nimLatency.p95}ms` : 'n/a'}${generationSpeed > 0 ? ` · ~${generationSpeed} tok/s` : ''}`,
      `• Phản hồi: p50 ${replyLatency ? `${replyLatency.p50}ms` : 'n/a'} · p95 ${replyLatency ? `${replyLatency.p95}ms` : 'n/a'}`,
      `• Tin nhận: ${count('messages.in')} · Đã trả lời: ${count('messages.replied')} · Lỗi: ${count('messages.error')}`,
      `• Web search: ${config.search.enabled ? `${config.search.depth}/${config.search.maxResults} (auto: ${config.search.auto ? 'on' : 'off'})` : 'tắt'} · Ảnh: ${config.image.enabled ? 'bật' : 'tắt'}`,
      `• Emoji: ${config.emoji ? 'bật' : 'tắt'} · Typing: ${config.typing ? 'bật' : 'tắt'} · Progressive: ${config.progressive}`,
      `• Chat: \`${ctx.chatId}\` (${ctx.chatType})`,
    ];

    if (http?.listStates) {
      /** @type {Map<string, {service: string, failures: number, open: boolean}>} */
      const states = new Map();
      for (const state of http.listStates()) states.set(state.service, state);
      for (const name of ['zalo', 'tavily']) {
        if (!states.has(name)) states.set(name, { service: name, failures: 0, open: false });
      }
      const parts = [...states.values()].map(
        (state) => `${state.service}: ${state.open ? `mở (${state.failures} lỗi)` : 'ok'}`,
      );
      lines.push(`• Circuit: ${parts.join(' · ')}`);
    }

    return lines.join('\n');
  }

  /**
   * @param {{name: string, args: string}} command
   * @param {{chatId: string, chatType: string, senderId: string, senderName: string, record: any}} ctx
   */
  async function run(command, ctx) {
    const name = command.name;
    const args = command.args;

    switch (name) {
      case 'help':
        return { kind: 'text', text: helpText() };

      case 'id':
        return {
          kind: 'text',
          text: `Chat id: \`${ctx.chatId}\`\nLoại: ${ctx.chatType}\nNgười gửi: ${ctx.senderName} (\`${ctx.senderId}\`)`,
        };

      case 'reset': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Chỉ admin của group mới được dùng /reset.' };
        }
        const full = args.trim().toLowerCase() === 'all';
        const turns = ctx.record?.turns ?? 0;
        await store.reset(ctx.chatId, { keepMeta: !full });
        logger?.info('context reset', { chatId: ctx.chatId, turns, full });
        return {
          kind: 'text',
          text: full
            ? `Đã xoá sạch ngữ cảnh và cài đặt của chat này (${turns} lượt). Chat như mới.`
            : `Đã xoá ngữ cảnh của chat này (${turns} lượt), vẫn giữ cài đặt (model/tone/think). Dùng \`/reset all\` nếu muốn xoá cả cài đặt.`,
        };
      }

      case 'status':
        return { kind: 'text', text: await statusText(ctx, ctx.record) };

      case 'search': {
        if (!args) return { kind: 'text', text: 'Dùng: `/search <câu hỏi>`' };
        if (!config.search.enabled) return { kind: 'text', text: 'Web search đang tắt trong cấu hình.' };
        return { kind: 'search', query: args };
      }

      case 'image': {
        if (!args) return { kind: 'text', text: 'Dùng: `/image <từ khoá>`' };
        if (!config.image.enabled) return { kind: 'text', text: 'Tính năng gửi ảnh đang tắt.' };
        return { kind: 'image', query: args };
      }

      case 'sticker': {
        if (!config.sticker.enabled) {
          return { kind: 'text', text: 'Tính năng sticker đang tắt trong cấu hình.' };
        }
        if (!stickers) {
          return { kind: 'text', text: 'Chưa có catalog sticker.' };
        }
        const raw = args.trim();
        const lower = raw.toLowerCase();

        const listText = () => {
          const items = stickers.list();
          return [
            `**Sticker** — ${items.length} ID khả dụng`,
            'Gửi: `/sticker <tên hoặc cảm xúc>`. Admin thêm ID bằng `/sticker add <id> [tên]`.',
            'Chỉ nhận **sticker ID chính thức** (20 hex); ID gói trên stickers.zaloapp.com sẽ bị Zalo trả lỗi 425.',
            '',
            ...items
              .slice(0, 20)
              .map(
                (item) =>
                  `• \`${item.id}\` — ${item.name}${item.tags.length ? ` (${item.tags.slice(0, 3).join(', ')})` : ''}`,
              ),
          ].join('\n');
        };

        if (!raw || lower === 'list' || lower === 'danh sách') {
          return { kind: 'text', text: listText() };
        }

        if (lower === 'add' || lower.startsWith('add ')) {
          if (!canManage(ctx)) {
            return { kind: 'text', text: 'Chỉ admin của group mới được thêm sticker.' };
          }
          const rest = raw.slice(3).trim();
          const [idPart, ...nameParts] = rest.split(/\s+/);
          if (!idPart) return { kind: 'text', text: 'Dùng: `/sticker add <id> [tên]`' };
          if (!/^[a-f0-9]{20}$/i.test(idPart)) {
            return { kind: 'text', text: 'Sticker ID phải đúng 20 ký tự hex (ví dụ `0e078a2fb66a5f34067b`).' };
          }
          try {
            // gửi thử để Zalo xác nhận ID hợp lệ
            await zalo.sendSticker(ctx.chatId, idPart);
          } catch (error) {
            return {
              kind: 'text',
              text: `Zalo từ chối sticker \`${idPart}\`: ${String(/** @type {any} */ (error)?.message ?? error)}`,
            };
          }
          try {
            const { item, added } = await stickers.add({ id: idPart, name: nameParts.join(' ') || undefined });
            return {
              kind: 'text',
              text: added
                ? `Đã thêm và gửi thử sticker **${item.name}** (\`${item.id}\`).`
                : `Sticker **${item.name}** đã có sẵn — vừa gửi thử.`,
            };
          } catch (error) {
            return { kind: 'text', text: `Không lưu được sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` };
          }
        }

        if (lower === 'remove' || lower === 'xoa' || lower.startsWith('remove ') || lower.startsWith('xoa ')) {
          if (!canManage(ctx)) {
            return { kind: 'text', text: 'Chỉ admin của group mới được xoá sticker.' };
          }
          const target = raw.replace(/^(remove|xoa)\s+/i, '').trim();
          if (!target) return { kind: 'text', text: 'Dùng: `/sticker remove <id|tên>`' };
          const removed = await stickers.remove(target);
          return {
            kind: 'text',
            text: removed
              ? `Đã xoá sticker **${removed.name}** (\`${removed.id}\`).`
              : `Không tìm thấy sticker "${target}" trong danh sách tự thêm.`,
          };
        }

        const item = stickers.find(raw);
        if (!item) {
          return { kind: 'text', text: `Không có sticker khớp "${raw}".\n\n${listText()}` };
        }
        return { kind: 'sticker', stickerId: item.id, name: item.name };
      }

      case 'model': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Chỉ admin của group mới được đổi model.' };
        }
        const current = models.resolve(ctx.record);
        if (!args) {
          const lines = [
            `**Model đang dùng:** \`${current.alias}\` — ${current.label} (\`${current.model}\`, ${current.provider})`,
            '',
            '**Đổi model cho chat này:**',
            ...models
              .list()
              .map((item) => `• \`/model ${item.alias}\` — ${item.label} (${item.provider}/${item.model})`),
          ];
          return { kind: 'text', text: lines.join('\n') };
        }
        const picked = models.find(args);
        if (!picked) {
          return {
            kind: 'text',
            text: `Không có model "${args}". Chọn: ${models.list().map((item) => item.alias).join(', ')}`,
          };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        ctx.record.meta.model = picked.alias;
        try {
          store.touch?.(ctx.chatId);
        } catch (error) {
          logger?.debug('persist model failed', { error: String(error) });
        }
        return { kind: 'text', text: `Đã chuyển sang **${picked.label}** (\`${picked.model}\`, ${picked.provider}).` };
      }

      case 'think': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Chỉ admin của group mới được đổi chế độ suy luận.' };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        const value = args.toLowerCase();
        const persist = () => {
          // lưu ngay lựa chọn reasoning cho chat này
          try {
            store.touch?.(ctx.chatId);
          } catch (error) {
            logger?.debug('persist thinking mode failed', { error: String(error) });
          }
        };
        if (!value) {
          return {
            kind: 'text',
            text: `Chế độ suy luận hiện tại: ${ctx.record.meta.thinking ?? 'theo cấu hình'}. Dùng \`/think off|low|high\`.`,
          };
        }
        if (['off', 'none'].includes(value)) {
          ctx.record.meta.thinking = 'off';
          persist();
          return { kind: 'text', text: 'Đã tắt suy luận cho chat này (trả lời nhanh hơn).' };
        }
        if (['on', 'low'].includes(value)) {
          ctx.record.meta.thinking = 'low';
          persist();
          return { kind: 'text', text: 'Đã bật suy luận mức thấp cho chat này.' };
        }
        if (['medium', 'high'].includes(value)) {
          ctx.record.meta.thinking = value;
          persist();
          return { kind: 'text', text: `Đã đặt suy luận mức ${value} cho chat này.` };
        }
        if (['auto', 'default'].includes(value)) {
          ctx.record.meta.thinking = null;
          persist();
          return { kind: 'text', text: 'Đã trở về chế độ suy luận theo cấu hình.' };
        }
        return { kind: 'text', text: 'Giá trị không hợp lệ. Dùng `/think off|low|high|auto`.' };
      }

      case 'tone': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Chỉ admin của group mới được đổi giọng điệu.' };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        const value = args.toLowerCase();
        const persist = () => {
          try {
            store.touch?.(ctx.chatId);
          } catch (error) {
            logger?.debug('persist tone failed', { error: String(error) });
          }
        };
        // Lịch sử chat neo rất mạnh vào giọng cũ. Chèn một tin của bot làm "mốc chuyển giọng"
        // để lượt kế tiếp không bắt chước giọng cũ.
        const markTone = (text) => {
          try {
            if (Array.isArray(ctx.record.messages)) {
              ctx.record.messages.push({
                role: 'assistant',
                text,
                ts: Date.now(),
                imageUrl: null,
              });
            }
          } catch (error) {
            logger?.debug('mark tone failed', { error: String(error) });
          }
          persist();
        };
        if (!value) {
          return {
            kind: 'text',
            text: `Giọng điệu chat này: **${ctx.record.meta.tone ?? config.tone}** (cấu hình chung: ${config.tone}).\nDùng \`/tone roast\` (cà khịa, chửi yêu) hoặc \`/tone friendly\` (lịch sự); \`/tone default\` để theo cấu hình.`,
          };
        }
        if (['max', 'extreme', 'cuc', 'cực', 'sieu-nang', 'siêu nặng', 'gắt', 'gat'].includes(value)) {
          ctx.record.meta.tone = 'roast-extreme';
          markTone('Ok, từ giờ mình chửi không nương tay.');
          return { kind: 'text', text: 'Đã bật giọng **cực gắt** cho chat này 🔥🔥 (vẫn không: gia đình, phân biệt đối xử, đe doạ).' };
        }
        if (['hard', 'roast-hard', 'nang', 'nặng', 'manh', 'mạnh'].includes(value)) {
          ctx.record.meta.tone = 'roast-hard';
          markTone('Ok, từ giờ mình chửi thẳng, nặng lời.');
          return { kind: 'text', text: 'Đã bật giọng **cà khịa nặng** cho chat này 🔥 (vẫn không: phân biệt đối xử, xúc phạm gia đình, đe doạ).' };
        }
        if (['roast', 'cay', 'cakhia', 'cà khịa', 'thô', 'tho'].includes(value)) {
          ctx.record.meta.tone = 'roast';
          markTone('Ok, từ giờ mình cà khịa lại nhé 😈');
          return { kind: 'text', text: 'Đã bật giọng **cà khịa** cho chat này 😈 (vẫn có giới hạn: không phân biệt đối xử, không xúc phạm gia đình).' };
        }
        if (['friendly', 'normal', 'thuong', 'thường', 'lịch sự', 'lich su'].includes(value)) {
          ctx.record.meta.tone = 'friendly';
          markTone('Ok, từ giờ mình nói chuyện lịch sự, bỏ hẳn giọng cà khịa.');
          return { kind: 'text', text: 'Đã trở về giọng lịch sự cho chat này.' };
        }
        if (['default', 'auto', 'reset'].includes(value)) {
          ctx.record.meta.tone = null;
          markTone('Ok, từ giờ mình dùng giọng theo cấu hình của bot.');
          return { kind: 'text', text: `Đã trở về giọng theo cấu hình (${config.tone}).` };
        }
        return { kind: 'text', text: 'Giá trị không hợp lệ. Dùng `/tone roast` hoặc `/tone friendly`.' };
      }

      case 'ping': {
        try {
          const ms = await zalo.ping();
          return { kind: 'text', text: `Pong! Zalo API trả lời trong ${ms}ms.` };
        } catch (error) {
          return { kind: 'text', text: `Ping lỗi: ${String(/** @type {any} */ (error)?.message ?? error)}` };
        }
      }

      default:
        return { kind: 'text', text: `Không rõ lệnh \`/${name}\`. Gõ /help để xem danh sách.` };
    }
  }

  return { run, parseCommand };
}

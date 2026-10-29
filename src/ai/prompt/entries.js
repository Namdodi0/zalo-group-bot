import { formatNow } from '../../text/format.js';

/**
 * Only messages that mention a relative point in time need to know "what day is it today".
 * Ordinary questions get no timestamp so the model does not restate the date for no reason.
 */
export const TIME_HINT_RE =
  /(?:^|[\s,.;:!?()"'“”])(?:hôm nay|hôm qua|hôm kia|hôm trước|hôm bữa|hôm nào|ngày mai|ngày mốt|sáng mai|chiều mai|tối mai|sáng nay|trưa nay|chiều nay|tối nay|đêm nay|tuần này|tuần sau|tuần trước|tuần tới|tuần rồi|tháng này|tháng sau|tháng trước|tháng tới|tháng rồi|năm nay|năm sau|năm trước|năm rồi|cuối tuần|đầu tuần|cuối tháng|đầu tháng|bây giờ|hiện tại|lúc này|mấy giờ|giờ nào|giờ rồi|thứ mấy|ngày mấy|tháng mấy|bao giờ|khi nào|bao lâu|deadline|hạn chót|hạn nộp|mai|mốt|noel|giáng sinh|tết|sinh nhật|today|tonight|tomorrow|yesterday|this week|next week|last week|this month|next month|last month|this year|next year|last year|this weekend|next weekend|now|current time|what time|how long|when|birthday|christmas|new year|deadline)(?=$|[\s,.;:!?()"'“”])/i;

/** @param {string} text */
export function needsTimeContext(text) {
  return TIME_HINT_RE.test(String(text ?? ''));
}

/**
 * Current-time line, materialised as a durable user message.
 * The marker is kept verbatim because the system rules reference it by that exact text.
 * @param {Date} [date]
 */
export function timeContextText(date = new Date()) {
  return `[Current time: ${formatNow(date)} — use only to resolve relative dates/times; do not restate it unless the user asks]`;
}

/** @param {string} query @param {string} formattedResults */
export function renderSearchContext(query, formattedResults) {
  return [
    `Web search results for the query: "${query}"`,
    '',
    formattedResults,
    '',
    'Answer the user\'s question using these results and cite the source URLs (paste bare URLs). If nothing is relevant, say plainly that you could not find a fitting source.',
  ].join('\n');
}

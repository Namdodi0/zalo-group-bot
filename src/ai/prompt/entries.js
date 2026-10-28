import { formatNow } from '../../text/format.js';

/**
 * Tin nhắn có nhắc mốc thời gian tương đối mới cần biết "hôm nay là ngày nào".
 * Câu hỏi thường không chèn giờ để model không nhắc lại ngày giờ vô cớ.
 */
export const TIME_HINT_RE =
  /(?:^|[\s,.;:!?()"'“”])(?:hôm nay|hôm qua|hôm kia|hôm trước|hôm bữa|hôm nào|ngày mai|ngày mốt|sáng mai|chiều mai|tối mai|sáng nay|trưa nay|chiều nay|tối nay|đêm nay|tuần này|tuần sau|tuần trước|tuần tới|tuần rồi|tháng này|tháng sau|tháng trước|tháng tới|tháng rồi|năm nay|năm sau|năm trước|năm rồi|cuối tuần|đầu tuần|cuối tháng|đầu tháng|bây giờ|hiện tại|lúc này|mấy giờ|giờ nào|giờ rồi|thứ mấy|ngày mấy|tháng mấy|bao giờ|khi nào|bao lâu|deadline|hạn chót|hạn nộp|mai|mốt|noel|giáng sinh|tết|sinh nhật)(?=$|[\s,.;:!?()"'“”])/i;

/** @param {string} text */
export function needsTimeContext(text) {
  return TIME_HINT_RE.test(String(text ?? ''));
}

/**
 * Dòng thời gian hiện tại, materialize thành message user bền vững.
 * @param {Date} [date]
 */
export function timeContextText(date = new Date()) {
  return `[Thời gian hiện tại: ${formatNow(date)} — chỉ dùng để quy đổi mốc thời gian tương đối, không nhắc lại ngày giờ trừ khi người dùng hỏi]`;
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

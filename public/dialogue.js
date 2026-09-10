export const MAX_SCENE = 5000;
const headings = /^(人物|角色|出场人物|场景|时间|地点|场次|集数|备注|字幕|旁白|剧名|标题|内景|外景|第.{1,12}[集场幕])$/;
export const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

export function dialogueRows(text) {
  return normalize(text).split('\n').flatMap((line, index) => {
    const m = line.match(/^([ \t]*([\p{L}][\p{L}\p{N}·_]{0,15})(?:[（(][^）)\n]{1,30}[）)])?[ \t]*[：:][ \t]*)(\S.*)$/u);
    return m && !headings.test(m[2]) ? [{ index, speaker: m[2], prefix: m[1], text: m[3] }] : [];
  });
}

export function validateInput(scene, context = '') {
  if (typeof scene !== 'string' || !scene.trim()) throw new Error('先放入一场剧本，再开始优化。');
  if (scene.length > MAX_SCENE) throw new Error('这一版每次支持 5,000 字，请按场拆开处理。');
  if (typeof context !== 'string' || context.length > 1000) throw new Error('补充背景请控制在 1,000 字以内。');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(scene + context)) throw new Error('文本含有无法处理的控制字符，请重新粘贴纯文本。');
  const rows = dialogueRows(scene);
  if (!rows.length) throw new Error('还没识别到台词。请使用“角色：台词”，每句单独一行。');
  if (rows.length > 80) throw new Error('每次最多处理 80 句台词，请按场拆开。');
  return rows;
}

// Reuses the validation experiment's line/speaker guard; whitespace at line ends is presentation only.
export function validateResult(source, result) {
  if (typeof result !== 'string' || result.length > 20000) throw new Error('模型没有返回完整正文，原稿已保留。');
  const original = normalize(source).split('\n');
  const returned = normalize(result).replace(/\n+$/, '').split('\n');
  const last = original.findLastIndex(line => line !== '');
  if (returned.length !== last + 1) throw new Error('这次改稿的行数发生变化，已拦截，请重试。');
  const rows = new Map(dialogueRows(source).map(row => [row.index, row]));
  const lines = original.map((line, index) => {
    if (index > last) return line;
    const row = rows.get(index), after = returned[index];
    if (!row) {
      if (line.trimEnd() !== after.trimEnd()) throw new Error('这次改稿动到了场景或动作，已拦截，请重试。');
      return line;
    }
    if (!after.startsWith(row.prefix) || !after.slice(row.prefix.length).trim()) throw new Error('这次改稿改变了角色或对白格式，已拦截，请重试。');
    return row.prefix + after.slice(row.prefix.length).trimEnd();
  });
  return lines.join('\n');
}

export function changesBetween(source, result) {
  source = normalize(source);
  const after = validateResult(source, result).split('\n');
  return dialogueRows(source).filter(row => source.split('\n')[row.index] !== after[row.index])
    .map(row => ({ ...row, revised: after[row.index].slice(row.prefix.length) }));
}

// Only explicitly quoted dialogue can change; all other bytes come from the source.
export function applyModelEdits(source, value) {
  if (!value || !Array.isArray(value.edits) || value.edits.length > 80) throw new Error('模型返回的修改列表异常，原稿已保留。');
  const rows = new Map(dialogueRows(source).map(row => [row.index + 1, row]));
  const lines = normalize(source).split('\n'), used = new Set(), reasons = new Map();
  let protectedCount = 0;
  for (const edit of value.edits) {
    if (!edit || !Number.isInteger(edit.line) || !rows.has(edit.line) || used.has(edit.line)) throw new Error('修改位置异常，原稿已保留。');
    const row = rows.get(edit.line);
    if (edit.before !== row.text || typeof edit.after !== 'string' || !edit.after.trim() || edit.after.length > 2000 || /[\r\n\u0000-\u001F]/.test(edit.after) || edit.after.startsWith(row.speaker + '：') || edit.after.startsWith(row.speaker + ':')) throw new Error('修改未能对应原台词，原稿已保留。');
    if (typeof edit.reason !== 'string' || !edit.reason.trim() || edit.reason.length > 200) throw new Error('修改说明异常，原稿已保留。');
    used.add(edit.line);
    // Conservative literal guard: these uncertainty qualifiers must survive verbatim.
    // Other semantic changes still require the author's review.
    if (['不一定', '未必', '不是一定'].some(word => row.text.includes(word) && !edit.after.includes(word))) { protectedCount++; continue; }
    lines[row.index] = row.prefix + edit.after; reasons.set(row.index, edit.reason);
  }
  const revised = validateResult(source, lines.join('\n'));
  return { revised, protectedCount, changes: changesBetween(source, revised).map(change => ({ ...change, reason: reasons.get(change.index) })) };
}

export function applyChoices(source, changes, selected) {
  const lines = normalize(source).split('\n');
  for (const change of changes) if (selected.has(change.index)) lines[change.index] = change.prefix + change.revised;
  return lines.join('\n');
}

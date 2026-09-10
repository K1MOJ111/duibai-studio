import { normalize, dialogueRows, validateInput, validateResult, changesBetween, applyChoices, MAX_SCENE } from './dialogue.js';

const $ = id => document.getElementById(id);
let ready = false, busy = false, source = '', changes = [], selected = new Set(), adopted = false, savedText = '', undoText = '', appliedText = '';
const disabledBefore = new Map();
const dirtyDraft = () => adopted && $('draft').value !== savedText;
function notify(message, kind = '') { $('status').textContent = message; $('status').className = 'feedback ' + kind; }
function stage(name) { for (const step of ['input', 'compare', 'draft']) { $(`step-${step}`).removeAttribute('aria-current'); if (step === name) $(`step-${step}`).setAttribute('aria-current', 'step'); } }
function counts() {
  const text = $('scene').value, rows = dialogueRows(text);
  $('count').textContent = `${text.length.toLocaleString()} / 5,000 字`;
  const names = [...new Set(rows.map(row => row.speaker))];
  $('recognition').textContent = rows.length ? `识别 ${rows.length} 句台词 · ${names.slice(0, 4).join('、')}${names.length > 4 ? '等' : ''}` : '等待你的故事';
  $('optimize').disabled = busy || !ready || !text.trim();
}
function resetResult() {
  source = ''; changes = []; selected.clear(); adopted = false;
  $('result-panel').hidden = true; $('draft-panel').hidden = true; $('empty-note').hidden = false;
  $('draft').value = ''; $('changes').replaceChildren(); stage('input');
}
function setBusy(value) {
  busy = value;
  if (value) {
    for (const control of document.querySelectorAll('button, input, textarea')) { disabledBefore.set(control, control.disabled); control.disabled = true; }
  } else { for (const [control, disabled] of disabledBefore) control.disabled = disabled; disabledBefore.clear(); $('keep-all').disabled = !changes.length; }
  $('form').setAttribute('aria-busy', String(value));
  $('optimize').textContent = value ? '正在打磨…' : '开始打磨 →'; counts();
}
async function confirmLoss(message) {
  $('confirm-text').textContent = message; $('confirm-dialog').showModal();
  return new Promise(resolve => {
    const done = value => { $('confirm-dialog').close(); $('confirm-ok').onclick = null; $('confirm-cancel').onclick = null; $('confirm-dialog').oncancel = null; resolve(value); };
    $('confirm-ok').onclick = () => done(true); $('confirm-cancel').onclick = () => done(false);
    $('confirm-dialog').oncancel = event => { event.preventDefault(); done(false); };
  });
}
function reveal(id) { $(id).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }

for (const id of ['scene', 'context']) {
  $(id).addEventListener('beforeinput', async event => {
    if (!dirtyDraft()) return;
    event.preventDefault();
    if (await confirmLoss('修改输入会清除当前改稿和手动编辑。请先导出需要保留的正文，或继续修改。')) {
      resetResult(); $(id).focus(); notify('已清除上一轮改稿，可以编辑输入。');
    }
  });
  $(id).addEventListener('input', () => { if (source) { resetResult(); notify('输入已更新，重新打磨后再查看对照。'); } counts(); });
}
$('load-example').onclick = async () => {
  if (($('scene').value.trim() || adopted) && !await confirmLoss('载入示例会替换当前输入和改稿。需要保留的正文请先导出。')) return;
  try {
    const response = await fetch('/example.json'); if (!response.ok) throw new Error();
    const example = await response.json(); resetResult(); $('scene').value = example.scene; $('context').value = example.context;
    counts(); notify('已载入原创示例。点击“开始打磨”会真实调用模型。'); $('scene').focus();
  } catch { notify('示例暂时没能载入，你也可以直接粘贴剧本。', 'error'); }
};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; $('file').value = ''; if (!file) return;
  try {
    if (file.size > 30000) throw new Error('文件过大，请导入不超过 5,000 字的一场剧本。');
    const text = normalize(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
    if (text.length > MAX_SCENE) throw new Error('文件超过 5,000 字，请按场拆开。');
    if (($('scene').value.trim() || adopted) && !await confirmLoss('导入文件会替换当前输入和改稿。需要保留的正文请先导出。')) return;
    resetResult(); $('scene').value = text; $('context').value = ''; counts(); notify(`已导入 ${file.name}。`);
  } catch (error) { notify(error instanceof TypeError ? '请将文件保存为 UTF-8 编码的 TXT 后重新导入。' : error.message, 'error'); }
};

function updateAdopt() {
  $('full-original').textContent = source;
  $('full-selected').textContent = applyChoices(source, changes, selected);
  $('adopt').textContent = !changes.length ? '使用这份原稿 →' : !selected.size ? '使用原稿 →' : selected.size === changes.length ? '采用全部修改 →' : `采用 ${selected.size} 处修改 →`;
}
function renderChanges() {
  $('changes').replaceChildren();
  if (!changes.length) { const p = document.createElement('p'); p.className = 'inline-empty'; p.textContent = '这一轮没有提出修改，原稿已保留。自然的表达，不必为了改而改。'; $('changes').append(p); }
  for (const change of changes) {
    const row = document.createElement('article'); row.className = 'change';
    row.classList.toggle('kept', !selected.has(change.index));
    const heading = document.createElement('div'); heading.className = 'change-heading';
    const name = document.createElement('span'); name.className = 'change-speaker'; name.textContent = change.speaker;
    const line = document.createElement('span'); line.className = 'line-number'; line.textContent = `原稿第 ${change.index + 1} 行`; name.append(line);
    const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(change.index);
    check.setAttribute('aria-label', `采用原稿第 ${change.index + 1} 行${change.speaker}的修改`); label.append(check, '采用建议');
    check.onchange = () => { check.checked ? selected.add(change.index) : selected.delete(change.index); row.classList.toggle('kept', !check.checked); updateAdopt(); };
    heading.append(name, label); const text = document.createElement('div'); text.className = 'change-text';
    const before = document.createElement('p'), after = document.createElement('p'); before.className = 'before'; after.className = 'after';
    before.textContent = change.text; after.textContent = change.revised; text.append(before, after); row.append(heading, text);
    if (change.reason) { const reason = document.createElement('p'); reason.className = 'change-reason'; reason.textContent = change.reason; row.append(reason); }
    $('changes').append(row);
  }
  updateAdopt(); $('keep-all').disabled = !changes.length;
}
$('keep-all').onclick = () => { selected.clear(); renderChanges(); for (const row of $('changes').children) row.classList.add('kept'); };
$('form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  try { validateInput($('scene').value, $('context').value); } catch (error) { notify(error.message, 'error'); $('scene').focus(); return; }
  if (dirtyDraft() && !await confirmLoss('再次打磨会替换当前建议和手动编辑。请先导出需要保留的正文。')) return;
  const input = normalize($('scene').value), context = $('context').value;
  setBusy(true); let elapsed = 0;
  notify('正在通读这一场，打磨人物的表达。通常需要几十秒，请稍等…', 'busy');
  const timer = setInterval(() => { elapsed++; notify(`正在打磨，已等待 ${elapsed} 秒。完成后会保留原稿供你对照。`, 'busy'); }, 1000);
  try {
    const response = await fetch('/api/optimize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Code': $('access-code').value }, body: JSON.stringify({ scene: input, context }), signal: AbortSignal.timeout(130000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '本次打磨没有完成，请重试。');
    const revised = validateResult(input, data.revised);
    resetResult(); source = input; changes = changesBetween(input, revised).map(change => ({ ...change, reason: data.changes?.find(item => item.index === change.index)?.reason || '' })); selected = new Set(changes.map(change => change.index)); renderChanges();
    $('result-panel').hidden = false; $('empty-note').hidden = true; stage('compare');
    $('result-summary').textContent = `${dialogueRows(source).length} 句台词 · ${changes.length} 处建议修改 · ${(data.durationMs / 1000).toFixed(1)} 秒`;
    notify(`改稿已返回。${data.protectedCount ? `${data.protectedCount} 处建议删掉了原句的限定表达，已保留原句。` : ''}场景、动作和说话顺序保留；台词含义请结合原稿确认。`);
    $('result-title').focus({ preventScroll: true }); reveal('result-panel');
  } catch (error) { notify(['AbortError', 'TimeoutError'].includes(error.name) ? '等待超时，原稿和已有改稿仍在。请稍后重试。' : error instanceof TypeError ? '连接中断，原稿和已有改稿仍在。请稍后重试。' : error instanceof SyntaxError ? '服务返回异常，原稿已保留，请稍后重试。' : error.message, 'error'); }
  finally { clearInterval(timer); setBusy(false); }
};
$('adopt').onclick = async () => {
  if (dirtyDraft() && !await confirmLoss('重新采用建议会覆盖下方手动编辑。需要保留的正文请先导出。')) return;
  undoText = adopted ? $('draft').value : source;
  $('draft').value = applyChoices(source, changes, selected); appliedText = $('draft').value; savedText = ''; adopted = true;
  $('draft-panel').hidden = false; $('undo').disabled = false; stage('draft'); draftCount(); reveal('draft-panel'); $('draft-title').focus({ preventScroll: true });
  notify(`已采用 ${selected.size} 处修改。可以继续编辑，再复制或导出。`);
};
function draftCount() { $('draft-count').textContent = `${$('draft').value.length.toLocaleString()} 字 · ${$('draft').value === savedText ? '已导出或复制' : '尚未导出'}`; }
$('draft').oninput = draftCount;
$('undo').onclick = async () => {
  if ($('draft').value !== appliedText && !await confirmLoss('撤销采用会恢复采用前的正文，并清除之后的手动编辑。')) return;
  $('draft').value = undoText; $('undo').disabled = true; draftCount(); notify('已恢复采用前的正文，原稿和建议仍保留。');
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('draft').value); savedText = $('draft').value; draftCount(); notify('正文已复制。'); }
  catch { $('draft').focus(); $('draft').select(); notify('浏览器未允许自动复制，正文已选中，请按 Ctrl+C；也可以导出 TXT。', 'error'); }
};
$('export').onclick = () => {
  const blob = new Blob(['\uFEFF' + $('draft').value], { type: 'text/plain;charset=utf-8' }), url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `对白_打磨稿_${new Date().toISOString().slice(0, 10)}.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); savedText = $('draft').value; draftCount(); notify('已发起 TXT 下载，请在浏览器下载列表确认文件。');
};
addEventListener('beforeunload', event => { if ($('scene').value.trim() || dirtyDraft()) { event.preventDefault(); event.returnValue = ''; } });
try {
  const response = await fetch('/api/optimize', { signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error();
  const config = await response.json(); ready = config.ready; $('access-area').hidden = !config.accessRequired;
  notify(ready ? '准备好了，放入一场剧本即可开始。' : '体验服务尚未配置完成，可以先试填示例。', ready ? '' : 'error');
} catch { notify('暂时无法连接服务，请刷新页面重试。', 'error'); }
counts();

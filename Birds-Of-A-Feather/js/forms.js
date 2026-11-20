/* ==========================================================================
   forms.js —— 表单
   --------------------------------------------------------------------------
   只负责三件事：
     1. 把一条记录渲染成表单（HTML 字符串）
     2. 从表单里读出数据
     3. 做基本校验
   写进数据库是 app.js 的事 —— 这样这个文件保持"只处理界面"。

   已完成的表单：
     回忆 Memory  —— 第二轮
     日记 Journal —— 第三轮
     信件 Letter  —— 第三轮
     对话 Words   —— 第三轮
   ========================================================================== */

import { escapeHtml } from './views.js';
import { photoEditorHtml } from './photoEdit.js';
import { LIMITS } from './image.js';

const KINDS = [
  { value: 'travel',      label: '旅行 · Travel' },
  { value: 'date',        label: '约会 · Date' },
  { value: 'anniversary', label: '纪念日 · Anniversary' },
  { value: 'other',       label: '其他 · Other' }
];

/* --------------------------------------------------------------------------
   日记的心情选项
   存进数据库的是左边的代码（和示例数据、详情页显示完全一致）
   -------------------------------------------------------------------------- */
const MOODS = [
  { value: 'happy', label: '开心' },
  { value: 'calm',  label: '平静' },
  { value: 'tired', label: '疲惫' },
  { value: 'sad',   label: '难过' },
  { value: 'angry', label: '生气' }
];

/* --------------------------------------------------------------------------
   共用控件：一排可点的胶囊（单选）
   用途：日记的心情（必选）、对话的感受（可选）
   -------------------------------------------------------------------------- */
function chipGroup({ name, label = '', options, current, allowEmpty = false, emptyLabel = '不填' }) {
  const items = allowEmpty
    ? options.concat([{ value: '', label: emptyLabel }])
    : options;

  // 传进来的值对不上任何选项时（比如数据被改过），退回默认值，避免出现"一个都没选中"
  const values = items.map((item) => item.value);
  const fallback = allowEmpty ? '' : options[0].value;
  const effective = values.indexOf(current) >= 0 ? current : fallback;

  // role + aria-label：让读屏软件知道这是一组单选，而不是一排普通文字
  const groupLabel = label ? ` aria-label="${escapeHtml(label)}"` : '';

  return `<div class="chips" role="radiogroup"${groupLabel}>${items.map((item) => {
    const checked = effective === item.value;

    return `<label class="chip">
      <input type="radio" name="${name}" value="${escapeHtml(item.value)}"${checked ? ' checked' : ''}>
      <span>${escapeHtml(item.label)}</span>
    </label>`;
  }).join('')}</div>`;
}

/* --------------------------------------------------------------------------
   共用控件：对话的一轮
   --------------------------------------------------------------------------
   uid 只用来让每一轮的单选按钮不打架（同一个名字会变成同一组），
   页面上看到的是 ROUND 01 / 02，不会看到 uid。
   -------------------------------------------------------------------------- */
export function turnRowHtml(uid, { who = 'me', text = '' } = {}) {
  const isYou = who === 'you';

  return `
    <div class="turn-row" data-turn-row="${uid}">
      <div class="turn-head">
        <span class="turn-no" data-turn-no>ROUND 01</span>

        <span class="turn-pick" role="radiogroup" aria-label="这一轮是谁在说">
          <label><input type="radio" name="who-${uid}" value="me"${isYou ? '' : ' checked'}><span>Me</span></label>
          <label><input type="radio" name="who-${uid}" value="you"${isYou ? ' checked' : ''}><span>You</span></label>
        </span>

        <span class="turn-tools">
          <button type="button" class="turn-btn" data-turn-up title="上移">↑</button>
          <button type="button" class="turn-btn" data-turn-down title="下移">↓</button>
          <button type="button" class="turn-btn" data-turn-remove>删除这一轮</button>
        </span>
      </div>

      <textarea class="field-input" rows="2" placeholder="说了什么？">${escapeHtml(text)}</textarea>
    </div>`;
}

/** 现在的时间，格式 HH:MM */
function nowTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 今天，格式 YYYY-MM-DD（用本地时间，不用 UTC，避免差一天） */
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 表单底部：保存 / 取消 / 状态文字（四个表单共用） */
function formActions({ isEdit, cancelHref }) {
  return `
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">${isEdit ? '保存修改' : '保存'}</button>
      <a class="btn" href="${cancelHref}">取消</a>
      <span class="form-status" data-form-status role="status"></span>
    </div>`;
}

/** 表单头（四个表单共用） */
function formHead({ eyebrow, title, desc }) {
  return `
    <header class="page-hero">
      <div class="page-hero-text">
        <span class="eyebrow">${eyebrow}</span>
        <h1>${title}</h1>
        <p class="page-desc">${desc}</p>
      </div>
    </header>`;
}

/* ==========================================================================
   渲染
   ========================================================================== */

export function renderMemoryForm({ entry = null, mode = 'new' } = {}) {
  const isEdit = mode === 'edit' && entry;
  const e = entry || {};
  const cancelHref = isEdit ? `#/memories/${encodeURIComponent(e.id)}` : '#/memories';

  return `
    <header class="page-hero">
      <div class="page-hero-text">
        <span class="eyebrow">Chapter I · Memories · ${isEdit ? 'Edit' : 'New'}</span>
        <h1>${isEdit ? '编辑回忆' : '新增回忆'}</h1>
        <p class="page-desc">
          ${isEdit
            ? '改完点保存，原来的记录会被更新。'
            : '把这一天记下来。带 ★ 的是必填项。'}
        </p>
      </div>
    </header>

    <form class="entry-form" data-form="memory" novalidate>
      <input type="hidden" name="id" value="${isEdit ? escapeHtml(e.id) : ''}">

      <div class="field">
        <label class="field-label" for="f-title">标题 <span class="field-req">必填</span></label>
        <input class="field-input field-input--title" id="f-title" name="title" type="text"
               maxlength="80" autocomplete="off" placeholder="例如：厦门 · 第一次一起看海"
               value="${escapeHtml(e.title || '')}">
        <p class="field-error" data-error-for="title" hidden></p>
      </div>

      <div class="field-row">
        <div class="field">
          <label class="field-label" for="f-date">日期 <span class="field-req">必填</span></label>
          <input class="field-input" id="f-date" name="date" type="date"
                 value="${escapeHtml(e.date || todayISO())}">
          <p class="field-error" data-error-for="date" hidden></p>
        </div>

        <div class="field">
          <label class="field-label" for="f-kind">类别</label>
          <select class="field-input field-select" id="f-kind" name="kind">
            ${KINDS.map((k) => `<option value="${k.value}"${(e.kind || 'travel') === k.value ? ' selected' : ''}>${k.label}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="f-location">地点</label>
        <input class="field-input" id="f-location" name="location" type="text"
               maxlength="60" autocomplete="off" placeholder="可以不填"
               value="${escapeHtml(e.location || '')}">
      </div>

      <div class="field">
        <label class="field-label" for="f-content">正文</label>
        <textarea class="field-input field-textarea" id="f-content" name="content" rows="10"
                  placeholder="这一天发生了什么？">${escapeHtml(e.content || '')}</textarea>
        <p class="field-hint">直接换行即可，每一行会变成一段。</p>
      </div>

      <div class="field">
        <span class="field-label">照片</span>
        ${photoEditorHtml(Array.isArray(e.photos) ? e.photos : [])}
        <p class="field-hint">
          最多 ${LIMITS.maxPerEntry} 张，单张不超过 25MB。会自动压缩；第一张是封面，可以用 ← → 调顺序。
        </p>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${isEdit ? '保存修改' : '保存'}</button>
        <a class="btn" href="${cancelHref}">取消</a>
        <span class="form-status" data-form-status role="status"></span>
      </div>
    </form>`;
}

/* ==========================================================================
   读值 + 校验
   ========================================================================== */

export function readMemoryForm(form) {
  const data = new FormData(form);

  return {
    id: String(data.get('id') || '').trim(),
    title: String(data.get('title') || '').trim(),
    date: String(data.get('date') || '').trim(),
    kind: String(data.get('kind') || 'travel'),
    location: String(data.get('location') || '').trim(),
    content: String(data.get('content') || '').replace(/\r\n/g, '\n').trim()
  };
}

/** 返回 { 字段名: 错误说明 }；空对象表示没问题 */
export function validateMemory(data) {
  const errors = {};

  if (!data.title) {
    errors.title = '标题不能为空。';
  } else if (data.title.length > 80) {
    errors.title = `标题太长了，现在 ${data.title.length} 个字，最多 80 个。`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    errors.date = '请选择一个有效的日期。';
  }

  return errors;
}

/** 把错误显示到表单上 */
export function showFormErrors(form, errors) {
  form.querySelectorAll('[data-error-for]').forEach((el) => {
    el.hidden = true;
    el.textContent = '';
  });

  form.querySelectorAll('input, textarea, select').forEach((el) => {
    el.removeAttribute('aria-invalid');
  });

  Object.keys(errors).forEach((name) => {
    const box = form.querySelector(`[data-error-for="${name}"]`);
    if (box) {
      box.textContent = errors[name];
      box.hidden = false;
    }

    const input = form.querySelector(`[name="${name}"]`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (!Object.keys(errors).length || name === firstKey(errors)) input.focus();
    }
  });
}

function firstKey(obj) {
  return Object.keys(obj)[0];
}

/** 表单右下角的一行状态文字（保存中 / 保存失败） */
export function setFormStatus(form, message) {
  const box = form.querySelector('[data-form-status]');
  if (box) box.textContent = message || '';
}

/* ==========================================================================
   日记 Journal
   ========================================================================== */
export function renderJournalForm({ entry = null, mode = 'new' } = {}) {
  const isEdit = mode === 'edit' && entry;
  const e = entry || {};
  const cancelHref = isEdit ? `#/journal/${encodeURIComponent(e.id)}` : '#/journal';

  return `
    ${formHead({
      eyebrow: `Chapter II · Journal · ${isEdit ? 'Edit' : 'New'}`,
      title: isEdit ? '编辑日记' : '新增日记',
      desc: isEdit ? '改完点保存，原来的记录会被更新。' : '把今天记下来。带 ★ 的是必填项。'
    })}

    <form class="entry-form" data-form="journal" novalidate>
      <input type="hidden" name="id" value="${isEdit ? escapeHtml(e.id) : ''}">

      <div class="field-row">
        <div class="field">
          <label class="field-label" for="f-date">日期 <span class="field-req">必填</span></label>
          <input class="field-input" id="f-date" name="date" type="date"
                 value="${escapeHtml(e.date || todayISO())}">
          <p class="field-error" data-error-for="date" hidden></p>
        </div>

        <div class="field">
          <span class="field-label">心情 <span class="field-req">必填</span></span>
          ${chipGroup({ name: 'mood', label: '心情', options: MOODS, current: e.mood || 'calm' })}
          <p class="field-error" data-error-for="mood" hidden></p>
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="f-title">标题 <span class="field-req">必填</span></label>
        <input class="field-input field-input--title" id="f-title" name="title" type="text"
               maxlength="80" autocomplete="off" placeholder="例如：今天她笑了很久"
               value="${escapeHtml(e.title || '')}">
        <p class="field-error" data-error-for="title" hidden></p>
      </div>

      <div class="field">
        <label class="field-label" for="f-content">正文</label>
        <textarea class="field-input field-textarea" id="f-content" name="content" rows="10"
                  placeholder="今天发生了什么？">${escapeHtml(e.content || '')}</textarea>
        <p class="field-hint">直接换行即可，每一行会变成一段。</p>
      </div>

      ${formActions({ isEdit, cancelHref })}
    </form>`;
}

export function readJournalForm(form) {
  const data = new FormData(form);

  return {
    id: String(data.get('id') || '').trim(),
    title: String(data.get('title') || '').trim(),
    date: String(data.get('date') || '').trim(),
    mood: String(data.get('mood') || 'calm'),
    content: String(data.get('content') || '').replace(/\r\n/g, '\n').trim()
  };
}

export function validateJournal(data) {
  const errors = {};

  if (!data.title) {
    errors.title = '标题不能为空。';
  } else if (data.title.length > 80) {
    errors.title = `标题太长了，现在 ${data.title.length} 个字，最多 80 个。`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    errors.date = '请选择一个有效的日期。';
  }

  if (!MOODS.some((m) => m.value === data.mood)) {
    errors.mood = '请选一个今天的心情。';
  }

  return errors;
}

/* ==========================================================================
   信件 Letters
   ========================================================================== */
const TO_PRESETS = ['你', '自己'];

export function renderLetterForm({ entry = null, mode = 'new' } = {}) {
  const isEdit = mode === 'edit' && entry;
  const e = entry || {};
  const cancelHref = isEdit ? `#/letters/${encodeURIComponent(e.id)}` : '#/letters';

  return `
    ${formHead({
      eyebrow: `Chapter III · Letters · ${isEdit ? 'Edit' : 'New'}`,
      title: isEdit ? '编辑信件' : '写一封信',
      desc: isEdit
        ? '改完点保存，原来的信件会被更新。'
        : '写给对方，也可以写给自己。带 ★ 的是必填项。'
    })}

    <form class="entry-form" data-form="letter" novalidate>
      <input type="hidden" name="id" value="${isEdit ? escapeHtml(e.id) : ''}">

      <div class="field-row">
        <div class="field">
          <label class="field-label" for="f-date">日期 <span class="field-req">必填</span></label>
          <input class="field-input" id="f-date" name="date" type="date"
                 value="${escapeHtml(e.date || todayISO())}">
          <p class="field-error" data-error-for="date" hidden></p>
        </div>

        <div class="field">
          <label class="field-label" for="f-to">收信人 <span class="field-req">必填</span></label>
          <input class="field-input" id="f-to" name="to" type="text" maxlength="20"
                 autocomplete="off" placeholder="你"
                 value="${escapeHtml(e.to || '你')}">
          <p class="field-hint">
            ${TO_PRESETS.map((t) => `<button type="button" class="mini-btn" data-to-preset="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join(' ')}
            也可以写别的称呼
          </p>
          <p class="field-error" data-error-for="to" hidden></p>
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="f-title">标题 <span class="field-req">必填</span></label>
        <input class="field-input field-input--title" id="f-title" name="title" type="text"
               maxlength="80" autocomplete="off" placeholder="例如：写给冬天来临前的你"
               value="${escapeHtml(e.title || '')}">
        <p class="field-error" data-error-for="title" hidden></p>
      </div>

      <div class="field">
        <label class="field-label" for="f-content">正文</label>
        <textarea class="field-input field-textarea field-textarea--letter" id="f-content"
                  name="content" rows="12"
                  placeholder="想说的话…">${escapeHtml(e.content || '')}</textarea>
        <p class="field-hint">直接换行即可，每一行会变成一段。</p>
      </div>

      ${formActions({ isEdit, cancelHref })}
    </form>`;
}

export function readLetterForm(form) {
  const data = new FormData(form);

  return {
    id: String(data.get('id') || '').trim(),
    title: String(data.get('title') || '').trim(),
    date: String(data.get('date') || '').trim(),
    to: String(data.get('to') || '').trim(),
    content: String(data.get('content') || '').replace(/\r\n/g, '\n').trim()
  };
}

export function validateLetter(data) {
  const errors = {};

  if (!data.title) {
    errors.title = '标题不能为空。';
  } else if (data.title.length > 80) {
    errors.title = `标题太长了，现在 ${data.title.length} 个字，最多 80 个。`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    errors.date = '请选择一个有效的日期。';
  }

  if (!data.to) {
    errors.to = '写上收信人（例如「你」）。';
  } else if (data.to.length > 20) {
    errors.to = '收信人太长了，最多 20 个字。';
  }

  return errors;
}

/* ==========================================================================
   想说的话 Words
   --------------------------------------------------------------------------
   这里的"感受"故意做成自由文本 + 建议列表：
   数据库里它本来就是一个字符串（示例数据用的是 Tired / Calm / Content），
   所以不套用日记的那套代码选项，也不会弄坏已有数据的显示。
   ========================================================================== */
export function renderWordsForm({ entry = null, mode = 'new', feelingOptions = [] } = {}) {
  const isEdit = mode === 'edit' && entry;
  const e = entry || {};
  const cancelHref = isEdit ? `#/words/${encodeURIComponent(e.id)}` : '#/words';

  // 至少留一轮，方便直接开始写
  const turns = Array.isArray(e.turns) && e.turns.length ? e.turns : [{ who: 'me', text: '' }];

  // 建议列表 = 数据库里已经用过的词 + 这条记录自己的词
  const suggestions = Array.from(new Set([].concat(feelingOptions || [], e.feeling || []).filter(Boolean)));

  return `
    ${formHead({
      eyebrow: `Chapter IV · Words · ${isEdit ? 'Edit' : 'New'}`,
      title: isEdit ? '编辑这段对话' : '记一段对话',
      desc: isEdit ? '改完点保存，原来的记录会被更新。' : '一轮一轮地记下来。带 ★ 的是必填项。'
    })}

    <form class="entry-form" data-form="words" novalidate>
      <input type="hidden" name="id" value="${isEdit ? escapeHtml(e.id) : ''}">

      <div class="field-row">
        <div class="field">
          <label class="field-label" for="f-date">日期 <span class="field-req">必填</span></label>
          <input class="field-input" id="f-date" name="date" type="date"
                 value="${escapeHtml(e.date || todayISO())}">
          <p class="field-error" data-error-for="date" hidden></p>
        </div>

        <div class="field">
          <label class="field-label" for="f-time">时间</label>
          <input class="field-input" id="f-time" name="time" type="time"
                 value="${escapeHtml(e.time || nowTime())}">
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="f-feeling">感受</label>
        <input class="field-input" id="f-feeling" name="feeling" type="text" maxlength="20"
               list="feelingList" autocomplete="off" placeholder="可以不填，例如 Tired"
               value="${escapeHtml(e.feeling || '')}">
        <datalist id="feelingList">
          ${suggestions.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('')}
        </datalist>
        <p class="field-hint">随便写，会以大写小字显示在详情页顶端；想用以前写过的词就从列表里选。</p>
      </div>

      <div class="field">
        <label class="field-label" for="f-title">标题 <span class="field-req">必填</span></label>
        <input class="field-input field-input--title" id="f-title" name="title" type="text"
               maxlength="80" autocomplete="off" placeholder="例如：关于加班和蛋挞"
               value="${escapeHtml(e.title || '')}">
        <p class="field-error" data-error-for="title" hidden></p>
      </div>

      <div class="field">
        <span class="field-label">对话轮次 <span class="field-req">必填</span></span>

        <div class="turn-editor" data-turn-editor>
          ${turns.map((turn, i) => turnRowHtml(i, turn)).join('')}
          <button type="button" class="btn turn-add" data-turn-add>＋ 添加一轮对话</button>
        </div>

        <p class="field-error" data-error-for="turns" hidden></p>
        <p class="field-hint">点 ME / YOU 选择说话人，↑ ↓ 调整顺序；完全空白的一轮保存时会被忽略。</p>
      </div>

      ${formActions({ isEdit, cancelHref })}
    </form>`;
}

export function readWordsForm(form) {
  const data = new FormData(form);
  const rows = Array.from(form.querySelectorAll('[data-turn-row]'));

  const turns = rows.map((row) => {
    const uid = row.dataset.turnRow;
    const checked = row.querySelector(`input[name="who-${uid}"]:checked`);
    const box = row.querySelector('textarea');

    return {
      who: checked && checked.value === 'you' ? 'you' : 'me',
      text: String(box ? box.value : '').replace(/\r\n/g, '\n').trim()
    };
  }).filter((turn) => turn.text.length > 0);   // 空白的一轮直接丢掉，不打扰用户

  return {
    id: String(data.get('id') || '').trim(),
    title: String(data.get('title') || '').trim(),
    date: String(data.get('date') || '').trim(),
    time: String(data.get('time') || '').trim(),
    feeling: String(data.get('feeling') || '').trim(),
    turns
  };
}

export function validateWords(data) {
  const errors = {};

  if (!data.title) {
    errors.title = '标题不能为空。';
  } else if (data.title.length > 80) {
    errors.title = `标题太长了，现在 ${data.title.length} 个字，最多 80 个。`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    errors.date = '请选择一个有效的日期。';
  }

  if (!data.turns.length) {
    errors.turns = '至少要有 1 轮对话内容。';
  }

  return errors;
}

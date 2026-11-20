/* ==========================================================================
   app.js —— 程序入口
   --------------------------------------------------------------------------
   负责四件事：
     1. 看网址里 # 后面的内容，决定显示哪个页面（这叫"路由"）
     2. 从本地数据库（IndexedDB）读取这一页需要的数据
     3. 算出"在一起多少天"
     4. 照片灯箱、提示条

   网址和页面的对应关系：
     #/                 → 首页
     #/memories         → 回忆列表
     #/memories/m-001   → 某一条回忆的详情
     #/journal          → 日记列表
     #/journal/j-001    → 某一篇日记的详情
     #/letters          → 信件列表
     #/letters/l-001    → 某一封信的详情
     #/words            → 想说的话
     #/words/w-001      → 某一段对话的详情
     #/settings         → 设置

   数据来源：js/store.js（IndexedDB）
   图片地址：js/media.js（临时地址池）
   ========================================================================== */

/* 示例数据：同时充当"第一次打开网站"时要导入的种子数据 */
import { entries as SEED_ENTRIES, TOGETHER_SINCE, cinema } from './sample-data.js';
import {
  renderHome,
  renderMemories,
  renderJournal,
  renderLetters,
  renderWords,
  renderDetail,
  renderSettings,
  renderNotFound,
  escapeHtml,
  formatBytes,
  photoShape
} from './views.js';
import { initStore, listEntries, getEntry, getMeta, setMeta,
         createEntry, updateEntry, deleteEntry,
         newId, savePhotos, deletePhotos, countPhotos, listPhotoIds,
         photoStats, clearAllData, findOrphanPhotos } from './store.js';
import { resolveEntry, resolveEntries, releaseAll } from './media.js';
import {
  photoRowsFrom, originalPhotoIdsFrom, pendingRecordsFor,
  handlePhotoFiles, syncPhotoRows, syncCaption, discardSession, forget, pendingCount
} from './photoEdit.js';
import {
  renderMemoryForm, readMemoryForm, validateMemory,
  renderJournalForm, readJournalForm, validateJournal,
  renderLetterForm, readLetterForm, validateLetter,
  renderWordsForm, readWordsForm, validateWords,
  turnRowHtml,
  showFormErrors, setFormStatus
} from './forms.js';
import { planBackup, exportBackupText, downloadText, backupFileName,
         parseBackup, applyImport, verifyReferences } from './backup.js';

/* 页面里两个固定的容器（见 index.html） */
const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');

/* 数据层是否就绪。没就绪之前先不画页面，避免闪一下空内容 */
const boot = { ready: false, fatal: null };

/* 哪一类记录对应哪个列表页 —— 用于判断 #/memories/m-001 里的 "memories" */
const SECTION_TO_TYPE = {
  memories: 'memory',
  journal: 'journal',
  letters: 'letter',
  words: 'words'
};

/* ==========================================================================
   1. 在一起多少天
   --------------------------------------------------------------------------
   规则：起始当天算第 1 天。
   2026-07-05 当天 = 第 1 天；2026-07-06 = 第 2 天，以此类推。
   （以本地时间的 0 点为准，不受时区影响）
   ========================================================================== */
function daysTogether(since) {
  const start = new Date(`${since}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const oneDay = 24 * 60 * 60 * 1000;
  const passed = Math.round((today - start) / oneDay);

  // 起始日当天是第 1 天，所以 +1。如果起始日在未来，就显示 0。
  return passed < 0 ? 0 : passed + 1;
}

/* ==========================================================================
   2. 路由：解析网址里 # 后面的内容
   ========================================================================== */
function parseRoute() {
  // location.hash 形如 "#/memories/m-001"，也可能是 "#/memories/new"、"#/memories/m-001/edit"
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);

  // section：home | memories | journal | letters | words | settings
  const section = parts[0] || 'home';

  // #/memories/new → 新增；#/memories/xxx/edit → 编辑
  if (parts[1] === 'new') return { section, id: null, action: 'new' };
  if (parts[1] && parts[2] === 'edit') return { section, id: parts[1], action: 'edit' };

  return { section, id: parts[1] || null, action: null };
}

/* ==========================================================================
   3. 按路由读取数据（数据全部来自本地数据库）
   ========================================================================== */

/** 按栏目类型渲染对应的表单 */
async function buildForm(type, entry, mode) {
  if (type === 'memory')  return renderMemoryForm({ entry, mode });
  if (type === 'journal') return renderJournalForm({ entry, mode });
  if (type === 'letter')  return renderLetterForm({ entry, mode });

  if (type === 'words') {
    // 感受的建议列表来自数据库里已经用过的词（就是"沿用现有数据格式"）
    const list = await listEntries('words');
    const used = new Set();
    list.forEach((item) => { if (item.feeling) used.add(item.feeling); });

    return renderWordsForm({ entry, mode, feelingOptions: Array.from(used) });
  }

  return renderNotFound();
}

/* --------------------------------------------------------------------------
   首页照片墙：从回忆里自动挑照片
   --------------------------------------------------------------------------
   规则（写死，不做隐式凑数）：
     · 只取 type='memory' 的记录
     · 按回忆日期倒序，同日期按更新时间倒序
       （「最近记下的」就在照片墙下面，同页两种排序会打架，所以统一）
     · 同一张照片只出现一次（上传的按 photoId、静态的按路径）
     · 最多 5 张（布局的 .shot:nth-child() 只定义到第 5 个）
     · 不够就有几张显几张，【绝不重复凑数】
     · 静态示例图没有尺寸信息 → 一律按横构图
   -------------------------------------------------------------------------- */

/* 照片的构图方向用 views.js 导出的 photoShape，这里不再重复定义一份 */

async function buildHomeGallery(entries) {
  const seen = new Set();
  const picked = [];

  const memories = entries
    .filter((e) => e.type === 'memory' && Array.isArray(e.photos) && e.photos.length)
    .sort((a, b) => {
      if (a.date === b.date) return (b.updatedAt || 0) - (a.updatedAt || 0);
      return a.date < b.date ? 1 : -1;
    });

  memories.forEach((entry) => {
    if (picked.length >= 5) return;

    entry.photos.forEach((photo) => {
      if (picked.length >= 5) return;

      const key = photo.photoId || photo.src;
      if (!key || seen.has(key)) return;

      seen.add(key);
      picked.push({ photo, entry });
    });
  });

  if (!picked.length) return [];

  // 只把挑中的这几张解析成大图（灯箱要清晰）
  const holders = await resolveEntries(
    picked.map((item) => Object.assign({}, item.entry, { photos: [item.photo] })),
    { mode: 'full' }
  );

  return holders.map((holder, index) => {
    const source = picked[index];
    const ready = holder.photos[0] || {};

    return {
      src: ready.src,
      ratio: photoShape(ready),
      caption: String(source.photo.caption || source.entry.title || '').trim(),
      place: source.entry.location || '',
      date: source.entry.date
    };
  });
}

async function loadView(route) {
  const since = await getMeta('togetherSince', TOGETHER_SINCE);
  const days = daysTogether(since);

  /* ---- 首页 ---- */
  if (route.section === 'home') {
    // 首页的「最近记下的」不显示照片，所以不需要解析照片
    const entries = await listEntries();
    const gallery = await buildHomeGallery(entries);

    // 宽银幕头图本轮仍用 sample-data 里的静态清单（第五轮再讨论要不要一起改成自动挑选）
    return { html: renderHome({ entries, days, since, gallery, cinema }), isDark: false };
  }

  /* ---- 设置 ---- */
  if (route.section === 'settings') {
    const entries = await listEntries();

    // 照片占用：只读元数据，很快
    const stats = await photoStats().catch(() => ({ count: 0, bytes: 0 }));

    // 备份健康度要看的两个时间点
    const lastBackupAt = await getMeta('lastBackupAt', 0);
    const lastImportAt = await getMeta('lastImportAt', 0);

    // 浏览器自己报告的占用与配额。
    // 拿不到（例如 Safari 不支持）就不传，界面上不会显示那一行 —— 绝不编造数字。
    let estimate = null;
    try {
      if (navigator.storage && typeof navigator.storage.estimate === 'function') {
        const info = await navigator.storage.estimate();
        if (info && Number.isFinite(info.usage)) {
          estimate = { usage: info.usage, quota: Number.isFinite(info.quota) ? info.quota : 0 };
        }
      }
    } catch (err) {
      estimate = null;
    }

    return {
      html: renderSettings({ entries, stats, lastBackupAt, lastImportAt, estimate }),
      isDark: false
    };
  }

  /* ---- 四个栏目 ---- */
  const type = SECTION_TO_TYPE[route.section];
  if (!type) return { html: renderNotFound(), isDark: false };

  /* 新增 */
  if (route.action === 'new') {
    return { html: await buildForm(type, null, 'new'), isDark: false };
  }

  /* 编辑 */
  if (route.action === 'edit') {
    const raw = await getEntry(route.id);

    // 类型对不上（比如用日记的地址打开一封信）就当作找不到
    if (!raw || raw.type !== type) return { html: renderNotFound(), isDark: false };

    // 表单里要预览已有照片，所以解析成清晰的大图
    const target = await resolveEntry(raw, { mode: 'full' });
    return { html: await buildForm(type, target, 'edit'), isDark: false };
  }

  /* 详情页 */
  if (route.id) {
    const raw = await getEntry(route.id);

    // 类型对不上（比如用回忆的地址打开一篇日记）就当作找不到
    if (!raw || raw.type !== type) return { html: renderNotFound(), isDark: false };

    const entry = await resolveEntry(raw, { mode: 'full' });

    return {
      html: renderDetail({ entry }),
      isDark: type === 'letter'
    };
  }

  /* 列表页：只要封面、而且是缩略图（避免把每条记录的每张照片都读出来） */
  const entries = await resolveEntries(await listEntries(type), { mode: 'thumb', coversOnly: true });

  if (type === 'memory') return { html: renderMemories({ entries }), isDark: false };
  if (type === 'journal') return { html: renderJournal({ entries }), isDark: false };
  if (type === 'letter') return { html: renderLetters({ entries }), isDark: false };
  if (type === 'words') return { html: renderWords({ entries }), isDark: false };

  return { html: renderNotFound(), isDark: false };
}

/* ==========================================================================
   4. 渲染当前页面
   --------------------------------------------------------------------------
   数据现在是异步读出来的，所以这里要注意三件事：
     · 渲染令牌：防止"快速连点导航"时，先发出的旧结果把新页面覆盖掉
     · 换页前先关灯箱、再释放图片临时地址（否则灯箱里的图会变成空白）
     · 任何一步失败都要画出可读的提示，而不是留一片白屏
   ========================================================================== */
let renderToken = 0;

async function render() {
  if (!boot.ready) return;                       // 数据层还没准备好
  if (boot.fatal) { paintFatalError(boot.fatal); return; }

  const token = ++renderToken;
  const route = parseRoute();

  closeLightbox();
  releaseAll();
  discardSession();                              // 离开表单 = 放弃本次还没保存的照片

  let view;
  try {
    view = await loadView(route);
  } catch (err) {
    if (token === renderToken) paintFatalError(err);
    return;
  }

  if (token !== renderToken) return;             // 期间又有人发起了新的渲染

  document.body.classList.toggle('is-dark', view.isDark);
  appEl.innerHTML = view.html;
  syncAllTurnEditors();          // 对话轮次：重排编号 + 设置按钮可用状态
  syncAllPhotoEditors();         // 照片卡片：重排封面标记 + 灯箱编号
  markActiveNav(route.section);
  window.scrollTo(0, 0);
}

/** 数据层出问题时的兜底界面（沿用现有样式，不引入新外观） */
function paintFatalError(err) {
  const reason = (err && err.message) ? err.message : '未知原因';
  const hints = [
    '确认没有开启无痕（隐私）浏览模式',
    '如果提示里有"其他标签页"，关掉本站其他标签页后刷新',
    '在 Safari 的「设置 → 隐私 → 管理网站数据」里确认本站没有被禁止保存数据'
  ];

  document.body.classList.remove('is-dark');
  appEl.innerHTML = `
    <div class="empty">
      <p>本地数据暂时读不出来，所以内容显示不了。</p>
      <p class="settings-note">
        ${escapeHtml(reason)}<br>
        ${hints.map((h) => '· ' + escapeHtml(h)).join('<br>')}
      </p>
    </div>`;
}

/** 让顶部导航里当前页那一个高亮 */
function markActiveNav(section) {
  // 详情页也要高亮对应的列表项
  const activeSection = SECTION_TO_TYPE[section] ? section : section;

  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.nav === activeSection);
  });
}

/* ==========================================================================
   5. 底部提示条
   ========================================================================== */
let toastTimer = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('is-on');

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('is-on');
  }, 2000);
}

/* （原来这里有一个 [data-todo] 处理器，用来给"功能开发中"的按钮弹提示。
   四个栏目和设置页都做完之后，已经没有任何地方会输出 data-todo 属性，所以删掉。） */

/* ==========================================================================
   6. 确认对话框
   --------------------------------------------------------------------------
   删除记录、恢复备份这类"不可撤销"的动作，都要先经过这个对话框。
   用法：
     const answer = await askDialog({ title, lines, choices });
   返回被点按钮的 value；按 ESC 或点深色背景时返回 null。
   ========================================================================== */
const dialogEl      = document.getElementById('dialog');
const dialogKicker  = document.getElementById('dialogKicker');
const dialogTitle   = document.getElementById('dialogTitle');
const dialogText    = document.getElementById('dialogText');
const dialogActions = document.getElementById('dialogActions');

let dialogResolve = null;
let dialogPrevOverflow = null;

function askDialog({ kicker = '', title = '', lines = [], choices = [] }) {
  // 上一次还没结束就先收尾，避免前一个 Promise 永远挂着
  if (dialogResolve) { dialogResolve(null); dialogResolve = null; }

  dialogKicker.textContent = kicker;
  dialogTitle.textContent = title;
  dialogText.innerHTML = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  dialogActions.innerHTML = '';

  choices.forEach((choice) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = choice.primary ? 'btn btn-primary' : 'btn';
    btn.textContent = choice.label;
    btn.dataset.value = choice.value;
    dialogActions.appendChild(btn);
  });

  const previous = document.body.style.overflow;
  dialogPrevOverflow = previous;
  document.body.style.overflow = 'hidden';
  dialogEl.hidden = false;

  return new Promise((resolve) => {
    dialogResolve = resolve;

    const first = dialogActions.querySelector('.btn');
    if (first) first.focus();
  });
}

function closeDialog(value) {
  dialogEl.hidden = true;
  dialogActions.innerHTML = '';
  document.body.style.overflow = dialogPrevOverflow || '';
  dialogPrevOverflow = null;

  const resolve = dialogResolve;
  dialogResolve = null;
  if (resolve) resolve(value);
}

dialogEl.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-value]');
  if (btn) { closeDialog(btn.dataset.value); return; }

  // 点深色背景 = 取消
  if (event.target === dialogEl) closeDialog(null);
});

document.addEventListener('keydown', (event) => {
  if (dialogEl.hidden) return;
  if (event.key === 'Escape') closeDialog(null);
});

/* ==========================================================================
   7. 页面动作：保存回忆 / 删除回忆 / 导出与恢复备份
   ========================================================================== */

/* ---- 四个表单的保存规则（第三轮改成查表，回忆的行为完全不变） ---- */
const FORM_SPECS = {
  memory: {
    type: 'memory',
    path: '#/memories',
    read: readMemoryForm,
    validate: validateMemory,
    fields: (d) => ({ title: d.title, date: d.date, kind: d.kind, location: d.location, content: d.content }),
    hasPhotos: true                    // 带照片：保存时要先把照片写进去
  },
  journal: {
    type: 'journal',
    path: '#/journal',
    read: readJournalForm,
    validate: validateJournal,
    fields: (d) => ({ title: d.title, date: d.date, mood: d.mood, content: d.content })
  },
  letter: {
    type: 'letter',
    path: '#/letters',
    read: readLetterForm,
    validate: validateLetter,
    fields: (d) => ({ title: d.title, date: d.date, to: d.to, content: d.content })
  },
  words: {
    type: 'words',
    path: '#/words',
    read: readWordsForm,
    validate: validateWords,
    fields: (d) => ({ title: d.title, date: d.date, time: d.time, feeling: d.feeling, turns: d.turns })
  }
};

/* ---- 保存（四个表单共用同一套流程） ---- */
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();

  const spec = FORM_SPECS[form.dataset.form];
  if (!spec) return;

  const data = spec.read(form);
  const errors = spec.validate(data);

  if (Object.keys(errors).length) {
    showFormErrors(form, errors);
    setFormStatus(form, '还有必填项没填好');
    return;
  }

  setFormStatus(form, '保存中…');

  try {
    let fields = spec.fields(data);
    let newEntryId = null;                    // 带照片的表单会预先定好记录 id

    // 回忆带照片：先把照片写进库，再写记录 —— 顺序很重要，
    // 这样任何时刻都不会出现"记录引用了一张不存在的照片"
    if (spec.hasPhotos) {
      const outcome = await commitPhotos(form, data.id);

      fields = Object.assign({}, fields, { photos: outcome.photos });
      newEntryId = outcome.entryId;

      if (outcome.failed) {
        showToast(`有 ${outcome.failed} 张照片没能保存，已从这条记录里去掉了`);
      }
    }

    if (data.id) {
      // 编辑：只覆盖表单里的字段
      await updateEntry(data.id, fields);
      setFormStatus(form, '');
      window.location.hash = `${spec.path}/${encodeURIComponent(data.id)}`;
      showToast('已保存修改');
    } else {
      const payload = Object.assign({ type: spec.type }, fields);
      if (newEntryId) payload.id = newEntryId;

      const created = await createEntry(payload);

      setFormStatus(form, '');
      window.location.hash = `${spec.path}/${encodeURIComponent(created.id)}`;
      showToast('已保存');
    }
  } catch (err) {
    setFormStatus(form, '');
    showToast(`保存失败：${(err && err.message) || '未知原因'}`);
  }
});

/**
 * 保存照片 + 组装出记录里要存的 photos 数组。
 *
 * 步骤（顺序不能换）：
 *   ① 本次新选的照片 → 先写字节（entryId 用预先定好的记录 id）
 *   ② 用"真正写成功的集合"去过滤引用 → 保证写进记录的每张照片都真的存在
 *   ③ 编辑时，把被用户删掉的旧照片从库里清掉
 */
async function commitPhotos(form, existingId) {
  const entryId = existingId || newId('memory');
  const rows = photoRowsFrom(form);
  const wanted = rows.map((row) => row.photoId).filter(Boolean);

  let written = new Set();
  let failed = 0;

  /* ① 先写照片 */
  const toWrite = pendingRecordsFor(wanted, entryId);

  if (toWrite.length) {
    const result = await savePhotos(toWrite, { batchSize: 5 });

    written = result.ok;
    failed += result.failed.length;
    forget(Array.from(result.ok));            // 已经落地的，从内存里清掉

    if (result.quota) {
      showToast('空间不足，部分照片没能保存。建议先在设置里导出备份，再删掉一些照片。');
    }
  }

  /* ② 清洗引用 */
  const exists = new Set(await listPhotoIds());
  const keep = [];

  rows.forEach((row) => {
    if (!row.photoId) { keep.push(row); return; }                 // 静态引用（示例数据）
    if (written.has(row.photoId) || exists.has(row.photoId)) { keep.push(row); return; }
    failed += 1;                                                   // 写失败的 → 拿掉引用
  });

  /* ③ 把用户删掉的旧照片也删干净 */
  if (existingId) {
    const original = originalPhotoIdsFrom(form);
    const removed = original.filter((id) => wanted.indexOf(id) < 0);
    if (removed.length) await deletePhotos(removed);
  }

  return { entryId, photos: keep, failed };
}

/* ---- 删除（四个栏目共用） ---- */
/* 类型 → 中文名 + 列表页地址（对话框措辞与删除后的跳转都要用） */
const TYPE_INFO = {
  memory:  { label: '回忆', path: '#/memories' },
  journal: { label: '日记', path: '#/journal' },
  letter:  { label: '信件', path: '#/letters' },
  words:   { label: '对话', path: '#/words' }
};

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-delete-entry]');
  if (!btn) return;

  const id = btn.dataset.deleteEntry;
  const entry = await getEntry(id).catch(() => null);
  const info = TYPE_INFO[(entry && entry.type) || 'memory'];
  const label = entry ? `《${entry.title}》` : '这条记录';

  // 有照片的话，明确告诉用户会一起删掉
  let photoLine = '';
  if (entry && entry.type === 'memory') {
    const total = await countPhotos(id).catch(() => 0);
    if (total > 0) photoLine = `这条回忆里的 ${total} 张照片也会一起删除。`;
  }

  const answer = await askDialog({
    kicker: 'Delete',
    title: `确认删除这条${info.label}？`,
    lines: [
      `${label}删除后无法恢复。`,
      ...(photoLine ? [photoLine] : []),
      '如果里面有舍不得的内容，建议先在「设置」里导出一份备份。'
    ],
    choices: [
      { value: 'cancel', label: '取消' },
      { value: 'delete', label: '确认删除', primary: true }
    ]
  });

  if (answer !== 'delete') return;

  try {
    await deleteEntry(id);
    window.location.hash = info.path;
    showToast('已删除');
  } catch (err) {
    showToast(`删除失败：${(err && err.message) || '未知原因'}`);
  }
});

/* ---- 对话轮次编辑器（Words 表单） ---- */
document.addEventListener('click', (event) => {
  const presetBtn = event.target.closest('[data-to-preset]');
  const addBtn    = event.target.closest('[data-turn-add]');
  const removeBtn = event.target.closest('[data-turn-remove]');
  const upBtn     = event.target.closest('[data-turn-up]');
  const downBtn   = event.target.closest('[data-turn-down]');

  /* 收信人的快捷按钮：一点就把称呼填上 */
  if (presetBtn) {
    const form = presetBtn.closest('[data-form]');
    const input = form && form.querySelector('[name="to"]');

    if (input) {
      input.value = presetBtn.dataset.toPreset;
      input.focus();
    }
    return;
  }

  if (!addBtn && !removeBtn && !upBtn && !downBtn) return;

  const editor = event.target.closest('[data-turn-editor]');
  if (!editor) return;

  if (addBtn) {
    // 给新一轮一个没用过的编号，保证每轮的单选按钮不会串组
    const used = Array.from(editor.querySelectorAll('[data-turn-row]'))
      .map((row) => Number(row.dataset.turnRow) || 0);
    const uid = used.length ? Math.max.apply(null, used) + 1 : 0;

    addBtn.insertAdjacentHTML('beforebegin', turnRowHtml(uid, { who: 'me', text: '' }));

    const rows = Array.from(editor.querySelectorAll('[data-turn-row]'));
    const fresh = rows[rows.length - 1];
    const box = fresh && fresh.querySelector('textarea');
    if (box) box.focus();
  }

  if (removeBtn) {
    const row = removeBtn.closest('[data-turn-row]');
    if (row) row.remove();
  }

  if (upBtn) {
    const row = upBtn.closest('[data-turn-row]');
    const prev = row && row.previousElementSibling;
    if (prev && prev.matches('[data-turn-row]')) row.parentNode.insertBefore(row, prev);
  }

  if (downBtn) {
    const row = downBtn.closest('[data-turn-row]');
    const next = row && row.nextElementSibling;
    if (next && next.matches('[data-turn-row]')) row.parentNode.insertBefore(next, row);
  }

  syncTurnRows(editor);
});

/** 重排轮次编号，并按位置启用 / 禁用按钮 */
function syncTurnRows(editor) {
  const rows = Array.from(editor.querySelectorAll('[data-turn-row]'));

  rows.forEach((row, index) => {
    const no = row.querySelector('[data-turn-no]');
    if (no) no.textContent = `ROUND ${String(index + 1).padStart(2, '0')}`;

    const up = row.querySelector('[data-turn-up]');
    const down = row.querySelector('[data-turn-down]');
    const remove = row.querySelector('[data-turn-remove]');

    // 只剩一轮时不允许删空，避免编辑器看起来坏掉
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === rows.length - 1;
    if (remove) remove.disabled = rows.length <= 1;
  });
}

/** 页面画好后同步一次（编号 + 按钮可用状态） */
function syncAllTurnEditors() {
  document.querySelectorAll('[data-turn-editor]').forEach(syncTurnRows);
}

/* ---- 照片编辑器（回忆表单） ---- */
document.addEventListener('click', (event) => {
  const addBtn    = event.target.closest('[data-photo-add]');
  const leftBtn   = event.target.closest('[data-photo-left]');
  const rightBtn  = event.target.closest('[data-photo-right]');
  const removeBtn = event.target.closest('[data-photo-remove]');

  if (!addBtn && !leftBtn && !rightBtn && !removeBtn) return;

  const editor = event.target.closest('[data-photo-editor]');
  if (!editor) return;

  /* 点「＋ 添加照片」= 打开系统的文件选择框 */
  if (addBtn) {
    const input = editor.querySelector('[data-photo-input]');
    if (input) input.click();
    return;
  }

  const row = event.target.closest('[data-photo-row]');
  if (!row) return;

  if (leftBtn) {
    const prev = row.previousElementSibling;
    if (prev && prev.matches('[data-photo-row]')) row.parentNode.insertBefore(row, prev);
  }

  if (rightBtn) {
    const next = row.nextElementSibling;
    if (next && next.matches('[data-photo-row]')) row.parentNode.insertBefore(next, row);
  }

  if (removeBtn) row.remove();        // 只从列表里拿掉，保存时才真正从库里删

  syncPhotoRows(editor);
});

/* 选好文件之后开始压缩上屏 */
document.addEventListener('change', (event) => {
  const input = event.target.closest('[data-photo-input]');
  if (input) handlePhotoFiles(input);
});

/* 图注一改，同步给灯箱（点开大图时显示的就是最新图注） */
document.addEventListener('input', (event) => {
  const box = event.target.closest('[data-photo-caption]');
  if (box) syncCaption(box.closest('[data-photo-row]'));
});

/** 页面画好后同步一次照片卡片状态（封面标记 + 灯箱编号 + 按钮可用性） */
function syncAllPhotoEditors() {
  document.querySelectorAll('[data-photo-editor]').forEach(syncPhotoRows);
}

/* ---- 备份：导出 ---- */
const importFileEl = document.getElementById('importFile');

/* 字节格式化统一用 views.js 导出的 formatBytes，这里不再重复定义 */

/* 两个结果提示区：一个在备份区，一个在危险操作区 */
function setNote(attr, message) {
  const box = document.querySelector(`[${attr}]`);
  if (!box) return;

  box.textContent = message || '';
  box.hidden = !message;
}

function setBackupNote(message) { setNote('data-backup-note', message); }
function setDangerNote(message) { setNote('data-danger-note', message); }

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;

  if (el.dataset.action === 'export-backup') {
    await runExport();
    return;
  }

  if (el.dataset.action === 'import-backup') {
    importFileEl.value = '';   // 允许连续选同一个文件
    importFileEl.click();
    return;
  }

  if (el.dataset.action === 'cleanup-orphans') {
    await runOrphanCleanup();
    return;
  }

  if (el.dataset.action === 'clear-all') {
    await runClearAll();
    return;
  }
});

/* --------------------------------------------------------------------------
   导出备份
   --------------------------------------------------------------------------
   单独抽出来，是因为「清空全部数据」里也会用到它（先导出再清空）。
   成功返回 true。
   -------------------------------------------------------------------------- */
async function runExport() {
  try {
    setBackupNote('正在整理…');

    const plan = await planBackup();

    // 体积大的时候先问一声，避免等半天才发现不合适
    if (plan.estimatedBytes > 50 * 1024 * 1024) {
      const go = await askDialog({
        kicker: 'Backup',
        title: '这个备份会比较大',
        lines: [
          `共 ${plan.payload.counts.entries} 条记录、${plan.payload.counts.photos} 张照片，预计约 ${formatBytes(plan.estimatedBytes)}。`,
          '生成过程需要一些时间，可能要等十几秒。要继续吗？'
        ],
        choices: [
          { value: 'cancel', label: '先不导出' },
          { value: 'go', label: '继续导出', primary: true }
        ]
      });

      if (go !== 'go') { setBackupNote('已取消导出。'); return false; }
    }

    const text = await exportBackupText(plan, {
      onProgress: (done, total) => setBackupNote(total ? `正在打包 ${done} / ${total} 张照片…` : '正在打包…')
    });

    const file = downloadText(text, backupFileName());
    await setMeta('lastBackupAt', Date.now());

    const missing = plan.missingPhotos
      ? ` 注意：有 ${plan.missingPhotos} 张照片的数据已经找不到，没有放进备份。`
      : '';

    // 先重画页面（让"备份健康度"立刻刷新），再写结果提示
    await render();
    setBackupNote(`已生成备份文件 ${file.name}（${formatBytes(file.bytes)}，${plan.payload.counts.entries} 条记录、${plan.payload.counts.photos} 张照片）。文件已交给浏览器下载，请到「下载」文件夹查看。${missing}`);
    showToast('备份已导出');
    return true;
  } catch (err) {
    setBackupNote(`导出失败：${(err && err.message) || '未知原因'}`);
    return false;
  }
}

/* --------------------------------------------------------------------------
   清理没人引用的照片
   --------------------------------------------------------------------------
   只找 + 先告诉你数量和体积，你点了头才删。绝不自动删。
   -------------------------------------------------------------------------- */
async function runOrphanCleanup() {
  try {
    const found = await findOrphanPhotos();

    if (!found.count) {
      setDangerNote(`没有需要清理的照片（现有 ${found.totalPhotos} 张，都被记录引用着）。`);
      return;
    }

    const answer = await askDialog({
      kicker: 'Cleanup',
      title: `发现 ${found.count} 张没人引用的照片`,
      lines: [
        `一共约 ${formatBytes(found.bytes)}。没有任何记录引用它们（通常是保存或导入中断时留下的）。`,
        '只会清理 10 分钟以前创建的，正在保存中的照片不会被碰到。',
        '清理不影响任何记录，也不会动其它照片。'
      ],
      choices: [
        { value: 'cancel', label: '取消' },
        { value: 'go', label: `清理这 ${found.count} 张`, primary: true }
      ]
    });

    if (answer !== 'go') return;

    await deletePhotos(found.ids);
    await render();

    const check = await verifyReferences();
    const left = await photoStats().catch(() => ({ count: 0, bytes: 0 }));

    setDangerNote(`已清理 ${found.count} 张照片（约 ${formatBytes(found.bytes)}）。校验：记录 ${check.entries} 条、照片 ${left.count} 张、失效引用 ${check.dangling.length} 处。`);
    showToast('清理完成');
  } catch (err) {
    setDangerNote(`清理失败：${(err && err.message) || '未知原因'}`);
  }
}

/* --------------------------------------------------------------------------
   清空全部数据
   --------------------------------------------------------------------------
   两段确认 + 中间给一次"先导出备份"的机会；确认后一个事务清空三张表。
   清空完立刻校验：记录数 / 照片数 / 失效引用数。
   -------------------------------------------------------------------------- */
async function runClearAll() {
  const entries = await listEntries();
  const stats = await photoStats().catch(() => ({ count: 0, bytes: 0 }));

  if (entries.length === 0 && stats.count === 0) {
    setDangerNote('现在本来就是空的，没有需要清空的内容。');
    return;
  }

  const summary = `这会删除 ${entries.length} 条记录和 ${stats.count} 张照片（约 ${formatBytes(stats.bytes)}）。`;

  /* ---- 第一段确认 ---- */
  const first = await askDialog({
    kicker: 'Danger',
    title: '清空全部数据？',
    lines: [
      summary,
      '恋爱起始日期等设置会保留；示例数据不会自动恢复，清空后网站是白纸一张。',
      '这一步不能撤销，建议先导出一份备份。'
    ],
    choices: [
      { value: 'cancel', label: '取消' },
      { value: 'export', label: '先导出备份' },
      { value: 'next', label: '继续清空' }
    ]
  });

  if (first === 'export') {
    const exported = await runExport();
    if (!exported) return;

    const again = await askDialog({
      kicker: 'Please confirm',
      title: '备份已导出，还要清空吗？',
      lines: [summary, '清空后如果需要回本次内容，用刚导出的那份文件恢复即可。'],
      choices: [
        { value: 'cancel', label: '还是算了' },
        { value: 'next', label: '继续清空', primary: true }
      ]
    });

    if (again !== 'next') return;
  } else if (first !== 'next') {
    return;
  }

  /* ---- 第二段确认 ---- */
  const really = await askDialog({
    kicker: 'Please confirm',
    title: '真的要清空吗？',
    lines: [
      `确认后 ${entries.length} 条记录和 ${stats.count} 张照片会被立刻删除，无法恢复。`,
      '清空后网站会变成一张白纸。'
    ],
    choices: [
      { value: 'cancel', label: '还是算了' },
      { value: 'yes', label: '确定清空', primary: true }
    ]
  });

  if (really !== 'yes') return;

  try {
    await clearAllData();
    await render();

    // 清空后立刻校验
    const left = await listEntries();
    const leftPhotos = await photoStats().catch(() => ({ count: 0 }));
    const check = await verifyReferences();

    setDangerNote(`已清空：记录 ${left.length} 条、照片 ${leftPhotos.count} 张、失效引用 ${check.dangling.length} 处。`);
    showToast('已清空');
  } catch (err) {
    setDangerNote(`清空失败：${(err && err.message) || '未知原因'}`);
  }
}

/* ---- 备份：选择文件 → 确认 → 恢复 ---- */
importFileEl.addEventListener('change', async () => {
  const file = importFileEl.files && importFileEl.files[0];
  if (!file) return;

  let text;
  try {
    text = await file.text();
  } catch (err) {
    setBackupNote('读不出这个文件，请重新选一次。');
    return;
  }

  const parsed = parseBackup(text);

  if (!parsed.ok) {
    setBackupNote(`无法导入：${parsed.fatal}`);
    showToast('这个文件不能用来恢复');
    return;
  }

  const s = parsed.summary;
  const typeText = Object.keys(s.byType).map((k) => `${k} ${s.byType[k]} 条`).join('、');
  const existing = await listEntries();

  const lines = [
    `文件名：${file.name}`,
    `文件里共有 ${s.entries} 条记录：${typeText}。`,
    `导出时间：${s.exportedAt ? new Date(s.exportedAt).toLocaleString('zh-CN') : '未记录'}。`,
    `当前网站里已有 ${existing.length} 条记录。`
  ];

  if (s.legacy) {
    lines.push('这是一份 v1 的旧备份，里面不含照片，恢复后只会有文字内容。');
  } else if (s.photoCount > 0) {
    lines.push(`包含 ${s.photoCount} 张照片（约 ${formatBytes(s.approxBytes || 0)}）`);
  }

  if (parsed.problems.length) lines.push(`有 ${parsed.problems.length} 处数据有问题，会被跳过。`);

  const answer = await askDialog({
    kicker: 'Restore',
    title: '要怎么恢复这份备份？',
    lines,
    choices: [
      { value: 'cancel', label: '取消' },
      { value: 'replace', label: '覆盖导入' },
      { value: 'merge', label: '合并导入', primary: true }
    ]
  });

  if (answer !== 'merge' && answer !== 'replace') return;

  if (answer === 'replace') {
    const really = await askDialog({
      kicker: 'Please confirm',
      title: '确定要覆盖吗？',
      lines: [
        `当前网站里的 ${existing.length} 条记录会被全部删掉，换成备份里的 ${s.entries} 条。`,
        '这一步不能撤销。如果当前内容还需要，请先返回上一步点「导出备份」存一份。'
      ],
      choices: [
        { value: 'cancel', label: '先不覆盖' },
        { value: 'yes', label: '确定覆盖', primary: true }
      ]
    });

    if (really !== 'yes') return;
  }

  setBackupNote('正在导入，请稍候…');

  try {
    const result = await applyImport(parsed, answer, {
      onProgress: (phase, done, total) => {
        if (phase === 'photos') setBackupNote(`正在写入照片 ${done} / ${total}…`);
      }
    });

    // 先重画页面、再写结果提示 —— 否则提示会被重画冲掉
    await render();

    const parts = [`导入完成：写入 ${result.writtenEntries} 条记录`];

    if (result.writtenPhotos) parts.push(`${result.writtenPhotos} 张照片`);
    if (answer === 'merge' && result.keptEntries) parts.push(`保留现有的 ${result.keptEntries} 条（它们更新）`);
    if (result.thumbFailures) parts.push(`${result.thumbFailures} 张缩略图没能重新生成（列表里会用大图代替）`);
    if (result.cleanedOrphans) parts.push(`清掉了 ${result.cleanedOrphans} 张没人引用的照片`);

    let text = parts.join('，') + '。';

    // 如实说明哪些照片没能恢复、以及记录里做了什么处理
    if (result.removedRefs.length) {
      const names = result.removedRefs.slice(0, 3).map((x) => x.title || x.id).join('、');
      const more = result.removedRefs.length > 3 ? ' 等' : '';

      text += ` 有 ${result.removedRefs.length} 条记录里的照片无法恢复，已把这些失效的照片引用去掉（文字内容保留）：${names}${more}。`;
    }

    if (result.emptyPhotoEntries.length) {
      text += ` 其中 ${result.emptyPhotoEntries.length} 条记录的照片全部无法恢复，已作为纯文字记录恢复。`;
    }

    if (result.failedPhotos.length) {
      text += ` 有 ${result.failedPhotos.length} 张照片没能写入${result.quota ? '（空间不足）' : ''}。`;
    }

    if (result.verify && result.verify.dangling.length) {
      text += ` ⚠️ 校验发现 ${result.verify.dangling.length} 处失效引用，请把结果告诉我。`;
    } else if (result.verify) {
      text += ` 校验通过：${result.verify.entries} 条记录、${result.verify.photos} 张照片，没有失效引用。`;
    }

    setBackupNote(text);
    showToast('恢复完成');
  } catch (err) {
    setBackupNote(`导入失败：${(err && err.message) || '未知原因'}。现有数据没有被改动。`);
  }
});

/* ==========================================================================
   8. 照片灯箱（点击首页照片放大）
   --------------------------------------------------------------------------
   照片信息写在按钮的 data 属性上，所以不需要额外的全局数据。
   支持：点背景关闭、点 × 关闭、ESC 关闭、← → 切上一张 / 下一张。
   ========================================================================== */
const lightboxEl = document.getElementById('lightbox');
const lbImg   = document.getElementById('lbImg');
const lbIndex = document.getElementById('lbIndex');
const lbText  = document.getElementById('lbText');
const lbClose = document.getElementById('lbClose');
const lbPrev  = document.getElementById('lbPrev');
const lbNext  = document.getElementById('lbNext');

let lbPhotos = [];   // 当前可翻看的照片
let lbAt = 0;        // 当前是第几张（从 0 开始）

/** 收集页面上所有可放大的照片 */
function collectPhotos() {
  return [...document.querySelectorAll('[data-lightbox]')].map((btn) => ({
    src: btn.dataset.src,
    caption: btn.dataset.caption || ''
  }));
}

/** 把当前这一张画到灯箱里 */
function paintLightbox() {
  const photo = lbPhotos[lbAt];

  lbImg.src = photo.src;
  lbImg.alt = photo.caption;
  lbIndex.textContent = `${lbAt + 1} / ${lbPhotos.length}`;
  lbText.textContent = photo.caption;

  // 只有一张照片时不显示左右箭头
  const many = lbPhotos.length > 1;
  lbPrev.hidden = !many;
  lbNext.hidden = !many;
}

function openLightbox(index) {
  lbPhotos = collectPhotos();
  if (!lbPhotos.length) return;

  lbAt = index;
  paintLightbox();
  lightboxEl.hidden = false;
  document.body.style.overflow = 'hidden';   // 打开时锁住页面滚动
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lbImg.src = '';
  document.body.style.overflow = '';
}

function stepLightbox(delta) {
  if (lbPhotos.length < 2) return;
  lbAt = (lbAt + delta + lbPhotos.length) % lbPhotos.length;
  paintLightbox();
}

/* 点照片 → 放大 */
document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-lightbox]');
  if (!btn) return;
  openLightbox(Number(btn.dataset.lightbox) || 0);
});

lbClose.addEventListener('click', closeLightbox);
lbPrev.addEventListener('click', () => stepLightbox(-1));
lbNext.addEventListener('click', () => stepLightbox(1));

/* 点深色背景关闭（点图片本身不关） */
lightboxEl.addEventListener('click', (event) => {
  if (event.target === lightboxEl) closeLightbox();
});

/* 键盘：ESC 关闭，← → 翻页 */
document.addEventListener('keydown', (event) => {
  if (lightboxEl.hidden) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') stepLightbox(-1);
  if (event.key === 'ArrowRight') stepLightbox(1);
});

/* ==========================================================================
   9. 启动
   --------------------------------------------------------------------------
   顺序很重要：先把数据库准备好（第一次打开还要导入示例数据），再画页面。
   否则会出现"先画了空页面、数据才到"的闪烁。
   ========================================================================== */
window.addEventListener('hashchange', render);

async function start() {
  try {
    const result = await initStore({
      seedEntries: SEED_ENTRIES,
      togetherSince: TOGETHER_SINCE
    });

    boot.ready = true;

    if (result.seeded) {
      console.info(`[Birds Of A Feather] 第一次运行：已导入 ${result.count} 条示例数据`);
    }
  } catch (err) {
    boot.ready = true;
    boot.fatal = err;
    console.warn('[Birds Of A Feather] 本地数据初始化失败：', err);
  }

  render();
}

start();

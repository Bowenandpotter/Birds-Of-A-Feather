/* ==========================================================================
   views.js —— 页面渲染
   --------------------------------------------------------------------------
   这个文件只做一件事：把数据（对象）变成 HTML 字符串。
   它不读数据、不存数据、不碰 IndexedDB —— 那些都在 app.js 和 store.js 里。

   对外提供 9 个渲染函数：
     renderHome      首页
     renderMemories  回忆列表
     renderJournal   日记列表
     renderLetters   信件列表
     renderWords     想说的话
     renderDetail    详情页（四类共用，按 type 分支）
     renderSettings  设置页
     renderNotFound  找不到记录
     另：escapeHtml / formatBytes / photoShape 三个小工具也在这里导出
   ========================================================================== */

/* ------------------------- 展示用的文字字典 ------------------------- */

const MEMORY_KINDS = {
  travel:      { label: '旅行',   en: 'Travel' },
  date:        { label: '约会',   en: 'Date' },
  anniversary: { label: '纪念日', en: 'Anniversary' },
  other:       { label: '其他',   en: 'Other' }
};

const MOODS = {
  happy: { en: 'Content', cn: '开心' },
  calm:  { en: 'Calm',    cn: '平静' },
  tired: { en: 'Tired',   cn: '疲惫' },
  sad:   { en: 'Low',     cn: '难过' },
  angry: { en: 'Upset',   cn: '生气' }
};

const SECTIONS = {
  memory:  { label: '回忆',     listPath: '#/memories', listName: '回忆' },
  journal: { label: '日记',     listPath: '#/journal',  listName: '日记' },
  letter:  { label: '信件',     listPath: '#/letters',  listName: '信件' },
  words:   { label: '想说的话', listPath: '#/words',    listName: 'Words' }
};

const EN_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------- 小工具函数 ------------------------- */

/** 把用户输入的文字安全地放进 HTML（避免 < > 之类的符号破坏页面） */
export function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (ch) => map[ch]);
}

/** '2026-08-14' → '2026年8月14日'（用字符串切分，避免时区问题） */
function fmtDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** '2026-08-14' → { day: '14', month: '8月' }，日记列表左侧用 */
function splitDate(iso) {
  const [, m, d] = String(iso).split('-');
  return { day: String(Number(d)), month: `${Number(m)}月` };
}

/** 取正文前 n 个字，超长加省略号 */
function excerpt(text, n = 70) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

/** 正文按空行/换行切成段落 */
function paragraphs(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

/** '2026-08-14' → '2026.08.14'（杂志式日期标记） */
function dotsDate(iso) {
  return String(iso).replace(/-/g, '.');
}

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-07-05' → 'July 5, 2026'（首页与信件的英文日期） */
function fmtDateEn(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${EN_MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/** 恋爱天数上方的心形：1px 细描边，不用实心红心图标 */
const HEART_SVG = `<svg class="together-heart" viewBox="0 0 24 22" aria-hidden="true">
        <path d="M12 21C12 21 1 14.5 1 7.6 1 4.5 3.5 2 6.6 2c2.3 0 4.3 1.3 5.4 3.3C13.1 3.3 15.1 2 17.4 2c3.1 0 5.6 2.5 5.6 5.6C23 14.5 12 21 12 21z"/>
      </svg>`;

/** 按日期倒序排（日期相同则按 id 倒序，保证顺序稳定） */
function byDateDesc(a, b) {
  if (a.date === b.date) return a.id < b.id ? 1 : -1;
  return a.date < b.date ? 1 : -1;
}

/** 所有数据里的某一类，已排序 */
function pick(entries, type) {
  return entries.filter((e) => e.type === type).sort(byDateDesc);
}

/** 详情页里那条记录对应的列表页地址 */
function listPathOf(type) {
  return SECTIONS[type] ? SECTIONS[type].listPath : '#/';
}

/**
 * 照片的构图方向：'p' 竖 / 'l' 横 / 's' 方
 * 没有宽高信息时（示例数据的静态图）按横构图处理。
 * ★ 首页照片墙与回忆详情页共用这一份，不要再各写一份。
 */
export function photoShape(photo) {
  const w = Number(photo.width) || 0;
  const h = Number(photo.height) || 0;
  if (!w || !h) return 'l';

  const k = w / h;
  if (k < 0.87) return 'p';        // 竖构图
  if (k > 1.15) return 'l';        // 横构图
  return 's';                      // 方构图
}

/* 「功能开发中」的占位按钮已经不需要了：四个栏目都支持真的增删改，设置页的功能也都实现了 */

/* ==========================================================================
   首页（编辑式摄影杂志）
   --------------------------------------------------------------------------
   层次：标题区 → 恋爱天数 → 全幅宽银幕头图 → 照片墙 → 最近记录 → 栏目入口
   照片数据和排版位置分开：数据在 sample-data.js，位置在 style.css 的 .shot:nth-child()
   ========================================================================== */
export function renderHome({ entries, days, since, gallery = [], cinema = null }) {

  /* ---- 最近记录：编辑式列表，不用卡片 ---- */
  const recent = [...entries].sort(byDateDesc).slice(0, 5);

  const recentHtml = recent.map((e, i) => `
    <li>
      <a class="recent-row" href="${listPathOf(e.type)}/${e.id}">
        <span class="recent-no">${String(i + 1).padStart(2, '0')}</span>
        <span class="recent-date">${dotsDate(e.date)}</span>
        <h3 class="recent-title">${escapeHtml(e.title)}</h3>
        <span class="recent-kind">${SECTIONS[e.type].label} →</span>
      </a>
    </li>`).join('');

  /* ---- 照片墙：比例（p/l/s）与错落位置由 CSS 控制 ---- */
  const shotsHtml = gallery.map((p, i) => {
    const caption = p.caption ? `${p.place ? p.place + ' · ' : ''}${dotsDate(p.date)}　${p.caption}` : '';
    return `
    <figure class="shot shot--${p.ratio}">
      <button type="button" class="shot-btn"
              data-lightbox="${i}"
              data-src="${p.src}"
              data-caption="${escapeHtml(caption)}"
              aria-label="放大查看照片：${escapeHtml(p.caption || p.place || '')}">
        <img src="${p.src}" alt="${escapeHtml(p.caption || p.place || '照片')}" loading="lazy">
      </button>
      <figcaption>
        <span class="shot-no">${String(i + 1).padStart(2, '0')}</span>
        <span class="shot-place">${escapeHtml(p.place || '')}</span>
        <time datetime="${p.date}">${dotsDate(p.date)}</time>
      </figcaption>
    </figure>`;
  }).join('');

  /* ---- 全幅宽银幕头图 ---- */
  const cinemaHtml = cinema ? `
    <figure class="cinema">
      <img src="${cinema.src}" alt="${escapeHtml(cinema.caption || '')}">
      <figcaption>
        <span>${escapeHtml(cinema.place || '')}</span>
        <span>${escapeHtml(cinema.caption || '')} · ${dotsDate(cinema.date)}</span>
      </figcaption>
    </figure>` : '';

  /* ---- 首页不再重复栏目入口：顶部导航已经承担了这个作用 ---- */

  return `
    <section class="hero">
      <div class="hero-rule">
        <span class="eyebrow">Established 2026</span>
        <span class="hero-rule-line"></span>
        <span class="eyebrow eyebrow--cn">一路同行</span>
      </div>

      <h1 class="hero-title">Birds Of A Feather</h1>
      <p class="hero-script">We should stick together～</p>
      <p class="hero-line">Our little corner of the universe.</p>

      <div class="together">
        ${HEART_SVG}
        <div class="together-line">
          <span class="together-num">${days}</span>
          <span class="together-unit">Days Together</span>
        </div>
        <span class="together-since">Since ${fmtDateEn(since)}</span>
      </div>
    </section>

    ${cinemaHtml}

    <section class="gallery">
      <header class="section-head">
        <span class="eyebrow">The Gallery</span>
        <h2>我们的照片</h2>
        <span class="section-note">${gallery.length} Photographs</span>
      </header>
      <div class="gallery-grid">${shotsHtml}</div>
    </section>

    <section class="recent">
      <header class="section-head">
        <span class="eyebrow">Recent Entries</span>
        <h2>最近记下的</h2>
        <span class="section-note">${recent.length} of ${entries.length}</span>
      </header>
      <ol class="recent-list">${recentHtml}</ol>
    </section>

    <!-- 页脚：不显示备份状态（按约定备份健康度只在设置页显示），只做中性说明 -->
    <div class="backup-strip">
      <span class="backup-dot"></span>
      <span>本地保存 · 在「设置」里可以导出备份</span>
      <span class="backup-note">Saved locally</span>
    </div>
  `;
}

/* ==========================================================================
   回忆列表（旅行摄影杂志：图 + 文左右交替的跨页）
   ========================================================================== */
export function renderMemories({ entries }) {
  const list = pick(entries, 'memory');

  const spreads = list.map((e, i) => {
    const kind = MEMORY_KINDS[e.kind] || MEMORY_KINDS.other;

    return `
    <article class="spread">
      <a class="spread-photo" href="#/memories/${e.id}">
        <img src="${e.photos?.[0]?.src || 'assets/placeholder-01.svg'}"
             alt="${escapeHtml(e.title)}" loading="lazy">
      </a>
      <div class="spread-text">
        <span class="spread-meta"><span class="spread-no">${String(i + 1).padStart(2, '0')}</span> · ${kind.en} · ${dotsDate(e.date)}</span>
        <h2><a href="#/memories/${e.id}">${escapeHtml(e.title)}</a></h2>
        ${e.location ? `<p class="spread-place">${escapeHtml(e.location)}</p>` : ''}
        <p class="spread-excerpt">${escapeHtml(excerpt(e.content, 76))}</p>
        <a class="spread-more" href="#/memories/${e.id}">Read the story</a>
      </div>
    </article>`;
  }).join('');

  return `
    <header class="page-hero">
      <div class="page-hero-text">
        <span class="eyebrow">Chapter I · Memories</span>
        <h1>回忆</h1>
        <p class="page-desc">旅行、约会和重要的日子，一共 ${list.length} 条。</p>
      </div>
      <div class="page-hero-act"><a class="btn btn-primary" href="#/memories/new">＋ 新增回忆</a></div>
    </header>

    ${list.length ? spreads : '<div class="empty">还没有回忆。</div>'}
  `;
}

/* ==========================================================================
   日记列表（日期栏 + 窄栏正文，阅读优先）
   ========================================================================== */
export function renderJournal({ entries }) {
  const list = pick(entries, 'journal');

  const rows = list.map((e) => {
    const d = splitDate(e.date);
    const mood = MOODS[e.mood];
    const [, mm, ] = e.date.split('-');

    return `
    <li class="rail-row">
      <div class="rail-date">
        <span class="rail-day">${d.day}</span>
        <span class="rail-month">${EN_MONTH_SHORT[Number(mm) - 1]} ${e.date.slice(0, 4)}</span>
      </div>
      <div class="rail-body">
        ${mood ? `<span class="rail-feel">Feeling · ${mood.en}</span>` : ''}
        <h2><a href="#/journal/${e.id}">${escapeHtml(e.title)}</a></h2>
        <p>${escapeHtml(excerpt(e.content, 92))}</p>
        <a class="rail-more" href="#/journal/${e.id}">Read</a>
      </div>
    </li>`;
  }).join('');

  return `
    <header class="page-hero">
      <div class="page-hero-text">
        <span class="eyebrow">Chapter II · Journal</span>
        <h1>日记</h1>
        <p class="page-desc">日常的小事和当时的心情，一共 ${list.length} 篇。</p>
      </div>
      <div class="page-hero-act"><a class="btn btn-primary" href="#/journal/new">＋ 写今天的</a></div>
    </header>

    ${list.length ? `<ul class="entries-rail">${rows}</ul>` : '<div class="empty">还没有日记。</div>'}
  `;
}

/* ==========================================================================
   信件列表（奶油白上的书脊目录）
   ========================================================================== */
export function renderLetters({ entries }) {
  const list = pick(entries, 'letter');

  const rows = list.map((e, i) => `
    <li>
      <a class="spine-row" href="#/letters/${e.id}">
        <span class="spine-no">${String(i + 1).padStart(2, '0')}</span>
        <span class="spine-to">致 ${escapeHtml(e.to || '你')}
          <span class="spine-date">${dotsDate(e.date)}</span>
        </span>
        <h2 class="spine-title">${escapeHtml(e.title)}</h2>
        <span class="spine-more">Read</span>
        <span class="spine-excerpt">${escapeHtml(excerpt(e.content, 74))}</span>
      </a>
    </li>`).join('');

  return `
    <header class="page-hero">
      <div class="page-hero-text">
        <span class="eyebrow">Chapter III · Letters</span>
        <h1>信件</h1>
        <p class="page-desc">写给对方，也写给自己，一共 ${list.length} 封。</p>
      </div>
      <div class="page-hero-act"><a class="btn btn-primary" href="#/letters/new">＋ 写一封信</a></div>
    </header>

    ${list.length ? `<ol class="spine">${rows}</ol>` : '<div class="empty">还没有信件。</div>'}
  `;
}

/* ==========================================================================
   详情页（回忆 / 日记 / 信件 / 想说的话 共用，按 type 分支）
   ========================================================================== */
export function renderDetail({ entry }) {
  const section = SECTIONS[entry.type] || SECTIONS.memory;
  const back = `<a class="back-link" href="${section.listPath}">← 返回 ${section.listName}</a>`;
  /* 四个栏目都支持增删改了（第三轮），所以工具栏统一输出真按钮 */
  const editPath = (SECTIONS[entry.type] || SECTIONS.memory).listPath;
  const toolbar = `
    <div class="detail-toolbar">
      <a class="btn" href="${editPath}/${encodeURIComponent(entry.id)}/edit">编辑</a>
      <button type="button" class="btn" data-delete-entry="${escapeHtml(entry.id)}">删除</button>
    </div>`;

  /* ---------- 回忆：图版 + 正文 ---------- */
  if (entry.type === 'memory') {
    const kind = MEMORY_KINDS[entry.kind] || MEMORY_KINDS.other;

    /* 每张照片包一层按钮，直接复用首页灯箱（data-lightbox / data-src / data-caption）
       同时按构图方向加一个类名，交给 CSS 决定展示多宽。
       照片本身永远是原始比例（靠 CSS 的 width:100% + height:auto）。 */
    let portraitCount = 0;                 // 竖构图单独计数，保证它们左右交替（不受横图影响）

    const plates = (entry.photos || []).map((p, i) => {
      const caption = `${entry.location ? entry.location + ' · ' : ''}${dotsDate(entry.date)}${p.caption ? '　' + p.caption : ''}`;

      const shape = photoShape(p);
      const flip = shape === 'p' && (portraitCount += 1) % 2 === 0;

      return `
      <figure class="detail-plate detail-plate--${shape}${flip ? ' detail-plate--right' : ''}">
        <button type="button" class="shot-btn"
                data-lightbox="${i}"
                data-src="${p.src}"
                data-caption="${escapeHtml(caption)}"
                aria-label="放大查看照片：${escapeHtml(p.caption || entry.title)}">
          <img src="${p.src}" alt="${escapeHtml(p.caption || entry.title)}" loading="lazy">
        </button>
        ${p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : ''}
      </figure>`;
    }).join('');

    return `
      ${back}
      <article class="detail-head">
        <div class="detail-meta">
          <span>${kind.en}</span>
          <span>${dotsDate(entry.date)}</span>
          ${entry.location ? `<span>${escapeHtml(entry.location)}</span>` : ''}
        </div>
        <h1>${escapeHtml(entry.title)}</h1>
        ${toolbar}
        ${plates ? `<div class="detail-plates">${plates}</div>` : ''}
        <div class="detail-content">${paragraphs(entry.content)}</div>
      </article>`;
  }

  /* ---------- 日记：窄栏阅读 ---------- */
  if (entry.type === 'journal') {
    const mood = MOODS[entry.mood];

    return `
      ${back}
      <article class="detail-head">
        <div class="detail-meta">
          <span>${dotsDate(entry.date)}</span>
        </div>
        <h1>${escapeHtml(entry.title)}</h1>
        ${toolbar}
        ${mood ? `<div class="detail-feel">Feeling · ${mood.en}</div>` : ''}
        <div class="detail-content">${paragraphs(entry.content)}</div>
      </article>`;
  }

  /* ---------- 信件：深棕暗场 + 奶油白信纸 ---------- */
  if (entry.type === 'letter') {
    return `
      ${back}
      <article class="detail-head">
        <div class="detail-meta">
          <span>Dearest · ${escapeHtml(entry.to || '你')}</span>
          <span>${dotsDate(entry.date)}</span>
        </div>
        <h1>${escapeHtml(entry.title)}</h1>
        ${toolbar}
      </article>

      <div class="letter-paper">
        <p class="letter-salutation">${escapeHtml(entry.to || '你')}：</p>
        <div class="detail-content">${paragraphs(entry.content)}</div>
        <p class="letter-sign">— 写于 ${fmtDate(entry.date)}</p>
      </div>`;
  }

  /* ---------- 想说的话：对话场景 ---------- */
  if (entry.type === 'words') {
    const turns = (entry.turns || []).map((t) => `
      <div class="turn turn--${t.who === 'you' ? 'you' : 'me'}">
        <span class="turn-who">${t.who === 'you' ? 'You' : 'Me'}</span>
        <p class="turn-text">${escapeHtml(t.text)}</p>
      </div>`).join('');

    return `
      ${back}
      <article class="detail-head">
        <div class="detail-meta">
          <span>${dotsDate(entry.date)}${entry.time ? ' · ' + entry.time : ''}</span>
          ${entry.feeling ? `<span>${escapeHtml(entry.feeling)}</span>` : ''}
        </div>
        <h1>${escapeHtml(entry.title)}</h1>
        ${toolbar}
      </article>

      <div class="dialogue">${turns}</div>`;
  }

  return renderNotFound();
}

/* ==========================================================================
   Words（想说的话）：对话记录目录
   ========================================================================== */
export function renderWords({ entries }) {
  const list = pick(entries, 'words');

  const rows = list.map((e) => `
    <li>
      <a class="talk-row" href="#/words/${e.id}">
        <span class="talk-meta">
          <span>${dotsDate(e.date)}${e.time ? ' · ' + e.time : ''}</span>
          <span class="talk-count">${(e.turns || []).length} turns</span>
        </span>
        <h2>${escapeHtml(e.title)}</h2>
        <span class="talk-first">${escapeHtml(e.turns?.[0]?.text || '')}</span>
      </a>
    </li>`).join('');

  return `
    <header class="page-hero">
      <div class="page-hero-text">
        <span class="eyebrow">Chapter IV · Words</span>
        <h1>Words</h1>
        <p class="page-desc">想说的话 —— 一次对话，一条记录，一共 ${list.length} 段。</p>
      </div>
      <div class="page-hero-act"><a class="btn btn-primary" href="#/words/new">＋ 记一段对话</a></div>
    </header>

    ${list.length ? `<ol class="talks">${rows}</ol>` : '<div class="empty">还没有对话记录。</div>'}
  `;
}

/* ==========================================================================
   设置页
   ========================================================================== */
/* --------------------------------------------------------------------------
   设置页要用的小工具
   -------------------------------------------------------------------------- */

/** 把字节数说成人话（全站统一用这一个） */
export function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 备份健康度：算出状态、标题与说明 */
function backupHealth({ lastBackupAt, lastImportAt, hasData }) {
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  if (!lastBackupAt) {
    return {
      tone: 'warn',
      title: '还没有备份过',
      text: hasData
        ? '浏览器里的数据随时可能被系统清理，建议现在就导出一份备份。'
        : '等你开始记录之后，记得定期导出一份备份。'
    };
  }

  const days = Math.floor((Date.now() - lastBackupAt) / 86400000);
  const restored = lastImportAt ? `　·　上次恢复：${when(lastImportAt)}` : '';

  if (days >= 30) {
    return {
      tone: 'due',
      title: `已经 ${days} 天没有备份了`,
      text: `上次备份：${when(lastBackupAt)}。建议重新导出一份。${restored}`
    };
  }

  return {
    tone: 'ok',
    title: days === 0 ? '今天备份过' : `上次备份：${days} 天前`,
    text: `上次备份：${when(lastBackupAt)}${restored}`
  };
}

export function renderSettings({ entries, stats = null, lastBackupAt = 0, lastImportAt = 0, estimate = null } = {}) {
  const counts = {
    memory:  pick(entries, 'memory').length,
    journal: pick(entries, 'journal').length,
    letter:  pick(entries, 'letter').length,
    words:   pick(entries, 'words').length
  };

  const totalEntries = entries.length;
  const photoCount = stats ? stats.count : 0;
  const photoBytes = stats ? stats.bytes : 0;

  const health = backupHealth({
    lastBackupAt,
    lastImportAt,
    hasData: totalEntries > 0 || photoCount > 0
  });

  return `
    <header class="page-head">
      <div class="page-head-text">
        <h1>设置</h1>
        <p class="page-desc">数据备份、存储占用与项目信息。</p>
      </div>
    </header>

    <section class="settings-block">
      <h2>数据备份</h2>
      <p>
        把当前所有记录和照片导出成一个 JSON 文件，用来长期保存、或换电脑时迁移。
      </p>
      <div class="settings-row">
        <button type="button" class="btn btn-primary" data-action="export-backup">导出备份</button>
        <button type="button" class="btn" data-action="import-backup">从备份恢复…</button>
      </div>
      <p class="settings-note backup-result" data-backup-note hidden></p>
      <p class="settings-note">
        备份里包含：全部文字记录（回忆 / 日记 / 信件 / 想说的话）+ 全部照片。<br>
        不包含缩略图 —— 缩略图是派生的，导入时会自动重新生成，所以备份文件更小。
      </p>
    </section>

    <section class="settings-block">
      <h2>备份健康度</h2>
      <div class="health health--${health.tone}">
        <span class="health-dot" aria-hidden="true"></span>
        <div class="health-main">
          <span class="health-title">${escapeHtml(health.title)}</span>
          <span class="health-text">${escapeHtml(health.text)}</span>
        </div>
      </div>
    </section>

    <section class="settings-block">
      <h2>存储占用</h2>
      <p>照片会先压缩到长边 1600px 再存进本机浏览器，所以占用远小于原图。</p>

      <div class="stat-grid">
        <div class="stat">
          <div class="stat-num">${counts.memory}</div>
          <div class="stat-label">条回忆</div>
        </div>
        <div class="stat">
          <div class="stat-num">${counts.journal}</div>
          <div class="stat-label">篇日记</div>
        </div>
        <div class="stat">
          <div class="stat-num">${counts.letter}</div>
          <div class="stat-label">封来信</div>
        </div>
        <div class="stat">
          <div class="stat-num">${counts.words}</div>
          <div class="stat-label">段对话</div>
        </div>
      </div>

      <div class="storage-lines">
        <p class="settings-note">
          ${photoCount
            ? `照片 ${photoCount} 张，约 ${formatBytes(photoBytes)}（已计算的真实占用）。`
            : '还没有照片。'}
        </p>
        ${estimate
          ? `<p class="settings-note">
               浏览器报告本网站共占用约 ${formatBytes(estimate.usage)}${estimate.quota ? `，可用配额约 ${formatBytes(estimate.quota)}` : ''}
               （含数据库与缓存开销，所以会比上面那个数字大）。
             </p>`
          : ''}
      </div>
    </section>

    <section class="settings-block settings-block--danger">
      <h2>危险操作</h2>
      <p>下面两个操作都无法撤销，做之前请先导出备份。</p>
      <div class="settings-row">
        <button type="button" class="btn" data-action="cleanup-orphans">清理没人引用的照片</button>
        <button type="button" class="btn btn-danger" data-action="clear-all">清空全部数据</button>
      </div>
      <p class="settings-note backup-result" data-danger-note hidden></p>
    </section>

    <section class="settings-block">
      <h2>关于</h2>
      <p>
        Birds Of A Feather —— 一个只属于两个人的本地纪念册。<br>
        所有内容都保存在这台电脑的浏览器里：不联网、不上传、不需要账号。
      </p>
      <p class="settings-note">
        数据只在浏览器里，换电脑或者清理浏览器数据都不会自动带走它 ——
        所以「导出备份」是你唯一的保命手段。
      </p>
    </section>
  `;
}

/* ==========================================================================
   找不到记录
   ========================================================================== */
export function renderNotFound() {
  return `
    <div class="empty">
      <p>没有找到这条记录。</p>
      <p><a class="back-link" href="#/">← 回到首页</a></p>
    </div>
  `;
}

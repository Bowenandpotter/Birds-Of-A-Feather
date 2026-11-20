/* ==========================================================================
   store.js —— 本地数据层（IndexedDB）
   --------------------------------------------------------------------------
   这里负责所有和"数据"有关的事 —— 页面不直接碰数据库，都经过这个文件：
     1. 建库建表（第一次打开时自动建好，以后不再重复建）
     2. 第一次打开时导入示例数据（只做一次，绝不覆盖你写的内容）
     3. 记录的读取 / 新增 / 编辑 / 删除（删记录会连它的照片一起删）
     4. 照片的读写与占用统计
     5. 维护：清空全部数据、查找没人引用的照片

   --------------------------------------------------------------------------
   数据库结构（bof，版本 1）

     entries    keyPath 'id'    文字记录（回忆 / 日记 / 信件 / 想说的话）
       ├ 索引 by_type       按类型取（列表页用）
       ├ 索引 by_date       按日期排序
       ├ 索引 by_type_date  类型 + 日期
       └ 索引 by_updated    最近修改（备份用）

     photos     keyPath 'id'    照片元数据 + 缩略图（第 4 轮开始写入）
       └ 索引 by_entry      属于哪条记录

     photoFull  keyPath 'id'    原尺寸图片字节，只在需要时读取（第 4 轮开始写入）

     meta       keyPath 'key'   配置与状态
       ├ seeded           首次导入是否已完成（永不复位）
       ├ togetherSince    恋爱起始日期
       └ lastBackupAt     上次备份时间（第 5 轮开始写入）

   为什么图片要拆成 photos 和 photoFull 两张表：
     列表页只要缩略图。如果原图字节和缩略图放在同一条记录里，
     列 20 条记录就会把 20 张原图一起读进内存，既慢又占内存。
     拆开之后，只有详情页和灯箱才去读原图。
   ========================================================================== */

export const DB_NAME = 'bof';
export const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;

const S_ENTRIES = 'entries';
const S_PHOTOS = 'photos';
const S_PHOTO_FULL = 'photoFull';
const S_META = 'meta';

/* ==========================================================================
   基础工具
   ========================================================================== */

/** 带标记的错误：让界面能区分"数据库打不开"和其他普通错误 */
function dbError(kind, message, cause) {
  const err = new Error(message);
  err.kind = kind;
  err.cause = cause || null;
  return err;
}

/** 把一次 IndexedDB 请求包成 Promise */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 在一个事务里执行 body。
 * 注意：body 里只允许 await 数据库请求 —— 如果 await 了 setTimeout / fetch 之类
 * 不属于这个事务的东西，浏览器会自动提交事务，后面的请求就会报错。
 */
function runTx(db, names, mode, body) {
  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(names, mode);
    } catch (err) {
      reject(dbError('txFailed', '无法打开数据表', err));
      return;
    }

    const stores = {};
    names.forEach((name) => { stores[name] = transaction.objectStore(name); });

    let result;
    let failure = null;

    transaction.oncomplete = () => {
      if (failure) reject(failure);
      else resolve(result);
    };

    transaction.onabort = () => {
      reject(failure || transaction.error || dbError('aborted', '数据操作被中断'));
    };

    Promise.resolve()
      .then(() => body(stores, transaction))
      .then((value) => { result = value; })
      .catch((err) => {
        failure = err;
        try { transaction.abort(); } catch (e) { /* 已经结束就不用管 */ }
      });
  });
}

/** 记录排序：日期倒序；同一天则 id 大的在前（和页面显示保持一致） */
function byDateDesc(a, b) {
  if (a.date === b.date) return a.id < b.id ? 1 : -1;
  return a.date < b.date ? 1 : -1;
}

/* ==========================================================================
   打开数据库
   ========================================================================== */

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(dbError('unavailable', '这个浏览器不允许本网站保存数据（可能开了无痕/隐私模式）'));
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(dbError('unavailable', '这个浏览器不允许本网站保存数据', err));
      return;
    }

    /* ---- 第一次打开（或以后升级结构）时执行 ---- */
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const from = event.oldVersion;   // 0 = 全新的数据库

      if (from < 1) {
        const entries = db.createObjectStore(S_ENTRIES, { keyPath: 'id' });
        entries.createIndex('by_type', 'type', { unique: false });
        entries.createIndex('by_date', 'date', { unique: false });
        entries.createIndex('by_type_date', ['type', 'date'], { unique: false });
        entries.createIndex('by_updated', 'updatedAt', { unique: false });

        const photos = db.createObjectStore(S_PHOTOS, { keyPath: 'id' });
        photos.createIndex('by_entry', 'entryId', { unique: false });

        db.createObjectStore(S_PHOTO_FULL, { keyPath: 'id' });
        db.createObjectStore(S_META, { keyPath: 'key' });
      }

      // 以后要加表或加字段时，继续往下写：if (from < 2) { ... }
    };

    request.onsuccess = () => {
      const db = request.result;

      // 其他标签页要升级数据库时主动让路，免得把对方卡住
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      const err = request.error;

      if (err && err.name === 'VersionError') {
        reject(dbError('versionTooOld', '本地存的数据版本比当前网页更新，请刷新或更新网页', err));
      } else {
        reject(dbError('openFailed', '打不开本地数据库', err));
      }
    };

    request.onblocked = () => {
      reject(dbError('blocked', '这个网站还有其他标签页开着，请关掉它们之后刷新页面'));
    };
  });

  return dbPromise;
}

/* ==========================================================================
   首次运行：导入示例数据
   --------------------------------------------------------------------------
   四道保险，确保"只导入一次、永不覆盖你写的内容"：
     1. 只有在 meta.seeded 不存在时才执行
     2. 播种后写入 meta.seeded（这个标记永远不会被重置）
     3. 每条数据写入前先查 id 是否已存在，已存在就跳过（用 put 但先判存）
     4. 打上 origin:'sample' 标记，方便以后"一键清除示例数据"时不动你的记录
   ========================================================================== */
export async function initStore({ seedEntries = [], togetherSince = null } = {}) {
  const db = await openDB();

  const alreadySeeded = await getMeta('seeded');
  if (alreadySeeded) return { seeded: false, count: 0 };

  const now = Date.now();
  let inserted = 0;

  await runTx(db, [S_ENTRIES, S_META], 'readwrite', async (s) => {
    for (const raw of seedEntries) {
      const exists = await req(s[S_ENTRIES].get(raw.id));
      if (exists) continue;

      s[S_ENTRIES].put({
        ...raw,
        origin: 'sample',
        createdAt: now,
        updatedAt: now
      });
      inserted += 1;
    }

    if (togetherSince) {
      s[S_META].put({ key: 'togetherSince', value: togetherSince });
    }

    s[S_META].put({ key: 'seeded', value: { at: now, schemaVersion: SCHEMA_VERSION } });
  });

  return { seeded: true, count: inserted };
}

/* ==========================================================================
   读取
   ========================================================================== */

/**
 * 读出记录（不含图片字节），按日期倒序。
 * 不传 type 就是全部。
 */
export async function listEntries(type) {
  const db = await openDB();

  return runTx(db, [S_ENTRIES], 'readonly', async (s) => {
    const store = s[S_ENTRIES];
    const rows = type
      ? await req(store.index('by_type').getAll(type))
      : await req(store.getAll());

    return rows.sort(byDateDesc);
  });
}

/** 读出单条记录；找不到返回 null */
export async function getEntry(id) {
  const db = await openDB();

  return runTx(db, [S_ENTRIES], 'readonly', async (s) => {
    const row = await req(s[S_ENTRIES].get(id));
    return row || null;
  });
}

/** 读配置；没有就返回 fallback */
export async function getMeta(key, fallback = null) {
  const db = await openDB();

  return runTx(db, [S_META], 'readonly', async (s) => {
    const row = await req(s[S_META].get(key));
    return row ? row.value : fallback;
  });
}

/** 写配置（第 2 轮起会用到） */
export async function setMeta(key, value) {
  const db = await openDB();

  return runTx(db, [S_META], 'readwrite', async (s) => {
    s[S_META].put({ key, value });
  });
}

/* ==========================================================================
   写入（第二轮新增：回忆的新增 / 编辑 / 删除）
   ========================================================================== */

/** 各类记录的编号前缀。只是为了看得懂，不影响功能。 */
const ID_PREFIX = { memory: 'm', journal: 'j', letter: 'l', words: 'w' };

/** 生成一个不会重复的编号（外部也会用：新增记录时需要先定好 id 才能先写照片） */
export function newId(type) {
  const prefix = ID_PREFIX[type] || 'e';
  const tail = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

  return `${prefix}-${Date.now().toString(36)}-${tail}`;
}

/** 把记录整理成规范形状，避免缺字段导致页面出错 */
function normalize(entry, now) {
  return {
    ...entry,
    id: String(entry.id),
    origin: entry.origin === 'sample' ? 'sample' : 'user',
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now
  };
}

/** 新增一条记录，返回写入后的完整记录（含自动生成的 id） */
export async function createEntry(data) {
  const db = await openDB();
  const now = Date.now();

  const entry = normalize({
    ...data,
    id: data.id || newId(data.type),
    createdAt: now,
    updatedAt: now,
    origin: 'user'
  }, now);

  await runTx(db, [S_ENTRIES], 'readwrite', async (s) => {
    s[S_ENTRIES].put(entry);
  });

  return entry;
}

/** 修改一条记录（只覆盖传进来的字段，id 与 createdAt 不变） */
export async function updateEntry(id, patch) {
  const db = await openDB();
  const now = Date.now();

  const existing = await getEntry(id);
  if (!existing) throw dbError('notFound', '这条记录已经不存在了（可能已在其他标签页删掉）');

  const entry = normalize({
    ...existing,
    ...patch,
    id,
    createdAt: existing.createdAt || now,
    origin: existing.origin || 'user',
    updatedAt: now
  }, now);

  await runTx(db, [S_ENTRIES], 'readwrite', async (s) => {
    s[S_ENTRIES].put(entry);
  });

  return entry;
}

/**
 * 删除一条记录 —— 连同它名下的照片一起删，三者在一个事务里完成。
 * 要么全成功，要么全回滚，不会出现"记录删了、照片还在"或反过来的情况。
 */
export async function deleteEntry(id) {
  const db = await openDB();

  await runTx(db, [S_ENTRIES, S_PHOTOS, S_PHOTO_FULL], 'readwrite', async (s) => {
    const photos = await req(s[S_PHOTOS].index('by_entry').getAll(id));

    s[S_ENTRIES].delete(id);

    photos.forEach((photo) => {
      s[S_PHOTOS].delete(photo.id);
      s[S_PHOTO_FULL].delete(photo.id);
    });
  });
}

/* ==========================================================================
   照片（第四轮新增）
   --------------------------------------------------------------------------
   photos    : 元数据 + 缩略图（列表页只读这张表）
   photoFull : 原尺寸字节（只有详情页和灯箱才读）
   ========================================================================== */

/**
 * 批量保存照片，每批一个小事务，返回 { ok: Set, failed: [], quota: bool }。
 * 把已经写成功的 id 交回调用方，是为了让"写记录"阶段能据此清洗失效引用 ——
 * 写失败的照片，其引用必须在写记录之前拿掉。
 */
export async function savePhotos(items, options = {}) {
  const db = await openDB();
  const list = (items || []).filter((item) => item && item.id);
  const batchSize = options.batchSize || 5;

  const ok = new Set();
  const failed = [];
  let quota = false;

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);

    try {
      await runTx(db, [S_PHOTOS, S_PHOTO_FULL], 'readwrite', async (s) => {
        batch.forEach((item) => {
          s[S_PHOTOS].put({
            id: item.id,
            entryId: item.entryId || '',
            mime: item.mime || 'image/jpeg',
            width: item.width || 0,
            height: item.height || 0,
            thumbBytes: item.thumbBytes || null,
            // 把体积记下来：导出时能快速估算大小、设置页统计也不用把所有字节读一遍
            thumbSize: item.thumbSize || (item.thumbBytes ? item.thumbBytes.byteLength : 0),
            fullSize: item.fullSize || (item.fullBytes ? item.fullBytes.byteLength : 0),
            createdAt: item.createdAt || Date.now()
          });

          s[S_PHOTO_FULL].put({ id: item.id, bytes: item.fullBytes || null });
        });
      });

      batch.forEach((item) => ok.add(item.id));
    } catch (err) {
      // 整批失败（事务是原子的，不会写一半）
      const isQuota = err && (err.name === 'QuotaExceededError' || String(err.message || '').indexOf('quota') >= 0);

      if (isQuota) {
        quota = true;
        list.slice(i).forEach((item) => failed.push({ id: item.id, reason: err }));
        break;                                   // 空间不够，再写也没用
      }

      batch.forEach((item) => failed.push({ id: item.id, reason: err }));
    }

    if (options.onProgress) options.onProgress(ok.size, list.length);
  }

  return { ok, failed, quota };
}

/** 读一张照片的元数据（含缩略图字节） */
export async function getPhoto(id) {
  const db = await openDB();

  return runTx(db, [S_PHOTOS], 'readonly', async (s) => {
    const row = await req(s[S_PHOTOS].get(id));
    return row || null;
  });
}

/** 只读原尺寸字节（详情页与灯箱用） */
export async function getPhotoFull(id) {
  const db = await openDB();

  return runTx(db, [S_PHOTO_FULL], 'readonly', async (s) => {
    const row = await req(s[S_PHOTO_FULL].get(id));
    return row ? row.bytes : null;
  });
}

/** 列出照片元数据；不传 entryId 就是全部 */
export async function listPhotos(entryId) {
  const db = await openDB();

  return runTx(db, [S_PHOTOS], 'readonly', async (s) => {
    if (!entryId) return req(s[S_PHOTOS].getAll());
    return req(s[S_PHOTOS].index('by_entry').getAll(entryId));
  });
}

/** 只列出所有照片编号（很轻，用来判断某张照片到底在不在库里） */
export async function listPhotoIds() {
  const db = await openDB();

  return runTx(db, [S_PHOTOS], 'readonly', async (s) => {
    return req(s[S_PHOTOS].getAllKeys());
  });
}

/** 删一批照片（两张表一起删） */
export async function deletePhotos(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return 0;

  const db = await openDB();

  await runTx(db, [S_PHOTOS, S_PHOTO_FULL], 'readwrite', async (s) => {
    list.forEach((id) => {
      s[S_PHOTOS].delete(id);
      s[S_PHOTO_FULL].delete(id);
    });
  });

  return list.length;
}

/** 这张记录名下有几张照片（删除确认框要用） */
export async function countPhotos(entryId) {
  const db = await openDB();

  return runTx(db, [S_PHOTOS], 'readonly', async (s) => {
    return req(s[S_PHOTOS].index('by_entry').count(entryId));
  });
}

/** 照片占用统计（只读元数据，不读字节，所以很快） */
export async function photoStats() {
  const db = await openDB();

  return runTx(db, [S_PHOTOS], 'readonly', async (s) => {
    const metas = await req(s[S_PHOTOS].getAll());

    let bytes = 0;
    metas.forEach((m) => {
      bytes += (m.fullSize || 0) + (m.thumbSize || (m.thumbBytes ? m.thumbBytes.byteLength : 0));
    });

    return { count: metas.length, bytes };
  });
}

/* ==========================================================================
   维护：清空全部数据 / 查找孤儿照片（第五轮新增）
   ========================================================================== */

/**
 * 清空全部数据：记录 + 照片 + 原图。
 * ★ 三张表在【同一个事务】里清空 —— 要么全成功，要么全回滚，
 *   绝不会出现"记录清了、照片还在"这种半途状态。
 * 　meta（恋爱起始日期、seeded 标记等配置）保留不动，
 *   所以清空后不会自动重新导入示例数据。
 */
export async function clearAllData() {
  const db = await openDB();

  await runTx(db, [S_ENTRIES, S_PHOTOS, S_PHOTO_FULL], 'readwrite', async (s) => {
    s[S_ENTRIES].clear();
    s[S_PHOTOS].clear();
    s[S_PHOTO_FULL].clear();
  });
}

/**
 * 找出"孤儿照片"：没有任何记录引用、并且创建时间早于 graceMs 的照片。
 *
 * 为什么要加时间门槛：
 *   保存一条回忆时是"先写照片、后写记录"，中间有极短的间隔。
 *   如果恰好在这个间隔里清理，就会把正在保存的照片误删。
 *   所以只清理 10 分钟以前创建的，正在保存中的照片碰不到。
 *
 * 只负责"找"，不负责"删" —— 删之前必须让用户看到数量并确认。
 */
export async function findOrphanPhotos(options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 10 * 60 * 1000;
  const db = await openDB();

  return runTx(db, [S_ENTRIES, S_PHOTOS], 'readonly', async (s) => {
    const entries = await req(s[S_ENTRIES].getAll());
    const metas = await req(s[S_PHOTOS].getAll());

    // 被任何一条记录引用过的照片编号
    const referenced = new Set();
    entries.forEach((entry) => {
      (entry.photos || []).forEach((photo) => {
        if (photo.photoId) referenced.add(photo.photoId);
      });
    });

    const cutoff = Date.now() - graceMs;
    const orphans = metas.filter((m) => {
      if (referenced.has(m.id)) return false;
      return (Number(m.createdAt) || 0) < cutoff;      // 太新的不动
    });

    let bytes = 0;
    orphans.forEach((m) => {
      bytes += (m.fullSize || 0) + (m.thumbSize || (m.thumbBytes ? m.thumbBytes.byteLength : 0));
    });

    return {
      ids: orphans.map((m) => m.id),
      count: orphans.length,
      bytes,
      totalPhotos: metas.length,
      referencedCount: referenced.size
    };
  });
}

/* ==========================================================================
   批量写入（供备份恢复使用）
   ========================================================================== */

/** 批量写入记录（一个事务写完，中途出错会全部回滚） */
export async function putEntries(list) {
  const db = await openDB();
  const now = Date.now();
  const safe = (list || []).map((entry) => normalize(entry, now));

  await runTx(db, [S_ENTRIES], 'readwrite', async (s) => {
    safe.forEach((entry) => s[S_ENTRIES].put(entry));
  });

  return safe.length;
}

/** 清空所有记录（供"覆盖式恢复"使用；调用前请确认已经让用户二次确认） */
export async function clearEntries() {
  const db = await openDB();

  await runTx(db, [S_ENTRIES], 'readwrite', async (s) => {
    s[S_ENTRIES].clear();
  });
}

/** 记录总数（备份预览用） */
export async function countEntries() {
  const db = await openDB();

  return runTx(db, [S_ENTRIES], 'readonly', async (s) => {
    return req(s[S_ENTRIES].count());
  });
}

/**
 * 用一批新记录替掉现有全部记录。
 * 重要："清空 + 写入"在同一个事务里完成 ——
 * 如果中途出错，整个事务会回滚，现有数据不会变成一半被删一半写入。
 * 覆盖式恢复备份时必须用这个函数。
 */
export async function replaceAllEntries(list) {
  const db = await openDB();
  const now = Date.now();
  const safe = (list || []).map((entry) => normalize(entry, now));

  await runTx(db, [S_ENTRIES], 'readwrite', async (s) => {
    s[S_ENTRIES].clear();
    safe.forEach((entry) => s[S_ENTRIES].put(entry));
  });

  return safe.length;
}

/* ==========================================================================
   backup.js —— 备份与恢复
   --------------------------------------------------------------------------
   能做：
     · 把所有文字记录 + 照片导出成一个 JSON 文件
     · 从 JSON 恢复（覆盖 / 合并，都要你确认）

   备份文件格式
     {
       format: 'bof-backup',
       formatVersion: 2,
       app, exportedAt,
       config: { togetherSince },
       counts: { entries, photos },
       entries: [ ...完整记录... ],        ← 照片引用就在记录里
       photos: [ { id, entryId, mime, width, height, createdAt, data: 'base64…' } ]
     }

   两个重要设计：

   ① 只装大图，不装缩略图
      缩略图是"派生数据"（缓存）。导入时按需重新生成，
      少装一份能让备份小 15~20%，格式也更简单。
      万一重新生成失败，显示时会自动退回大图，不会空白。

   ② 导入分三阶段，顺序是刻意的
        先写照片 → 再清洗引用 → 最后写记录
      记录永远最后写，而且写之前引用已经被清洗过，
      所以【导入完成后不可能存在指向不存在照片的引用】。
      最后还会跑一次校验并如实报告。
   ========================================================================== */

import {
  listEntries, getMeta, setMeta, putEntries, replaceAllEntries,
  listPhotos, getPhotoFull, listPhotoIds, savePhotos, deletePhotos
} from './store.js';
import { prepareImage } from './image.js';

export const FORMAT = 'bof-backup';
export const FORMAT_VERSION = 2;

const KNOWN_TYPES = ['memory', 'journal', 'letter', 'words'];

/* ==========================================================================
   小工具
   ========================================================================== */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 二进制 → base64（用 FileReader，异步且不会爆栈） */
function bytesToBase64(bytes, mime) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const reader = new FileReader();

    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      resolve(comma >= 0 ? text.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('读取照片失败'));

    reader.readAsDataURL(blob);
  });
}

/** base64 → 二进制；坏数据返回 null */
function base64ToBytes(data) {
  try {
    const clean = String(data || '').replace(/\s+/g, '');
    if (!clean) return null;

    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    return bytes.buffer;
  } catch (err) {
    return null;
  }
}

/* ==========================================================================
   导出
   ========================================================================== */

/**
 * 先做一个"导出计划"：算出有多少记录、多少照片、大约多大。
 * 这一步只读元数据、不读照片字节，所以很快，可以做体积预警。
 */
export async function planBackup() {
  const entries = await listEntries();
  const togetherSince = await getMeta('togetherSince', null);

  // 只导出"还被记录引用着"的照片（没被引用的属于孤儿，不带进备份）
  const referenced = [];
  const seen = new Set();

  entries.forEach((entry) => {
    (entry.photos || []).forEach((photo) => {
      if (photo.photoId && !seen.has(photo.photoId)) {
        seen.add(photo.photoId);
        referenced.push(photo.photoId);
      }
    });
  });

  const metas = await listPhotos();
  const byId = new Map(metas.map((m) => [m.id, m]));

  const photos = [];
  let rawBytes = 0;
  let missing = 0;

  referenced.forEach((id) => {
    const meta = byId.get(id);
    if (!meta) { missing += 1; return; }          // 元数据不在了 → 这张不带，记录里的引用稍后会被清洗

    const size = meta.fullSize || 0;
    rawBytes += size;

    photos.push({
      id: meta.id,
      entryId: meta.entryId || '',
      mime: meta.mime || 'image/jpeg',
      width: meta.width || 0,
      height: meta.height || 0,
      createdAt: meta.createdAt || 0,
      size
    });
  });

  return {
    payload: {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      app: 'Birds Of A Feather',
      exportedAt: new Date().toISOString(),
      config: { togetherSince },
      counts: { entries: entries.length, photos: photos.length }
    },
    entries,
    photos,
    rawBytes,
    estimatedBytes: Math.round(rawBytes * 4 / 3) + entries.length * 400,   // base64 会膨胀约 1/3
    missingPhotos: missing
  };
}

/**
 * 生成完整的备份文本。
 * 逐张读字节、逐张编码、逐张拼进结果 —— 任何一刻内存里只多一张照片。
 */
export async function exportBackupText(plan, options = {}) {
  const photos = plan.photos || [];
  const chunks = [];

  const SENTINEL = '__BOF_PHOTOS__';
  const head = Object.assign({}, plan.payload, { entries: plan.entries, photos: SENTINEL });
  const headText = JSON.stringify(head, null, 2);
  const at = headText.indexOf(JSON.stringify(SENTINEL));

  const prefix = at >= 0 ? headText.slice(0, at) : '';
  const suffix = at >= 0 ? headText.slice(at + JSON.stringify(SENTINEL).length) : '';

  chunks.push(prefix, '[');

  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    let data = '';

    try {
      const bytes = await getPhotoFull(photo.id);
      if (bytes) data = await bytesToBase64(bytes, photo.mime);
    } catch (err) {
      data = '';                                  // 读不出来就留空，导入时会被当作损坏照片处理
    }

    const item = {
      id: photo.id,
      entryId: photo.entryId,
      mime: photo.mime,
      width: photo.width,
      height: photo.height,
      createdAt: photo.createdAt,
      data
    };

    chunks.push((i ? ',\n' : ''), JSON.stringify(item));

    if (options.onProgress) options.onProgress(i + 1, photos.length);
  }

  chunks.push(']', suffix);

  return chunks.join('');
}

/** 触发浏览器下载，返回文件名与体积 */
export function downloadText(text, name) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();

  // 稍后再释放，避免 Safari 还没开始下载地址就失效
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (err) { /* 已经失效就算了 */ }
  }, 3000);

  return { name, bytes: blob.size };
}

export function backupFileName() {
  return `bof-backup-${stamp()}.json`;
}

/* ==========================================================================
   解析与校验
   ========================================================================== */

function fatal(message) {
  return { ok: false, fatal: message, problems: [], entries: [], photos: [], summary: null };
}

export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fatal('这个文件的内容不是有效的 JSON，可能选错了文件，或者文件损坏了。');
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fatal('这个文件的内容不像一份备份。');
  }

  if (raw.format !== FORMAT) {
    return fatal('这不是本网站导出的备份文件（缺少格式标记）。');
  }

  const version = Number(raw.formatVersion);
  if (!Number.isFinite(version)) {
    return fatal('备份文件里没有写明格式版本，无法确认兼容性。');
  }

  if (version > FORMAT_VERSION) {
    return fatal(`这份备份来自更新的版本（v${version}），当前网站只认到 v${FORMAT_VERSION}。请先更新网页再恢复。`);
  }

  if (!Array.isArray(raw.entries)) {
    return fatal('备份文件里没有找到记录列表。');
  }

  /* ---- 记录 ---- */
  const entries = [];
  const problems = [];
  const seen = new Set();

  raw.entries.forEach((item, index) => {
    const at = `第 ${index + 1} 条记录`;

    if (!item || typeof item !== 'object') { problems.push(`${at}不是有效记录，已跳过`); return; }
    if (typeof item.id !== 'string' || !item.id) { problems.push(`${at}缺少编号，已跳过`); return; }
    if (seen.has(item.id)) { problems.push(`${at}（${item.id}）在文件里重复出现，已跳过`); return; }
    if (!KNOWN_TYPES.includes(item.type)) { problems.push(`${at}（${item.id}）的类型「${item.type}」无法识别，已跳过`); return; }
    if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      problems.push(`${at}（${item.id}）的日期不是 YYYY-MM-DD 格式，已跳过`);
      return;
    }

    seen.add(item.id);
    entries.push(item);
  });

  /* ---- 照片 ---- */
  const photos = [];
  const sourcePhotos = Array.isArray(raw.photos) ? raw.photos : [];

  sourcePhotos.forEach((item, index) => {
    const at = `第 ${index + 1} 张照片`;

    if (!item || typeof item !== 'object') { problems.push(`${at}格式不对，已跳过`); return; }
    if (typeof item.id !== 'string' || !item.id) { problems.push(`${at}缺少编号，已跳过`); return; }
    if (typeof item.data !== 'string' || !item.data) { problems.push(`${at}（${item.id}）没有图片数据，已跳过`); return; }
    if (photos.some((p) => p.id === item.id)) { problems.push(`${at}（${item.id}）重复出现，已跳过`); return; }

    photos.push(item);
  });

  if (entries.length === 0) {
    return fatal('这个备份文件里没有一条可用的记录。');
  }

  const byType = {};
  entries.forEach((item) => { byType[item.type] = (byType[item.type] || 0) + 1; });

  // 粗估照片总字节（base64 长度约是原字节的 4/3，反过来乘 0.75）
  let approxBytes = 0;
  photos.forEach((item) => { approxBytes += Math.round(String(item.data || '').length * 0.75); });

  return {
    ok: true,
    fatal: null,
    problems,
    entries,
    photos,
    summary: {
      formatVersion: version,
      exportedAt: raw.exportedAt || null,
      entries: entries.length,
      byType,
      photoCount: photos.length,
      approxBytes,
      declaredPhotos: Array.isArray(raw.counts) ? (raw.counts.photos || 0) : 0,
      hasPhotos: photos.length > 0,
      // v1 的老备份不带照片
      legacy: version < 2
    }
  };
}

/* ==========================================================================
   写入
   ========================================================================== */

/**
 * 恢复导入。
 *   mode = 'merge'   → 合并：同编号保留"最后修改时间较新"的那条
 *   mode = 'replace' → 覆盖：先清空现有记录，再写入备份里的
 *
 * 返回一份如实的结果报告，供界面原样转述给用户。
 */
export async function applyImport(parsed, mode, options = {}) {
  if (!parsed || !parsed.ok) throw new Error('备份内容没有通过校验，不能导入。');

  const report = {
    mode,
    writtenEntries: 0,
    keptEntries: 0,
    writtenPhotos: 0,
    failedPhotos: [],          // 写不进去的照片
    removedRefs: [],           // 因为照片没恢复成，被清理掉的引用
    emptyPhotoEntries: [],     // 照片全没了、但文字保留下来的记录
    thumbFailures: 0,          // 缩略图没能重新生成（会退回大图，不影响使用）
    cleanedOrphans: 0,
    quota: false,
    verify: null
  };

  /* ---------- ① 先写照片 ---------- */

  const prepared = [];

  for (let i = 0; i < parsed.photos.length; i += 1) {
    const item = parsed.photos[i];

    if (options.onProgress) options.onProgress('photos', i + 1, parsed.photos.length);

    const bytes = base64ToBytes(item.data);
    if (!bytes || !bytes.byteLength) {
      report.failedPhotos.push({ id: item.id, reason: '照片数据损坏' });
      continue;
    }

    let thumbBytes = null;
    let mime = item.mime || 'image/jpeg';
    let width = item.width || 0;
    let height = item.height || 0;

    try {
      // 缩略图在这里重新生成（备份里不带缩略图）
      const made = await prepareImage(new Blob([bytes], { type: mime }), { thumbOnly: true });
      thumbBytes = made.thumbBytes;
      mime = made.mime || mime;
      if (!width || !height) { width = made.width; height = made.height; }
    } catch (err) {
      // 生成缩略图失败：再确认一次"浏览器到底能不能解开这张图"。
      // 解不开就不入库 —— 绝不允许"存进去了但显示不出来"。
      let displayable = false;
      try {
        const bitmap = await createImageBitmap(blob);
        displayable = !!bitmap;
        if (bitmap && bitmap.close) bitmap.close();
      } catch (err2) {
        displayable = false;
      }

      if (!displayable) {
        report.failedPhotos.push({ id: item.id, reason: '照片数据解不开' });
        continue;
      }

      // 能解开、只是缩略图没做出来 → 仍然入库（显示时会退回大图）
      report.thumbFailures += 1;
    }

    prepared.push({
      id: item.id,
      entryId: item.entryId || '',
      mime,
      width,
      height,
      thumbBytes,
      fullBytes: bytes,
      fullSize: bytes.byteLength,
      thumbSize: thumbBytes ? thumbBytes.byteLength : 0,
      createdAt: item.createdAt || Date.now()
    });
  }

  const saved = await savePhotos(prepared, { batchSize: 5 });
  report.writtenPhotos = saved.ok.size;
  report.quota = saved.quota;
  saved.failed.forEach((f) => report.failedPhotos.push({ id: f.id, reason: saved.quota ? '空间不足' : '写入失败' }));

  /* ---------- ② 清洗引用：只保留确实存在的照片 ---------- */

  const existingIds = new Set(await listPhotoIds());

  const cleaned = parsed.entries.map((entry) => {
    if (!Array.isArray(entry.photos) || entry.photos.length === 0) return entry;

    let removed = 0;
    const kept = [];

    entry.photos.forEach((photo) => {
      if (!photo.photoId) { kept.push(photo); return; }                       // 静态引用，保留
      if (saved.ok.has(photo.photoId)) { kept.push(photo); return; }          // 本次写成功
      if (existingIds.has(photo.photoId)) { kept.push(photo); return; }       // 库里本来就有
      removed += 1;                                                          // 否则：拿掉这个失效引用
    });

    if (removed > 0) {
      report.removedRefs.push({ id: entry.id, title: entry.title, removed });
      if (kept.length === 0) report.emptyPhotoEntries.push({ id: entry.id, title: entry.title });
    }

    return Object.assign({}, entry, { photos: kept });
  });

  /* ---------- ③ 最后写记录 ---------- */

  if (mode === 'replace') {
    report.writtenEntries = await replaceAllEntries(cleaned);
  } else {
    const current = await listEntries();
    const byId = new Map(current.map((e) => [e.id, e]));
    const winners = [];

    cleaned.forEach((item) => {
      const old = byId.get(item.id);

      if (!old) {
        winners.push(item);
        report.writtenEntries += 1;
        return;
      }

      if ((Number(item.updatedAt) || 0) > (Number(old.updatedAt) || 0)) {
        winners.push(item);
        report.writtenEntries += 1;
      } else {
        report.keptEntries += 1;
      }
    });

    if (winners.length) await putEntries(winners);
  }

  /* ---------- ④ 覆盖模式：清掉没人引用的照片 ---------- */

  if (mode === 'replace') {
    const referenced = new Set();
    cleaned.forEach((entry) => (entry.photos || []).forEach((p) => { if (p.photoId) referenced.add(p.photoId); }));

    const allIds = await listPhotoIds();
    const orphans = allIds.filter((id) => !referenced.has(id));

    if (orphans.length) {
      await deletePhotos(orphans);
      report.cleanedOrphans = orphans.length;
    }
  }

  await setMeta('lastImportAt', Date.now());

  /* ---------- ⑤ 收尾校验：确认没有失效引用 ---------- */

  report.verify = await verifyReferences();

  return report;
}

/**
 * 校验：检查所有记录引用的照片是不是都真的存在。
 * 期望 dangling 为空数组。
 */
export async function verifyReferences() {
  const entries = await listEntries();
  const ids = new Set(await listPhotoIds());
  const dangling = [];

  entries.forEach((entry) => {
    (entry.photos || []).forEach((photo) => {
      if (photo.photoId && !ids.has(photo.photoId)) {
        dangling.push({ entryId: entry.id, title: entry.title, photoId: photo.photoId });
      }
    });
  });

  return { entries: entries.length, photos: ids.size, dangling };
}

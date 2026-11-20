/* ==========================================================================
   media.js —— 图片地址的生命周期管理 + 记录里的照片解析
   --------------------------------------------------------------------------
   两件事：

   ① 临时地址池
      浏览器里的图片二进制要显示出来，必须先变成临时地址（objectURL）。
      这个地址不会自己回收 —— 不手动 revoke，翻的相册越多越占内存；
      释放得太早，图片又会突然变空白。
      所以统一在这里"建池 + 切页时整体释放"。

   ② 把记录里的照片解析成能直接渲染的样子
      页面（views.js）只读 photo.src 和 photo.caption。
      这里负责把两种照片都变成 src：
        · 静态引用（assets/xxx.svg，示例数据）→ 路径直接用
        · 上传的照片（photoId）             → 从数据库取字节，生成临时地址
      所以 views.js 的模板和样式完全不需要为照片改动。

   两种尺寸：
      mode: 'thumb' → 列表页的封面用（小、快）
      mode: 'full'  → 详情页、灯箱、表单用（清晰）
      缩略图缺失时会自动退回大图，保证不会出现空白。
   ========================================================================== */

import { getPhoto, getPhotoFull } from './store.js';

/** 照片数据缺失（图片被删了但记录还引用着）时的兜底图 */
const FALLBACK_SRC = 'assets/placeholder-01.svg';

/** key → objectURL */
const pool = new Map();

/** photoId → { width, height }（照片尺寸，首页判断构图时要用） */
const dims = new Map();

/* ==========================================================================
   临时地址池
   ========================================================================== */

/**
 * 把一个二进制图片变成临时地址；同一个 key 重复调用会复用，不会重复创建。
 */
export function objectUrlFor(key, blob) {
  if (!blob) return null;

  const cached = pool.get(key);
  if (cached) return cached;

  const url = URL.createObjectURL(blob);
  pool.set(key, url);
  return url;
}

/** 释放池里所有临时地址。切换页面之前调用。 */
export function releaseAll() {
  pool.forEach((url) => {
    try { URL.revokeObjectURL(url); } catch (err) { /* 已经失效就算了 */ }
  });
  pool.clear();
  dims.clear();
}

/** 池里现在有几个地址（自检用） */
export function poolSize() {
  return pool.size;
}

/* ==========================================================================
   解析：把 photoId 变成 src
   ========================================================================== */

function blobOf(bytes, mime) {
  if (!bytes) return null;
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}

/** 取一张照片的临时地址与尺寸；读不到就返回 null（调用方会用兜底图） */
async function infoFor(photoId, mode) {
  const key = `${photoId}:${mode}`;
  const cached = pool.get(key);
  if (cached) return { url: cached, width: dims.get(photoId) ? dims.get(photoId).width : 0, height: dims.get(photoId) ? dims.get(photoId).height : 0 };

  const meta = await getPhoto(photoId);
  if (!meta) return null;

  if (meta.width || meta.height) dims.set(photoId, { width: meta.width || 0, height: meta.height || 0 });

  if (mode === 'thumb') {
    // 缩略图缺失（例如从备份恢复时没能重新生成）→ 退回大图，保证能看见
    if (meta.thumbBytes) {
      const blob = blobOf(meta.thumbBytes, meta.mime);
      if (blob) return { url: objectUrlFor(key, blob), width: meta.width || 0, height: meta.height || 0 };
    }
    const bytes = await getPhotoFull(photoId);
    return { url: objectUrlFor(key, blobOf(bytes, meta.mime)), width: meta.width || 0, height: meta.height || 0 };
  }

  const bytes = await getPhotoFull(photoId);

  // 大图丢了但缩略图还在 → 至少能显示缩略图
  if (!bytes) {
    return { url: objectUrlFor(key, blobOf(meta.thumbBytes, meta.mime)), width: meta.width || 0, height: meta.height || 0 };
  }

  return { url: objectUrlFor(key, blobOf(bytes, meta.mime)), width: meta.width || 0, height: meta.height || 0 };
}

/** 一次性把若干 photoId 解析好（去重、逐个读，逐个读更稳，不会同时开一堆事务） */
async function resolveIdMap(ids, mode) {
  const map = new Map();
  const unique = Array.from(new Set(ids.filter(Boolean)));

  for (let i = 0; i < unique.length; i++) {
    const id = unique[i];
    try {
      const info = await infoFor(id, mode);
      if (info && info.url) map.set(id, info);
    } catch (err) {
      console.warn('[Birds Of A Feather] 照片读取失败：', id, err);
    }
  }

  return map;
}

/** 把一条记录的照片补上 src（顺便把宽高带出来，首页判断构图要用） */
function fillEntry(entry, map) {
  if (!Array.isArray(entry.photos) || entry.photos.length === 0) return entry;

  return {
    ...entry,
    photos: entry.photos.map((photo) => {
      if (photo.photoId) {
        const info = map.get(photo.photoId);

        return {
          ...photo,
          src: (info && info.url) || FALLBACK_SRC,
          width: photo.width || (info ? info.width : 0),
          height: photo.height || (info ? info.height : 0)
        };
      }

      if (photo.src) return photo;                 // 静态引用，直接用
      return { ...photo, src: FALLBACK_SRC };
    })
  };
}

/* ==========================================================================
   对外接口
   ========================================================================== */

/**
 * 解析一批记录。
 * options.mode        'full'（默认）| 'thumb'
 * options.coversOnly  true 时只解析每条的封面（列表页用，避免把几百张缩略图全读出来）
 */
export async function resolveEntries(entries, options = {}) {
  const list = entries || [];
  const mode = options.mode === 'thumb' ? 'thumb' : 'full';
  const coversOnly = options.coversOnly === true;

  const ids = [];
  list.forEach((entry) => {
    if (!Array.isArray(entry.photos)) return;

    if (coversOnly) {
      const cover = entry.photos[0];
      if (cover && cover.photoId) ids.push(cover.photoId);
    } else {
      entry.photos.forEach((photo) => { if (photo.photoId) ids.push(photo.photoId); });
    }
  });

  const map = await resolveIdMap(ids, mode);

  // 列表页只需要封面：其它照片保持原样（没有 src），反正模板也不会读
  return list.map((entry) => fillEntry(entry, map));
}

/** 解析单条记录 */
export async function resolveEntry(entry, options = {}) {
  if (!entry) return entry;
  const list = await resolveEntries([entry], options);
  return list[0];
}

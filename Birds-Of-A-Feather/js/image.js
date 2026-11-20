/* ==========================================================================
   image.js —— 图片处理：解码、压缩、生成缩略图
   --------------------------------------------------------------------------
   纯图片处理，不碰界面、不碰数据库。被两处使用：
     · 表单里用户选图时（photoEdit.js）
     · 从备份恢复时重新生成缩略图（backup.js）

   流程：
     解码（四道尝试）→ 决定输出格式 → 缩到 1600px 存大图
                                      → 缩到 600px 存缩略图

   关于格式的规则（简单、可预测）：
     源是 PNG  → 输出 PNG（保留透明通道，不会被压成黑底）
     其它格式  → 输出 JPEG
     非图片、或浏览器解不开 → 明确报错，绝不"存进去了但打不开"

   关于 HEIC：
     "原样保存"不等于"能显示"，所以这里【没有】原样保存这条路。
     优先尝试转换（包括借 <img> 解码再重绘），三道都失败就拒收并说明原因。
   ========================================================================== */

export const LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,   // 单张原图上限 25MB
  maxPerEntry: 30,                  // 每条回忆最多 30 张
  fullMax: 1600,                    // 大图最长边
  fullQuality: 0.85,                // 大图 JPEG 质量
  thumbMax: 600,                    // 缩略图最长边
  thumbQuality: 0.78,               // 缩略图 JPEG 质量
  keepOriginalBytes: 600 * 1024,    // 够小的 JPEG 直接原样用，不重新编码
  bigFileHint: 3 * 1024 * 1024      // 超过这个体积，卡片上给个"较大"的提示
};

/** 带分类的错误，方便界面给出人话提示 */
function imageError(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

/** 给用户看的错误说明 */
export function friendlyError(err) {
  const kind = (err && err.kind) || '';

  if (kind === 'notImage')    return '这不是图片文件。';
  if (kind === 'tooLarge')    return (err && err.message) || '图片太大了。';
  if (kind === 'decodeFailed') return '这个格式 Safari 解不开（HEIC 常见）。请先在「照片」App 里导出成 JPEG 再上传。';
  if (kind === 'encodeFailed') return '图片处理失败，已跳过。';
  if (kind === 'empty')       return '这张图是空的，读不出内容。';

  return (err && err.message) || '图片处理失败。';
}

export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.indexOf('image/') === 0;
}

export function bytesText(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 输出格式：PNG 保留透明度，其余走 JPEG */
function outputMimeFor(sourceMime) {
  return sourceMime === 'image/png' ? 'image/png' : 'image/jpeg';
}

/** 按最长边算目标尺寸；永不放大 */
function scaleTo(width, height, max) {
  const longest = Math.max(width, height);
  if (longest <= max) return { w: width, h: height, scaled: false };

  const k = max / longest;
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)), scaled: true };
}

/* ==========================================================================
   解码：三道尝试
   ========================================================================== */

/** 第三道：让 <img> 去解，再重绘到画布（Safari 能在 <img> 里渲染 HEIC，这条路能真正转成 JPEG） */
function decodeViaImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      URL.revokeObjectURL(url);

      if (!w || !h) { reject(imageError('empty', '读不出图片尺寸')); return; }

      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve(canvas);                 // 画布本身就是 drawImage 能接受的源
      } catch (err) {
        reject(imageError('decodeFailed', '重绘失败'));
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(imageError('decodeFailed', '图片解不开'));
    };

    img.src = url;
  });
}

/** 解码成"能被 drawImage 使用"的源（ImageBitmap 或 Canvas 都行） */
async function decode(blob) {
  // ① 带方向信息（能一次拿到正确旋转）
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, oriented: true };
  } catch (err) { /* 继续往下试 */ }

  // ② 去掉方向选项再试
  try {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, oriented: false };
  } catch (err) { /* 继续往下试 */ }

  // ③ 交给 <img>（HEIC 通常走这条）
  const canvas = await decodeViaImg(blob);
  return { source: canvas, width: canvas.width, height: canvas.height, oriented: true };
}

/** 画到指定尺寸并导出成新的二进制 */
async function encode(source, w, h, mime, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');

  // JPEG 没有透明通道：先铺白底，否则透明区域会变成黑块
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.drawImage(source, 0, 0, w, h);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw imageError('encodeFailed', '导出图片失败');

  return blob;
}

/* ==========================================================================
   主函数
   ========================================================================== */

/**
 * 把用户选的文件（或从备份恢复的二进制）处理成能入库的两份数据。
 *
 * options.thumbOnly = true  → 只做缩略图（备份恢复时用：大图本来就在文件里了）
 *
 * 返回：
 *   { width, height,           大图尺寸（入库用）
 *     mime, fullBytes, thumbBytes,   入库用的二进制
 *     fullBlob, thumbBlob,           预览用的 Blob（生成临时地址）
 *     note }                         需要提醒用户的一句话（可选）
 */
export async function prepareImage(file, options = {}) {
  const thumbOnly = options.thumbOnly === true;
  const sourceMime = (file && file.type) || '';

  if (!isImageFile(file)) {
    throw imageError('notImage', '这不是图片文件');
  }

  if (file.size > LIMITS.maxFileBytes) {
    throw imageError('tooLarge', `这张图 ${bytesText(file.size)}，超过单张 25MB 的上限`);
  }

  const decoded = await decode(file);
  const { source } = decoded;
  const width = decoded.width;
  const height = decoded.height;

  if (!width || !height) throw imageError('empty', '读不出图片尺寸');

  const mime = outputMimeFor(sourceMime);
  const fullSize = scaleTo(width, height, LIMITS.fullMax);
  const thumbSize = scaleTo(width, height, LIMITS.thumbMax);

  let fullBytes = null;
  let fullBlob = null;
  let note = '';

  if (!thumbOnly) {
    // 够小、没超过 1600px、而且本来就是 JPEG → 原样保留，不重新编码（画质更好、体积更小）
    const canKeepOriginal = mime === 'image/jpeg'
      && !fullSize.scaled
      && file.size <= LIMITS.keepOriginalBytes;

    if (canKeepOriginal) {
      fullBytes = await file.arrayBuffer();
      fullBlob = file.slice(0, file.size, 'image/jpeg');
    } else {
      fullBlob = await encode(source, fullSize.w, fullSize.h, mime, LIMITS.fullQuality);
      fullBytes = await fullBlob.arrayBuffer();
    }

    if (fullBytes.byteLength > LIMITS.bigFileHint) {
      note = mime === 'image/png'
        ? `这张 ${bytesText(fullBytes.byteLength)}，PNG 体积偏大，想省空间可以另存成 JPEG`
        : `这张 ${bytesText(fullBytes.byteLength)}，比较大`;
    }
  }

  const thumbBlob = await encode(source, thumbSize.w, thumbSize.h, mime, LIMITS.thumbQuality);
  const thumbBytes = await thumbBlob.arrayBuffer();

  if (source && typeof source.close === 'function') {
    try { source.close(); } catch (err) { /* 关不掉就算了 */ }
  }

  return {
    width: fullSize.scaled ? fullSize.w : width,
    height: fullSize.scaled ? fullSize.h : height,
    mime,
    fullBytes,
    fullBlob,
    thumbBytes,
    thumbBlob,
    note,
    converted: sourceMime !== mime,                          // 是否做过真正的格式转换（例如 HEIC → JPEG）
    fromBackup: thumbOnly
  };
}

/**
 * 目录里的小图（favicon 那种）不用处理，这里只处理"照片"。
 * 供外部判断某个 mime 是否是我们支持的图片格式。
 */
export function isSupportedMime(mime) {
  if (!mime) return false;
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif']
    .indexOf(mime) >= 0;
}

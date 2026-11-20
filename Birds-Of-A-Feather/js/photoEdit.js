/* ==========================================================================
   photoEdit.js —— 表单里的照片编辑器
   --------------------------------------------------------------------------
   负责：选图、压缩、预览、图注、排序、删除。

   一个重要设计：**选了图先不写数据库**。
     压缩结果先放在内存里（pending），等你点「保存」时才真正入库。
     这样"取消"就是真的什么都没发生，永远不会有孤儿照片。

   照片的身份（photoId）在选图时就生成好，写库时用同一个 id。

   另外，预览用的临时地址借用了 media.js 的地址池 ——
   切页时会被统一释放，不需要这里自己管回收。
   ========================================================================== */

import { escapeHtml } from './views.js';
import { objectUrlFor } from './media.js';
import { prepareImage, friendlyError, bytesText, LIMITS } from './image.js';

/** 本次会话新增、还没入库的照片： photoId → prepareImage 的结果 */
const pending = new Map();

export function isPending(id) {
  return pending.has(id);
}

/** 取走一张待入库的照片（取走后就不再是"待入库"） */
export function takePending(id) {
  const item = pending.get(id);
  pending.delete(id);
  return item;
}

/** 放弃本次会话（取消表单、或切页时调用） */
export function discardSession() {
  pending.clear();
}

export function pendingCount() {
  return pending.size;
}

/** 生成一个照片编号 */
function newPhotoId() {
  const tail = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

  return `ph-${Date.now().toString(36)}-${tail}`;
}

/* ==========================================================================
   渲染
   ========================================================================== */

/** 一张照片卡片 */
export function photoRowHtml({ photoId = '', src = '', caption = '' } = {}) {
  const canZoom = !!src;

  return `
    <figure class="photo-card" data-photo-row data-photo-id="${escapeHtml(photoId)}">
      ${canZoom
        ? `<button type="button" class="photo-card-shot" data-lightbox="0"
                   data-src="${escapeHtml(src)}" data-caption="${escapeHtml(caption)}"
                   aria-label="放大查看这张照片"><img src="${escapeHtml(src)}" alt=""></button>`
        : '<span class="photo-card-shot photo-card-shot--empty" aria-hidden="true"></span>'}

      <span class="photo-cover" data-photo-cover hidden>封面</span>

      <div class="photo-card-tools">
        <button type="button" class="turn-btn" data-photo-left title="前移">←</button>
        <button type="button" class="turn-btn" data-photo-right title="后移">→</button>
        <button type="button" class="turn-btn" data-photo-remove>删除</button>
      </div>

      <input class="field-input photo-caption" data-photo-caption type="text"
             maxlength="40" autocomplete="off" placeholder="图注（可以不填）"
             value="${escapeHtml(caption)}">
    </figure>`;
}

/** 整个照片编辑区 */
export function photoEditorHtml(photos) {
  const list = Array.isArray(photos) ? photos : [];
  const original = list.map((p) => p.photoId).filter(Boolean).join(',');

  return `
    <div class="photo-editor" data-photo-editor>
      <div class="photo-list" data-photo-list>
        ${list.map((p) => photoRowHtml(p)).join('')}
      </div>

      <div class="photo-actions">
        <button type="button" class="btn" data-photo-add>＋ 添加照片</button>
        <span class="photo-status" data-photo-status role="status"></span>
      </div>

      <input type="file" accept="image/*" multiple hidden data-photo-input>

      <!-- 打开表单时，这条记录原本有哪些照片（保存时用来判断哪些被删掉了） -->
      <input type="hidden" name="originalPhotoIds" value="${escapeHtml(original)}">
    </div>`;
}

/* ==========================================================================
   读值
   ========================================================================== */

/**
 * 按页面上的顺序读出照片列表（顺序 = 存储顺序，第 0 张就是封面）。
 * 上传的照片给 photoId；示例数据那种静态引用给 src。
 */
export function photoRowsFrom(form) {
  const rows = Array.from(form.querySelectorAll('[data-photo-row]'));

  return rows.map((row) => {
    const photoId = row.dataset.photoId || '';
    const captionBox = row.querySelector('[data-photo-caption]');
    const caption = String(captionBox ? captionBox.value : '').trim();

    if (photoId) return { photoId, caption };            // 上传的照片

    const img = row.querySelector('img');                 // 静态引用（示例数据）
    const src = img ? (img.getAttribute('src') || '') : '';
    return { src, caption };
  }).filter((item) => item.photoId || item.src);
}

/** 打开表单时已有的照片编号（用来判断哪些被用户删掉了） */
export function originalPhotoIdsFrom(form) {
  const box = form.querySelector('[name="originalPhotoIds"]');
  const raw = box ? String(box.value || '') : '';

  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/* ==========================================================================
   排序 / 状态同步
   ========================================================================== */

/** 重排封面标记、灯箱编号、按钮可用状态 */
export function syncPhotoRows(editor) {
  if (!editor) return;

  const rows = Array.from(editor.querySelectorAll('[data-photo-row]'));

  rows.forEach((row, index) => {
    const shot = row.querySelector('[data-lightbox]');
    const cover = row.querySelector('[data-photo-cover]');

    // 灯箱按 DOM 顺序取图，所以这里的编号必须跟着顺序走
    if (shot) shot.dataset.lightbox = String(index);

    if (cover) cover.hidden = index !== 0;               // 只有第一张是封面

    const left = row.querySelector('[data-photo-left]');
    const right = row.querySelector('[data-photo-right]');

    if (left) left.disabled = index === 0;
    if (right) right.disabled = index === rows.length - 1;
  });
}

/** 图注改动时，同步给灯箱用（点开大图时显示的是最新的图注） */
export function syncCaption(row) {
  if (!row) return;

  const shot = row.querySelector('[data-lightbox]');
  const box = row.querySelector('[data-photo-caption]');

  if (shot && box) shot.dataset.caption = box.value;
}

/* ==========================================================================
   选图 → 压缩 → 上屏
   ========================================================================== */

function setStatus(editor, text) {
  const box = editor.querySelector('[data-photo-status]');
  if (box) box.textContent = text || '';
}

/**
 * 处理用户选的一批文件。
 * 逐张压缩，成功后立刻上屏；失败的收集起来，最后一次性告诉用户原因。
 */
export async function handlePhotoFiles(input) {
  const editor = input.closest('[data-photo-editor]');
  if (!editor) return;

  const list = editor.querySelector('[data-photo-list]');
  const files = Array.from(input.files || []);
  input.value = '';                       // 允许连续选同一批文件
  if (!files.length) return;

  const current = list.querySelectorAll('[data-photo-row]').length;
  const room = LIMITS.maxPerEntry - current;

  if (room <= 0) {
    setStatus(editor, `最多 ${LIMITS.maxPerEntry} 张，已经满了`);
    return;
  }

  const take = files.slice(0, room);
  const overflow = files.length - take.length;
  const problems = [];
  let added = 0;

  for (let i = 0; i < take.length; i++) {
    setStatus(editor, `正在处理 ${i + 1} / ${take.length}…`);

    try {
      const prepared = await prepareImage(take[i]);
      const id = newPhotoId();

      pending.set(id, prepared);

      // 预览用大图（这样在表单里点开放大看到的是清晰的原尺寸，而不是缩略图）
      const previewUrl = objectUrlFor('preview:' + id, prepared.fullBlob || prepared.thumbBlob);

      list.insertAdjacentHTML('beforeend', photoRowHtml({ photoId: id, src: previewUrl, caption: '' }));
      added += 1;

      if (prepared.note) problems.push(`${take[i].name || '这张图'}：${prepared.note}`);
    } catch (err) {
      problems.push(`${take[i].name || '这张图'}：${friendlyError(err)}`);
    }

    syncPhotoRows(editor);
  }

  const parts = [];
  if (added) parts.push(`已添加 ${added} 张`);
  if (overflow > 0) parts.push(`超出上限，还有 ${overflow} 张没处理`);
  if (problems.length) parts.push(problems.join('；'));

  setStatus(editor, parts.join('　') || '没有可添加的照片');

  return { added, problems };
}

/* ==========================================================================
   供 app.js 在保存时调用
   ========================================================================== */

/**
 * 组装出真正要写进"大图/缩略图"两张表的数据。
 * 只有本次会话新增的照片需要写；已经在库里的不用重写。
 */
export function pendingRecordsFor(photoIds, entryId) {
  const list = [];

  photoIds.forEach((id) => {
    const item = pending.get(id);
    if (!item) return;                    // 已经在库里的，跳过

    list.push({
      id,
      entryId,
      mime: item.mime,
      width: item.width,
      height: item.height,
      thumbBytes: item.thumbBytes,
      fullBytes: item.fullBytes
    });
  });

  return list;
}

/** 写库成功后，把已经落地的照片从内存里清掉 */
export function forget(photoIds) {
  photoIds.forEach((id) => pending.delete(id));
}

'use strict';

const { PDFDocument } = require('pdf-lib');
const {
  loadSourcePdf,
  resolveImpositionPlan,
  effectivePageSize,
  computePanelSize,
  resolveSheetLayout,
  attachPlanLayoutInfo,
  prepareRenderContext,
  renderSelectedSheets,
} = require('./impose');

/**
 * 缺页补印（reprint damaged sheets）。
 *
 * 印刷后发现部分原稿页受损时，按受损原稿页码（如 "2,5-7"）从原拼版方案中
 * 反查它们所在的印张：
 *   - 每张纸正背两面共四个槽位（正面左/右、背面左/右），任一槽位命中受损页
 *     即补印整张纸；同一张纸命中多个页码只补印一次；
 *   - 按原印张顺序（整册：纸张序号；分册：帖号 → 帖内张号）成对抽取正背面，
 *     输出页序与完整拼版完全一致；
 *   - 分册模式下逐帖累计输出页偏移（每纸占 2 个输出页），标注各帖命中张在
 *     完整拼版 PDF 中的输出位置；
 *   - 版面尺寸、源页 1:1 定位与印张定位标记与完整拼版完全一致（复用同一套
 *     渲染逻辑）。
 */

/**
 * 输入类错误：空输入、格式错误或越界页码。服务端据此返回 400。
 */
class ReprintInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReprintInputError';
    this.code = 'REPRINT_INPUT_INVALID';
  }
}

/**
 * 解析受损原稿页码输入，支持逗号/分号/空白分隔的单页与 a-b 区间
 * （如 "2,5-7"、"1、4~6"）。页码自动去重并按升序返回。
 *
 * @param {*} raw 原始输入（通常为字符串，也接受数字）
 * @returns {{ pages: number[], tokens: string[] }}
 *          pages 为去重升序后的 1 基页号；tokens 为实际解析到的片段
 * @throws {ReprintInputError} 空输入、格式错误、区间反向/长度非法
 */
function parseDamagedPages(raw) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new ReprintInputError('请输入受损的原稿页码（正整数或 a-b 区间，如 2,5-7）');
    }
    return { pages: [raw], tokens: [String(raw)] };
  }
  if (raw === undefined || raw === null || typeof raw !== 'string') {
    throw new ReprintInputError('请输入受损的原稿页码（正整数或 a-b 区间，如 2,5-7）');
  }
  const text = raw.trim();
  if (!text) {
    throw new ReprintInputError('请先输入受损的原稿页码（如 2,5-7），再生成补印 PDF');
  }

  const pages = new Set();
  const tokens = [];
  // 允许逗号（中英）、分号、空白、顿号作为条目分隔；- － – — ~ ～ 至 作为区间连接。
  // 先压缩「数字-连接符-数字」两侧的空白（如 "4 至 6"、"5 - 7"），避免区间被空格拆散；
  // 要求连接符两侧都是数字，故 "1--2" 之类不会被误规范化。
  const normalized = text.replace(
    /(\d)\s*(?:-|－|–|—|~|～|至)\s*(?=\d)/g,
    (segment) => segment.replace(/\s+/g, ''),
  );
  for (const token of normalized.split(/[,，;；\s、]+/)) {
    if (!token) continue;
    tokens.push(token);
    const rangeMatch = token.match(/^(\d+)(?:-|－|–|—|~|～|至)(\d+)$/);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (from > to) {
        throw new ReprintInputError(`页码区间 ${from}-${to} 不合法：起始页不能大于结束页`);
      }
      if (to - from + 1 > 100000) {
        throw new ReprintInputError(`页码区间 ${from}-${to} 过大，请拆分为更小的区间`);
      }
      for (let p = from; p <= to; p += 1) pages.add(p);
    } else if (/^\d+$/.test(token)) {
      pages.add(Number(token));
    } else {
      throw new ReprintInputError(
        `「${token}」不是合法页码：请输入正整数或 a-b 区间（如 2,5-7）`,
      );
    }
  }
  if (pages.size === 0) {
    throw new ReprintInputError('请先输入受损的原稿页码（如 2,5-7），再生成补印 PDF');
  }
  // 页码从 1 开始：0 及以下属于格式错误（上界越界需结合实际 PDF 页数，在 buildReprintPdf 校验）
  if ([...pages].some((p) => p < 1)) {
    throw new ReprintInputError('原稿页码从 1 开始，请输入不小于 1 的正整数页码');
  }
  return { pages: [...pages].sort((a, b) => a - b), tokens };
}

const SLOTS = [
  { side: 'front', pos: 'left' },
  { side: 'front', pos: 'right' },
  { side: 'back', pos: 'left' },
  { side: 'back', pos: 'right' },
];

/**
 * 收集一张纸上命中受损页集合的槽位。
 *
 * @param {object} sheet 页序方案中的一张纸
 * @param {Set<number>} wanted 受损页集合（1 基全局页号）
 * @returns {Array<{ side: string, pos: string, page: number }>}
 */
function collectSheetHits(sheet, wanted) {
  const hits = [];
  for (const { side, pos } of SLOTS) {
    const slot = sheet[side][pos];
    if (!slot.blank && wanted.has(slot.page)) {
      hits.push({ side, pos, page: slot.page });
    }
  }
  return hits;
}

/**
 * 从页序方案中选取需要补印的纸张。
 *
 * 遍历顺序：
 *   - 整册模式：plan.sheets 顺序（纸张序号 1 起），输出偏移 = 2 × 之前纸张数；
 *   - 分册模式：按帖号顺序遍历各帖的 sheets，逐帖累计输出页偏移。
 * 同一张纸命中多页只选一次；每项记录命中的全部槽位与命中页码（升序）。
 *
 * @param {object} plan buildImpositionPlan / buildSignaturePlan 的结果
 * @param {number[]} wantedPages 受损原稿页码（1 基）
 * @returns {Array<{
 *   signature: number|null, sheetInSignature: number, sheetOrder: number,
 *   frontOutputPage: number, backOutputPage: number, sheet: object,
 *   hitSlots: Array, hitPages: number[]
 * }>}
 */
function selectReprintSheets(plan, wantedPages) {
  const wanted = new Set(wantedPages);
  const items = [];

  if (plan.signatureMode) {
    let globalSheetOrder = 0; // 跨帖累计的印张序号（1 基）
    for (const signature of plan.signatures) {
      let offsetInSignature = 0; // 该帖此前已输出的页数（正面起始的 0 基偏移）
      for (const sheet of signature.sheets) {
        globalSheetOrder += 1;
        const hitSlots = collectSheetHits(sheet, wanted);
        if (hitSlots.length) {
          items.push({
            signature: signature.signature,
            sheetInSignature: sheet.sheet,
            sheetOrder: globalSheetOrder,
            frontOutputPage: offsetInSignature + 1,
            backOutputPage: offsetInSignature + 2,
            sheet,
            hitSlots,
            hitPages: hitSlots.map((h) => h.page).sort((a, b) => a - b),
          });
        }
        offsetInSignature += 2;
      }
    }
  } else {
    plan.sheets.forEach((sheet, index) => {
      const hitSlots = collectSheetHits(sheet, wanted);
      if (hitSlots.length) {
        items.push({
          signature: null,
          sheetInSignature: sheet.sheet,
          sheetOrder: sheet.sheet,
          frontOutputPage: index * 2 + 1,
          backOutputPage: index * 2 + 2,
          sheet,
          hitSlots,
          hitPages: hitSlots.map((h) => h.page).sort((a, b) => a - b),
        });
      }
    });
  }

  return items;
}

/**
 * 生成缺页补印 PDF。
 *
 * 复用与完整拼版完全相同的页序方案、统一面板、印张尺寸与定位标记，只渲染
 * 命中受损页的印张（按原印张顺序成对抽取正背面）。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节（与本次拼版同一份原 PDF）
 * @param {*} damagedPagesInput 受损页码输入（字符串/数字），见 parseDamagedPages
 * @param {{ maxSheetsPerSignature?: number, registrationMarks?: boolean }} [options]
 *        与本次拼版一致的拼版选项
 * @returns {Promise<{
 *   pdfBytes: Uint8Array,
 *   manifest: object,
 *   plan: object,
 *   selected: Array
 * }>}
 * @throws {ReprintInputError} 页码输入为空/格式错误/越界
 * @throws {Error} PDF 损坏或加密（错误信息同完整拼版）
 */
async function buildReprintPdf(sourceBytes, damagedPagesInput, options = {}) {
  // 先加载源 PDF：损坏/加密文件与拼版接口给出同样的错误
  const srcDoc = await loadSourcePdf(sourceBytes);
  const sourceCount = srcDoc.getPageCount();

  const { pages: wantedPages } = parseDamagedPages(damagedPagesInput);

  const outOfRange = wantedPages.filter((p) => p < 1 || p > sourceCount);
  if (outOfRange.length) {
    const shown = outOfRange.slice(0, 5).join('、');
    const more = outOfRange.length > 5 ? ` 等 ${outOfRange.length} 个` : '';
    throw new ReprintInputError(
      `页码 ${shown}${more} 超出原稿范围（原稿共 ${sourceCount} 页，页码为 1～${sourceCount}）`,
    );
  }

  const plan = resolveImpositionPlan(sourceCount, options);

  // 与 imposePdf 完全相同的版面计算：统一面板、印张尺寸、定位标记
  const pageInfos = srcDoc.getPages().map((page) => effectivePageSize(page));
  const panel = computePanelSize(pageInfos);
  const { sheetWidth, sheetHeight, layout, sheetSize } =
    resolveSheetLayout(panel, options.registrationMarks);
  attachPlanLayoutInfo(plan, panel, sheetSize, options.registrationMarks);

  const selected = selectReprintSheets(plan, wantedPages);

  const outDoc = await PDFDocument.create();
  const { embeddedPages } = await prepareRenderContext(outDoc, srcDoc);
  renderSelectedSheets(
    outDoc, selected, sheetWidth, sheetHeight, panel,
    embeddedPages, pageInfos, layout,
  );
  outDoc.setTitle(`缺页补印（受损 ${wantedPages.length} 页 / 补印 ${selected.length} 张纸）`);
  outDoc.setProducer('booklet-imposer (pdf-lib)');

  const pdfBytes = await outDoc.save();

  const manifest = {
    sourceCount,
    requestedPages: wantedPages,
    signatureMode: Boolean(plan.signatureMode),
    signatureCount: plan.signatureMode ? plan.signatureCount : null,
    selectedSheetCount: selected.length,
    requestedPageCount: wantedPages.length,
    sheets: selected.map((item) => ({
      signature: item.signature,
      sheetInSignature: item.sheetInSignature,
      sheetOrder: item.sheetOrder,
      frontOutputPage: item.frontOutputPage,
      backOutputPage: item.backOutputPage,
      hitPages: item.hitPages,
      hitSlots: item.hitSlots,
    })),
  };

  return { pdfBytes, manifest, plan, selected };
}

module.exports = {
  ReprintInputError,
  parseDamagedPages,
  selectReprintSheets,
  buildReprintPdf,
};

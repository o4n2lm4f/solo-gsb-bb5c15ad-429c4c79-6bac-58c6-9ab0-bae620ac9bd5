'use strict';

const assert = require('assert');
const fs = require('fs');
const zlib = require('zlib');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');
const {
  buildImpositionPlan,
  buildSignaturePlan,
  imposePdf,
} = require('../lib/impose');
const {
  parseDamagedPages,
  selectReprintSheets,
  buildReprintPdf,
  ReprintInputError,
} = require('../lib/reprint');

// 读取输出页内容流中的全部 cm 矩阵 [a b c d e f]，用于校验源页定位与完整拼版一致
function extractCmOperators(doc, pageIndex) {
  const node = doc.getPage(pageIndex).node;
  const contents = node.get(PDFName.of('Contents'));
  const refs = typeof contents.asArray === 'function' ? contents.asArray() : [contents];
  const content = refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    return zlib.inflateSync(Buffer.from(stream.getContents())).toString('latin1');
  }).join('\n');
  const ops = [];
  const re = /(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+cm/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ops.push(m.slice(1, 7).map(Number));
  }
  return ops;
}

// ---------- 1. 页码输入解析 ----------

// 正常：单页、区间、混合、去重排序、中文逗号/顿号/全角横线/波浪线/至
assert.deepStrictEqual(parseDamagedPages('2').pages, [2]);
assert.deepStrictEqual(parseDamagedPages('2,5-7').pages, [2, 5, 6, 7]);
assert.deepStrictEqual(parseDamagedPages(' 3 , 1 , 3 ').pages, [1, 3]);
assert.deepStrictEqual(parseDamagedPages('5-5, 2、1；4 至 6').pages, [1, 2, 4, 5, 6]);
assert.deepStrictEqual(parseDamagedPages('1~3，7－8').pages, [1, 2, 3, 7, 8]);
assert.deepStrictEqual(parseDamagedPages(4).pages, [4]);
assert.ok(parseDamagedPages('2,5-7').tokens.includes('5-7'));

// 非法输入：空、纯分隔符、非数字、区间反向、小数
for (const bad of ['', '   ', ',,', 'abc', '1-a', '3-2', '1.5', '0', '-', '1--2']) {
  assert.throws(() => parseDamagedPages(bad), ReprintInputError, `应拒绝 ${JSON.stringify(bad)}`);
}
for (const bad of [null, undefined, 0, -1, 1.5, {}, []]) {
  assert.throws(() => parseDamagedPages(bad), ReprintInputError, `应拒绝 ${JSON.stringify(bad)}`);
}
const reversed = (() => {
  try {
    parseDamagedPages('9-3');
    return false;
  } catch (err) {
    return err instanceof ReprintInputError && /起始页不能大于结束页/.test(err.message);
  }
})();
assert.ok(reversed, '区间反向应给出明确错误');

const badToken = (() => {
  try {
    parseDamagedPages('2,abc');
    return false;
  } catch (err) {
    return /abc/.test(err.message) && /合法页码/.test(err.message);
  }
})();
assert.ok(badToken, '格式错误应指出具体片段');

console.log('✅ 缺页补印：页码输入解析通过（单页/区间/去重/空输入与格式错误提示）');

// ---------- 2. 命中印张选择（整册） ----------
// 8 页：纸1 F[8|1] B[2|7]；纸2 F[6|3] B[4|5]
const p8 = buildImpositionPlan(8);

// 单页命中：第 2 页在第 1 张纸背面左槽
let sel = selectReprintSheets(p8, [2]);
assert.strictEqual(sel.length, 1);
assert.strictEqual(sel[0].signature, null);
assert.strictEqual(sel[0].sheetInSignature, 1);
assert.strictEqual(sel[0].frontOutputPage, 1);
assert.strictEqual(sel[0].backOutputPage, 2);
assert.deepStrictEqual(sel[0].hitPages, [2]);
assert.deepStrictEqual(sel[0].hitSlots, [{ side: 'back', pos: 'left', page: 2 }]);

// 同一印张命中多页只补印一次：2,7,8,1 都在第 1 张纸上
sel = selectReprintSheets(p8, [2, 7, 8, 1]);
assert.strictEqual(sel.length, 1, '同一印张命中多页只补印一次');
assert.strictEqual(sel[0].sheetInSignature, 1);
assert.deepStrictEqual(sel[0].hitPages, [1, 2, 7, 8]);
// 槽位按 正面左、正面右、背面左、背面右 顺序列出
assert.deepStrictEqual(sel[0].hitSlots.map((h) => h.side + h.pos), [
  'frontleft', 'frontright', 'backleft', 'backright',
]);

// 跨印张：第 2 页（纸1）、第 5 页（纸2 背面右槽）-> 按原印张顺序返回 2 张
sel = selectReprintSheets(p8, [5, 2]);
assert.deepStrictEqual(sel.map((s) => s.sheetInSignature), [1, 2]);
assert.deepStrictEqual(sel[1].hitPages, [5]);
assert.deepStrictEqual(sel[1].hitSlots, [{ side: 'back', pos: 'right', page: 5 }]);
// 第二张纸在完整拼版 PDF 中位于输出第 3、4 页
assert.strictEqual(sel[1].frontOutputPage, 3);
assert.strictEqual(sel[1].backOutputPage, 4);

// 无命中（仅补白槽位，不可作为输入；这里用不会出现的选择逻辑验证空集）
assert.deepStrictEqual(selectReprintSheets(p8, []), []);

// 任意合法页码（1..sourceCount）在方案中恰好出现一次，故补印至少命中 1 张纸；
// 全部页码一起请求时选中全部纸张，且每槽位非空白页恰好各命中一次
for (const n of [1, 3, 4, 5, 8, 12, 13]) {
  const planAll = buildImpositionPlan(n);
  for (let p = 1; p <= n; p += 1) {
    assert.strictEqual(selectReprintSheets(planAll, [p]).length >= 1, true, `n=${n} 页 ${p} 应命中至少 1 张`);
  }
  const all = selectReprintSheets(planAll, Array.from({ length: n }, (_, i) => i + 1));
  assert.strictEqual(all.length, planAll.sheets.length, `n=${n} 全部页应选中全部纸`);
  const hitCount = all.reduce((sum, s) => sum + s.hitSlots.length, 0);
  assert.strictEqual(hitCount, n, `n=${n} 非空白槽位应各命中一次`);
}

console.log('✅ 缺页补印：整册命中选择通过（四槽定位/同张去重/原序抽取/输出页偏移）');

// ---------- 3. 命中印张选择（分册签帖 + 各帖输出页偏移累计） ----------
// 13 页、每帖 2 张（容量 8 页）：帖1 = 页 1~8（2 张），帖2 = 页 9~13 补 3 白（2 张）
const sig13 = buildSignaturePlan(13, 2);

// 第 1 页：第 1 帖帖内第 1 张正面右槽，帖内输出页 1/2
sel = selectReprintSheets(sig13, [1]);
assert.strictEqual(sel.length, 1);
assert.strictEqual(sel[0].signature, 1);
assert.strictEqual(sel[0].sheetInSignature, 1);
assert.strictEqual(sel[0].frontOutputPage, 1);
assert.strictEqual(sel[0].backOutputPage, 2);
assert.deepStrictEqual(sel[0].hitSlots, [{ side: 'front', pos: 'right', page: 1 }]);

// 第 9 页：第 2 帖帖内第 1 张正面右槽；帖内偏移重新从 1/2 开始
sel = selectReprintSheets(sig13, [9]);
assert.strictEqual(sel.length, 1);
assert.strictEqual(sel[0].signature, 2);
assert.strictEqual(sel[0].sheetInSignature, 1);
assert.strictEqual(sel[0].frontOutputPage, 1);
assert.strictEqual(sel[0].backOutputPage, 2);

// 第 13 页：第 2 帖帖内第 2 张背面右槽；该帖此前已输出 2 页 -> 输出 3/4
sel = selectReprintSheets(sig13, [13]);
assert.strictEqual(sel[0].signature, 2);
assert.strictEqual(sel[0].sheetInSignature, 2);
assert.strictEqual(sel[0].frontOutputPage, 3);
assert.strictEqual(sel[0].backOutputPage, 4);
assert.deepStrictEqual(sel[0].hitSlots, [{ side: 'back', pos: 'right', page: 13 }]);

// 跨帖命中：页 8（帖1 第1张正面左槽）、页 13（帖2 第2张）-> 按 帖号→帖内张号 排序，
// 全局张序号连续累计（1、4），各帖输出页偏移独立累计
sel = selectReprintSheets(sig13, [13, 8]);
assert.strictEqual(sel.length, 2);
assert.deepStrictEqual(sel.map((s) => [s.signature, s.sheetInSignature, s.sheetOrder]),
  [[1, 1, 1], [2, 2, 4]]);
assert.deepStrictEqual(sel.map((s) => [s.frontOutputPage, s.backOutputPage]), [[1, 2], [3, 4]]);

// 同帖同张多页去重：页 9/10/13 分布 -> 帖2 第1张（9、10）、帖2 第2张（13）
sel = selectReprintSheets(sig13, [9, 10, 13]);
assert.strictEqual(sel.length, 2);
assert.deepStrictEqual(sel[0].hitPages, [9, 10]);
assert.deepStrictEqual(sel[1].hitPages, [13]);

// 任意全局页 1..13 在分册方案中都能命中至少 1 张纸；全部页请求时选中全部 4 张纸
for (let p = 1; p <= 13; p += 1) {
  assert.strictEqual(selectReprintSheets(sig13, [p]).length, 1, `页 ${p} 应命中恰好 1 张纸`);
}
const allSig = selectReprintSheets(
  sig13,
  Array.from({ length: 13 }, (_, i) => i + 1),
);
assert.strictEqual(allSig.length, 4, '13 页共 4 张纸，应全部选中');
assert.strictEqual(allSig.reduce((sum, s) => sum + s.hitSlots.length, 0), 13);

console.log('✅ 缺页补印：分册签帖命中选择通过（帖号/帖内张号/各帖输出页偏移累计）');

// ---------- 4. 端到端：生成补印 PDF ----------
(async () => {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  for (let i = 1; i <= 10; i += 1) {
    const page = src.addPage([PAGE_W, PAGE_H]);
    page.drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0) });
  }
  const srcBytes = await src.save();

  // 10 页 -> 补 2 白到 12 -> 3 张纸。页序（公式 frontLeft=12-2i, frontRight=2i+1,
  // backLeft=2i+2, backRight=12-2i-1）：
  //   纸1 F[12白|1] B[2|11白]；纸2 F[10|3] B[4|9]；纸3 F[8|5] B[6|7]
  // 请求 2,5,6,7,9：纸1 命中 2；纸2 命中 9；纸3 命中 5、6、7 -> 三张全中，共 6 输出页
  const { pdfBytes, manifest } = await buildReprintPdf(srcBytes, '2,5-7,9');
  const out = await PDFDocument.load(pdfBytes);
  assert.strictEqual(out.getPageCount(), 6, '3 张补印纸 × 正背两页 -> 6 页');
  assert.strictEqual(manifest.sourceCount, 10);
  assert.strictEqual(manifest.signatureMode, false);
  assert.strictEqual(manifest.selectedSheetCount, 3);
  assert.deepStrictEqual(manifest.requestedPages, [2, 5, 6, 7, 9]);
  assert.deepStrictEqual(manifest.sheets.map((s) => s.sheetInSignature), [1, 2, 3]);
  assert.deepStrictEqual(manifest.sheets[0].hitPages, [2]);
  assert.deepStrictEqual(manifest.sheets[1].hitPages, [9]);
  assert.deepStrictEqual(manifest.sheets[2].hitPages, [5, 6, 7]);
  // 输出页偏移：纸1 -> 1/2，纸2 -> 3/4，纸3 -> 5/6
  assert.deepStrictEqual(
    manifest.sheets.map((s) => [s.frontOutputPage, s.backOutputPage]),
    [[1, 2], [3, 4], [5, 6]],
  );
  // 输出页尺寸与完整拼版完全一致：2 × A4 × A4
  assert.ok(Math.abs(out.getPage(0).getWidth() - PAGE_W * 2) < 0.5);
  assert.ok(Math.abs(out.getPage(0).getHeight() - PAGE_H) < 0.5);

  // 与完整拼版对应页逐页一致：补印第 0..3 页对应完整拼版纸1（输出 0..1）、
  // 纸3（输出 4..5）。对比内容流中的 cm 变换矩阵（源页定位）应完全相同。
  const { pdfBytes: fullBytes } = await imposePdf(srcBytes);
  const full = await PDFDocument.load(fullBytes);
  const reprintToFull = [0, 1, 4, 5];
  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.abs(full.getPage(reprintToFull[i]).getWidth() - out.getPage(i).getWidth()) < 1e-6);
    assert.ok(Math.abs(full.getPage(reprintToFull[i]).getHeight() - out.getPage(i).getHeight()) < 1e-6);
    assert.deepStrictEqual(
      extractCmOperators(out, i),
      extractCmOperators(full, reprintToFull[i]),
      `补印第 ${i + 1} 页的源页定位应与完整拼版第 ${reprintToFull[i] + 1} 页完全一致`,
    );
  }

  fs.writeFileSync('/tmp/out-reprint.pdf', pdfBytes);

  // 越界页码 -> ReprintInputError
  await assert.rejects(
    () => buildReprintPdf(srcBytes, '11'),
    (err) => err instanceof ReprintInputError && /超出原稿范围/.test(err.message) && /10/.test(err.message),
  );
  await assert.rejects(() => buildReprintPdf(srcBytes, '1-20'), /超出原稿范围/);
  await assert.rejects(() => buildReprintPdf(srcBytes, '   '), /输入受损/);

  // 损坏 PDF -> 普通错误（服务端按 422 处理），不是输入错误
  let badPdfErrorKind = 'none';
  try {
    await buildReprintPdf(Buffer.from('%PDF-broken'), '1');
  } catch (err) {
    badPdfErrorKind = err instanceof ReprintInputError ? 'input' : 'process';
  }
  assert.strictEqual(badPdfErrorKind, 'process', '损坏 PDF 应归类为处理错误而非页码输入错误');

  // 分册签帖端到端：13 页每帖 2 张，补印页 1、13 -> 帖1纸1 + 帖2纸2 -> 4 输出页
  const sigSrc = await PDFDocument.create();
  const sigFont = await sigSrc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 13; i += 1) {
    sigSrc.addPage([PAGE_W, PAGE_H]).drawText(`PAGE ${i}`, {
      x: 200, y: 400, size: 40, font: sigFont, color: rgb(0, 0, 0),
    });
  }
  const sigBytes = await sigSrc.save();
  const sigReprint = await buildReprintPdf(sigBytes, '1,13', { maxSheetsPerSignature: 2 });
  assert.strictEqual(sigReprint.manifest.signatureMode, true);
  assert.strictEqual(sigReprint.manifest.signatureCount, 2);
  assert.strictEqual(sigReprint.manifest.selectedSheetCount, 2);
  assert.deepStrictEqual(
    sigReprint.manifest.sheets.map((s) => [s.signature, s.sheetInSignature]),
    [[1, 1], [2, 2]],
  );
  const sigOut = await PDFDocument.load(sigReprint.pdfBytes);
  assert.strictEqual(sigOut.getPageCount(), 4);

  // 定位标记端到端：启用后补印纸尺寸 = 完整拼版印张尺寸（含 8mm 四周边距）
  const MM8_PT = 8 * (72 / 25.4);
  const marked = await buildReprintPdf(srcBytes, '2', { registrationMarks: true });
  const markedOut = await PDFDocument.load(marked.pdfBytes);
  assert.strictEqual(markedOut.getPageCount(), 2, '单张补印纸正背两页');
  assert.ok(Math.abs(markedOut.getPage(0).getWidth() - (PAGE_W * 2 + 2 * MM8_PT)) < 0.5);
  assert.ok(Math.abs(markedOut.getPage(0).getHeight() - (PAGE_H + 2 * MM8_PT)) < 0.5);
  assert.strictEqual(marked.plan.marks.enabled, true);

  fs.writeFileSync('/tmp/out-reprint-signatures.pdf', sigReprint.pdfBytes);
  console.log('✅ 缺页补印：端到端通过（正背成对抽取、原版面尺寸与定位标记、分册帖号/偏移、');
  console.log('   越界页码与空输入明确报错、损坏 PDF 归类处理错误）');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

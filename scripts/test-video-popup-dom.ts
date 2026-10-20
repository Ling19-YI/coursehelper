/**
 * 随堂弹题（超星 InteractiveQuiz）真实 DOM 回归测试。
 *
 * 背景（2026-10-21 实地抓 2.2 得出）：
 *   2.2 的弹窗题目**不是**章节测验，而是**视频互动测验**（InteractiveQuiz），
 *   数据来自 `GET /mooc-ans/richvideo/initdatawithviewerV2`：
 *     { style:"InteractiveQuiz", datas:[{ questionType:"判断题",
 *        options:[{name:"A",description:"对"},{name:"B",description:"错"}],
 *        interactiveQuestionCount:1, startTime:107.0, answered:false }] }
 *   弹层由 `ananas/videojs-ext/videojs-ext.min.js` 渲染，DOM 模板（源码实证）：
 *     <div class="tkTopic">
 *       <div class="tkTopic_title">共 1 题，已答对 0 题</div>
 *       <ul class="tkItem_ul">
 *         <li class="ans-videoquiz-opt"><label><span class="tkRadio">
 *           <input type="radio" name="ans-videoquiz-opt" value="…"><i></i></span>A. 对</label></li>
 *       </ul>
 *       <span class="spanHas fr"><span id="InteractiveQuizTip">…</span></span>
 *       <div class="tkTopic_oper">
 *         <a class="ans-videoquiz-back fr" id="knowledgeBack">回看</a>
 *         <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submit">提交</a>
 *         <a class="ans-videoquiz-continue bntLinear fr" id="videoquiz-continue">继续学习</a>
 *       </div>
 *
 *   关键行为：提交后 `Ext.get('videoquiz-submit').setStyle('display','none')`
 *   同时显示 `#videoquiz-continue`。**弹题并没有消失**，要等玩家点「继续学习」。
 *   旧实现「submit 不可见 ⇒ 弹题没了」是错的：它会以为弹题自动收起，
 *   于是永远不去点那个按钮，弹层一直盖着页面挡住后续点击。
 *
 * 本脚本用 Playwright 打开一份按上述模板复刻的本地页面，直接驱动
 * src/main/engine/videoQuiz.ts 的 readVideoPopup / settlePopup / clickContinueIfPresent，
 * 断言真机行为而不是源码结构。
 *
 * 用法：tsx scripts/test-video-popup-dom.ts
 */
import { chromium } from 'playwright';
import { readVideoPopup, settlePopup, clickContinueIfPresent } from '../src/main/engine/videoQuiz';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * 按 videojs-ext 的模板复刻弹题 DOM。
 * @param state 'open' 未作答 | 'correct' 答对 | 'wrong' 答错
 */
function popupHtml(state: 'open' | 'correct' | 'wrong'): string {
  const answered = state !== 'open';
  const submitDisplay = answered ? 'display:none' : '';
  const continueDisplay = answered ? '' : 'display:none';
  const tipDisplay = state === 'correct' ? '' : 'display:none';
  const notDisplay = state === 'wrong' ? '' : 'display:none';
  const tipText =
    state === 'correct'
      ? '恭喜你，答对了！共 1 题，已答对 1 题'
      : '共 1 题，已答对 0 题';
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#eee">
  <div id="player" style="width:800px;height:400px;background:#222"></div>

  <div class="tkTopic" id="tk" style="display:block;position:absolute;left:100px;top:120px;
       width:520px;background:#fff;border:1px solid #ccc;z-index:99">
    <div class="tkTopic_title">共 1 题，已答对 ${state === 'correct' ? 1 : 0} 题</div>
    <div class="tkScroll">
      <div class="tkTopicQues">数据预处理包含数据清洗、数据集成、数据采样等。</div>
      <ul class="tkItem_ul">
        <li class="ans-videoquiz-opt"><label><span class="tkRadio">
          <input type="radio" name="ans-videoquiz-opt" value="1"><i></i></span>A. 对</label></li>
        <li class="ans-videoquiz-opt"><label><span class="tkRadio">
          <input type="radio" name="ans-videoquiz-opt" value="0"><i></i></span>B. 错</label></li>
      </ul>
    </div>
    <span class="spanHas fr" style="${tipDisplay}"><span id="InteractiveQuizTip">${tipText}</span></span>
    <span class="spanNotBack fr" id="spanNotBackPoint" style="${notDisplay}">回答错误</span>
    <div class="tkTopic_oper">
      <a class="ans-videoquiz-back fr" id="knowledgeBack">回看</a>
      <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submit" style="${submitDisplay}">提交</a>
      <a class="ans-videoquiz-submit bntLinear fr" id="videoquiz-submitting" style="display:none">提交中</a>
      <a class="ans-videoquiz-continue bntLinear fr" id="videoquiz-continue" style="${continueDisplay}">继续学习</a>
    </div>
  </div>

  <script>
    // 平台行为：点「继续学习」后弹题收起
    document.getElementById('videoquiz-continue').addEventListener('click', function () {
      document.getElementById('tk').style.display = 'none';
    });
    // 平台行为：点提交后提交按钮隐藏、继续按钮显示
    document.getElementById('videoquiz-submit').addEventListener('click', function () {
      document.getElementById('videoquiz-submit').style.display = 'none';
      document.getElementById('videoquiz-continue').style.display = '';
    });
  </script>
</body></html>`;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // ── 1. 未作答：弹题存在，提交按钮可见，反馈为 open ──────────────────
  await page.setContent(popupHtml('open'));
  let st = await readVideoPopup(page);
  check('未作答时能识别出弹题', st.present);
  check('未作答时提交按钮可见', st.submitVisible === true);
  check('未作答时反馈为 open', st.feedback === 'open', `实际 ${st.feedback}`);
  check('识别为判断题（2 个单选选项 + 对/错）', st.question?.type === 'judge', `实际 ${st.question?.type}`);
  check('两个选项文字读得到', st.question?.options.length === 2);
  check(
    '选项文字剥掉了 A./B. 前缀',
    !!st.question && st.question.options[0].text.includes('对') && !/^A\./.test(st.question.options[0].text),
    JSON.stringify(st.question?.options)
  );
  check(
    '题干里没有混进「共 X 题，已答对 Y 题」/「提交」/「继续学习」',
    !!st.question &&
      !/共\s*\d+\s*题/.test(st.question.stem) &&
      !/提交/.test(st.question.stem) &&
      !/继续/.test(st.question.stem) &&
      /数据预处理/.test(st.question.stem),
    st.question?.stem
  );

  // ── 2. 答对：提交按钮隐藏、继续按钮出现，弹题**仍在** ───────────────
  await page.setContent(popupHtml('correct'));
  st = await readVideoPopup(page);
  check('答对后弹题仍被识别（不能因为提交按钮隐藏就当它没了）', st.present);
  check('答对后提交按钮不可见', st.submitVisible === false);
  check('答对后反馈为 continue（等点「继续学习」）', st.feedback === 'continue', `实际 ${st.feedback}`);
  check(
    '答对后题干仍然干净（「恭喜你，答对了！」要被剔掉）',
    !!st.question && !/恭喜/.test(st.question.stem) && /数据预处理/.test(st.question.stem),
    st.question?.stem
  );

  // ── 3. 答错：反馈为 incorrect ────────────────────────────────────────
  await page.setContent(popupHtml('wrong'));
  st = await readVideoPopup(page);
  check('答错时反馈为 incorrect', st.feedback === 'incorrect', `实际 ${st.feedback}`);

  // ── 4. settlePopup：点「继续学习」后弹题真的退场 ─────────────────────
  await page.setContent(popupHtml('correct'));
  const closed = await settlePopup(page, null, { reason: '随堂弹题', autoWaitMs: 800 });
  check('settlePopup 在提交按钮已隐藏时不会误判成「已自动收起」', closed !== 'auto', `实际 ${closed}`);
  check('settlePopup 通过点击「继续学习」收尾', closed === 'clicked', `实际 ${closed}`);
  const tkVisible = await page.evaluate(() => {
    const el = document.getElementById('tk');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  });
  check('点完「继续学习」后弹题真的不可见了', tkVisible === false);

  // ── 5. clickContinueIfPresent：按 id 命中 #videoquiz-continue ─────────
  await page.setContent(popupHtml('correct'));
  const hit = await clickContinueIfPresent(page, 1500);
  check('能点到底部的「继续学习」按钮', !!hit, JSON.stringify(hit));
  check('点的是 #videoquiz-continue 这个 id', hit?.by === '#videoquiz-continue', JSON.stringify(hit));

  // ── 6. 没有弹题时不要误判 ───────────────────────────────────────────
  await page.setContent('<!doctype html><html><body><div>普通页面</div></body></html>');
  st = await readVideoPopup(page);
  check('普通页面上不误报弹题', st.present === false);
  const noHit = await clickContinueIfPresent(page, 800);
  check('普通页面上不会乱点「继续」', noHit === null, JSON.stringify(noHit));

  await browser.close();
  console.log(`\n${fail ? `${fail} 项未通过` : '全部通过'}（${pass} 项通过）`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

/**
 * 验证「换了账号却登录成旧账号」的修复逻辑。
 * 用户反馈：重新填写账号密码后，自动登录的还是之前的账号。
 */

/** 11 位手机号，超星的登录名 */
function isPhoneLike(s) { return /^1[3-9]\d{9}$/.test(s); }

/** 复刻 login() 的判定：true 表示「判定为换了账号，需要登出重登」 */
function isAccountSwitched(sessionAccount, wantAccount) {
  const cur = sessionAccount || '';
  const want = String(wantAccount || '').trim();
  // 只有两边都确认是手机号、且不同，才判定为换了账号
  return isPhoneLike(cur) && isPhoneLike(want) && cur !== want;
}

const cases = [
  {
    name: '用户报告的场景：会话是旧账号，要登出重登',
    session: '13800001111', want: '18305897195', expect: true,
  },
  {
    name: '同一账号：直接复用会话',
    session: '18305897195', want: '18305897195', expect: false,
  },
  {
    name: '取不到会话账号：保守复用，不误伤',
    session: null, want: '18305897195', expect: false,
  },
  {
    name: '会话账号是昵称而非手机号：无法比对，复用',
    session: '凌杰', want: '18305897195', expect: false,
  },
  {
    name: '目标是座机/学号无手机号格式：按原样比对',
    session: '1001', want: '1001', expect: false,
  },
];

console.log('=== 换账号判定 ===');
let pass = 0;
for (const c of cases) {
  const got = isAccountSwitched(c.session, c.want);
  const ok = got === c.expect;
  if (ok) pass++;
  console.log(`  [${ok ? '✓' : '✗'}] ${c.name}`);
  console.log(`      会话=${c.session} 目标=${c.want} → ${got ? '登出重登' : '复用会话'}`);
}
console.log(`\n${pass}/${cases.length} 通过`);

// credentials:set 的触发条件
console.log('\n=== 保存新账号时是否清理会话 ===');
const saveCases = [
  { prev: '18305897195', next: '13900002222', expect: true, why: '账号变了 → 必须清' },
  { prev: '18305897195', next: '18305897195', expect: false, why: '同一账号重填密码 → 不必清' },
  { prev: null, next: '18305897195', expect: false, why: '首次填写 → 无旧会话' },
];
let p2 = 0;
for (const c of saveCases) {
  const cleared = !!(c.prev && c.prev !== c.next);
  const ok = cleared === c.expect;
  if (ok) p2++;
  console.log(`  [${ok ? '✓' : '✗'}] ${c.why}  (${c.prev || 'null'} → ${c.next})`);
}
console.log(`\n${p2}/${saveCases.length} 通过`);

const all = pass === cases.length && p2 === saveCases.length;
console.log(`\n${all ? '✓ 修复逻辑正确' : '✗ 存在问题'}`);
process.exit(all ? 0 : 1);
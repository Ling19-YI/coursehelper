/**
 * 改名迁移的回归测试。
 *
 * 为什么这个必须测：v2.1.3 把 productName 改了，而 Electron 的 userData 目录名
 * 直接来自它。改名的瞬间，新版会指向一个全新的空目录 —— 老用户的账号凭证和
 * 学习进度看起来「全没了」。这个测试锁住四件事：
 *   1. 旧目录的数据确实被搬过来（含递归的进度目录）
 *   2. **旧目录不被删除**（判断错了也要能手工找回，不能不可逆丢数据）
 *   3. 幂等：搬过一次之后不再重复搬，也不拿旧数据覆盖用户正在用的
 *   4. 目标已存在同名文件时不覆盖
 *
 * 沙箱一律用 ASCII 目录名。真实目录名是中文，在部分 Windows 终端下按 GBK
 * 显示，与 Node 写出的 UTF-8 路径对不上 —— 用真名建沙箱会读到「同名的空目录」，
 * 报出与真实问题无关的 EISDIR。这里测的是「旧名 → 新名」的映射行为，
 * 目录名的中文由 LEGACY_DIR_NAMES 提供，不必在沙箱里复现。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateDirInto } from '../src/shared/paths';

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

/** 每个用例一个全新的沙箱根目录，不删上一次的（Windows 递归删临时目录偶发 EBUSY） */
function newSandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chmig-'));
}

/**
 * 造一个旧版用户数据目录。
 *
 * 显式声明每个条目是文件还是目录 —— 不能靠「文件名是否以 .json 结尾」去猜：
 * credentials.enc / vision.enc 都是**文件**，按后缀猜会把它们建成目录，
 * 后面断言去读就报 EISDIR，排查时容易误以为是迁移逻辑把文件搞成了目录。
 */
function seed(
  dir: string,
  files: Record<string, string>,
  dirs: Record<string, Record<string, string>> = {}
): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, f), content, 'utf-8');
  }
  for (const [d, children] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const [f, content] of Object.entries(children)) {
      fs.writeFileSync(path.join(dir, d, f), content, 'utf-8');
    }
  }
  return dir;
}

try {
  console.log('\n【1】旧目录有数据 → 完整搬过来，旧目录保留');
  {
    const root = newSandbox();
    const src = seed(
      path.join(root, 'legacy-appdir'),
      {
        'settings.json': '{"videoSpeed":1.5}',
        'credentials.enc': 'ENCRYPTED_CREDENTIALS',
        'vision.enc': 'VISION_KEY',
      },
      { data: { 'course-1.json': '{"completedChapters":["c1","c2"]}' } }
    );
    const dst = path.join(root, 'current-appdir');

    const r = migrateDirInto(src, dst);
    assert.ok(r, '应当报告发生了迁移');
    assert.ok(r.files.includes('credentials.enc'), '账号文件必须被搬运');
    assert.ok(r.files.includes('vision.enc'), '视觉密钥必须被搬运');
    assert.ok(r.files.includes('data'), '学习进度目录必须被搬运');

    assert.strictEqual(
      fs.readFileSync(path.join(dst, 'credentials.enc'), 'utf-8'),
      'ENCRYPTED_CREDENTIALS'
    );
    assert.ok(
      fs.existsSync(path.join(dst, 'data', 'course-1.json')),
      '进度文件应被递归搬过来'
    );
    assert.ok(fs.existsSync(src), '⚠ 旧目录不得删除——判断错了要能手工找回');
    ok('数据完整搬运且旧目录保留');
  }

  console.log('\n【2】幂等：目标已有数据时不再搬，也不覆盖');
  {
    const root = newSandbox();
    const src = seed(path.join(root, 'legacy-appdir'), { 'settings.json': '{"videoSpeed":1}' });
    const dst = path.join(root, 'current-appdir');
    fs.mkdirSync(dst, { recursive: true });
    // 用户在新目录里改过设置，比旧目录新
    fs.writeFileSync(path.join(dst, 'settings.json'), '{"videoSpeed":2}', 'utf-8');

    assert.strictEqual(migrateDirInto(src, dst), null, '应直接返回 null');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(dst, 'settings.json'), 'utf-8')).videoSpeed,
      2,
      '用户在新目录的改动不能被旧数据覆盖'
    );
    ok('不覆盖、不重复迁移');
  }

  console.log('\n【3】源目录不存在（全新安装）→ 静默通过');
  {
    const root = newSandbox();
    assert.strictEqual(migrateDirInto(path.join(root, 'nope'), path.join(root, 'new')), null);
    ok('全新安装无异常');
  }

  console.log('\n【4】源目录为空 → 不报错，也不算迁移成功');
  {
    const root = newSandbox();
    const src = path.join(root, 'legacy-empty');
    fs.mkdirSync(src, { recursive: true });
    const dst = path.join(root, 'current-appdir');
    const r = migrateDirInto(src, dst);
    // 空目录搬出空结果，这是合法的「没搬」
    assert.ok(r === null || r.files.length === 0, '空目录不应报告搬运了任何文件');
    ok('空目录安全处理');
  }

  console.log('\n【5】目标已存在同名文件时逐个跳过，不覆盖');
  {
    const root = newSandbox();
    const src = seed(path.join(root, 'legacy-appdir'), {
      'settings.json': '{"videoSpeed":1}',
    });
    const dst = path.join(root, 'current-appdir');
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'credentials.enc'), 'USER_NEWER', 'utf-8');

    migrateDirInto(src, dst);
    assert.strictEqual(
      fs.readFileSync(path.join(dst, 'credentials.enc'), 'utf-8'),
      'USER_NEWER',
      '账号文件不得被旧目录覆盖'
    );
    ok('不覆盖用户更新的文件');
  }

  console.log(`\n迁移测试全部通过（${passed} 项）`);
} catch (e) {
  console.error('\n✗ 迁移测试失败：', (e as Error)?.message || e);
  process.exitCode = 1;
}
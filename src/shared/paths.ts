import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 应用目录名与改名迁移。
 *
 * ── 为什么要迁移 ──
 * Electron 的 userData 目录名直接来自 productName。产品改过一次名字之后，
 * 新版启动时会指向一个全新的空目录，用户看到的是「账号没了、进度全清零」——
 * 数据其实还在旧目录里，只是没人去搬。升级必丢一次体验。
 *
 * 迁移策略刻意保守：
 *   - 只搬文件，**不删旧目录**。删了万一判断错了就是不可逆的数据损失。
 *     旧目录留着最多占几百 KB，代价远低于搬错的风险。
 *   - 目标目录只要已有任一文件就**整个跳过**。宁可让用户手工拷一次，
 *     也不能用一份空/半新不旧的数据覆盖掉他正在用的。
 *   - 只处理已知的那一串文件，不做递归整目录搬运，避免把无关的缓存、
 *     日志、日志级别的临时文件也卷进来。
 */

/** 新目录名。改这里等于改 productName 对应的数据目录，改前务必同步 package.json。 */
export const APP_DIR_NAME = '课程任务助手 CourseHelper';

/** 历史上用过的目录名，最新的排在前面。 */
export const LEGACY_DIR_NAMES = ['刷课助手 CourseHelper', 'CourseHelper'];

/** 需要迁移的文件：设置、账号凭证、视觉服务密钥、学习进度。 */
const CARRY_FILES = [
  'settings.json',
  'credentials.enc',
  'vision.enc',
  'data',
];

/** 迁移结果。files 是实际搬动过的条目。 */
export interface MigrationResult {
  from: string;
  files: string[];
}

/**
 * 迁移核心：从 srcDir 搬运到 dstDir。
 *
 * 单独拆出来而不是只留一个「按平台拼路径」的包装，是为了能在测试里用临时目录
 * 直接驱动 —— 真实目录名是中文，在部分 Windows 终端下按 GBK 显示，
 * 与 Node 写出的 UTF-8 路径对不上，用真名做沙箱会读到「不存在的同名目录」。
 *
 * 返回 null 表示「没搬」（目标已有数据 / 源不存在 / 出错）。
 */
export function migrateDirInto(srcDir: string, dstDir: string): MigrationResult | null {
  // 目标已有实质内容 → 已经迁过（或用户自己放的东西），不动。
  for (const f of CARRY_FILES) {
    if (fs.existsSync(path.join(dstDir, f))) return null;
  }
  if (!fs.existsSync(srcDir)) return null;

  const moved: string[] = [];
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of CARRY_FILES) {
      const from = path.join(srcDir, f);
      if (!fs.existsSync(from)) continue;
      copyPath(from, path.join(dstDir, f));
      moved.push(f);
    }
    return { from: path.basename(srcDir), files: moved };
  } catch {
    // 迁移失败绝不能拦住启动：用户至少还能重新登录一次。
    return null;
  }
}

/** 目录名转成平台各自的 appData 根路径下的完整路径。 */
function appDataRoot(name: string): string {
  return path.join(appDataDir(), name);
}

/**
 * 各平台的 appData 根目录。
 * 手写而不引 electron，是因为这个模块要被主进程在 ready 之前调用——
 * 那时 `app.getPath` 已经能用了，但把这个依赖挪进迁移逻辑会让调用顺序
 * 变得微妙（迁移必须在 setName 之后、Store 之前，任何时序错位都可能拿到旧名）。
 */
function appDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return base;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * 复制一个文件或目录。
 *
 * 不用 fs.cpSync：它在「目标是尚不存在的目录」这一组合下（正是 data/ 的情形）
 * 会在 Windows 上直接终止进程 —— try/catch 接不住，退出码 127 且没有任何
 * 堆栈。迁移失败等于应用起不来，比不迁移严重得多。
 * 逐项判断类型后分别走 copyFileSync / 自建递归，行为完全可控。
 */
function copyPath(from: string, to: string): void {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      copyPath(path.join(from, name), path.join(to, name));
    }
  } else {
    // 目标已存在则不覆盖：宁可少搬一个文件，也不要用旧版本盖掉用户正在用的。
    if (fs.existsSync(to)) return;
    fs.copyFileSync(from, to);
  }
}

/**
 * 把 settings.json 里的 dataDir 从旧目录改写到新目录。
 *
 * ── 为什么必须做这一步 ──
 * `AppSettings.dataDir` 存的是**绝对路径**（用户可在设置页自定义）。
 * 改 productName 之后，文件搬过来了，但这个字段还指着旧目录：
 *
 *   "dataDir": "C:\\Users\\...\\AppData\\Roaming\\刷课助手 CourseHelper\\data"
 *
 * 结果是学习进度读写到一个「搬过去了但没人再往里写」的目录 ——
 * 表现是「章节被反复重做、进度永远记不上」，而且**不报任何错**。
 * 实测（2026-10-17）就是踩到了这个：本机迁移后 dataDir 仍指旧目录，
 * createWindow 因 copyfile ENOENT 直接失败。
 *
 * 只改指向旧**目录名**的路径；用户自定义到别处的（不在 legacy 名单里）一律不动。
 */
export function rewriteDataDirInSettings(targetRoot: string): boolean {
  const file = path.join(targetRoot, 'settings.json');
  try {
    if (!fs.existsSync(file)) return false;
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const cur = typeof s.dataDir === 'string' ? s.dataDir : '';
    if (!cur) return false;
    // 已经指向新目录或用户自定义目录 → 不动
    const hitsLegacy = LEGACY_DIR_NAMES.some(name => cur.indexOf(name) >= 0);
    if (!hitsLegacy) return false;
    s.dataDir = path.join(targetRoot, 'data');
    fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf-8');
    console.log(`[paths] 已把 settings.dataDir 重写到新目录: ${s.dataDir}`);
    return true;
  } catch (e) {
    // 改不了就让用户自己在设置页改，不要拦住启动
    console.warn('[paths] 重写 settings.dataDir 失败，可在设置页手动指定数据目录:', e);
    return false;
  }
}

/**
 * 把旧目录里的用户数据搬到新目录。
 *
 * 幂等：没有旧目录、或新目录已有数据时都直接返回。
 * 返回迁移结果，仅用于日志与测试断言。
 */
export function migrateUserDataDir(): MigrationResult | null {
  const target = appDataRoot(APP_DIR_NAME);

  for (const legacy of LEGACY_DIR_NAMES) {
    const src = appDataRoot(legacy);
    if (path.resolve(src) === path.resolve(target)) continue;
    const r = migrateDirInto(src, target);
    if (r) {
      // 旧目录原地保留，见文件头说明。
      console.log(`[paths] 已迁移旧数据目录 ${legacy} → ${APP_DIR_NAME}: ${r.files.join(', ')}`);
    }
    // ⚠️ 不管这次有没有搬，都必须重写 dataDir。
    // 上一轮已经迁过的用户，新目录里已有 settings.json（于是 migrateDirInto
    // 会跳过），但那个文件里的 dataDir 还指着旧目录 —— 不改就是进度永远记不上。
    rewriteDataDirInSettings(target);
    return r;
  }

  // 没有旧目录可搬（全新安装，或只剩新目录），同样要查一遍 dataDir
  rewriteDataDirInSettings(target);
  return null;
}
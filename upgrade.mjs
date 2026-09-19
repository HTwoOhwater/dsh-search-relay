#!/usr/bin/env node
/**
 * upgrade.mjs — 把 DSH 升级到指定版本，并在升级后自动重打我们的补丁。
 *
 * 为什么需要它：`npm i -g @deepseek-ai/dsh@x` 会整个替换 dsh 包目录，把里面
 * 我们改过的插件一起冲掉（搜索 relay 补丁 + 客户端「模型」字段补丁）。这个脚本
 * 把「备份 → 升级 → 重打补丁 → 复验」串成一步。
 *
 * ⚠️ 必须在 dsh web 停止后运行（Windows 上 npm 覆盖正在使用的文件可能失败）。
 *
 * 用法：
 *   node upgrade.mjs --check                 # 只看当前状态和将要做什么
 *   node upgrade.mjs                         # 升级到脚本内置目标版本
 *   node upgrade.mjs --version 0.1.5-rc.2    # 指定版本
 *   node upgrade.mjs --dsh <目录>            # 手动指定 DSH 安装目录
 *   node upgrade.mjs --restore               # 还原最近一次升级前的备份
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCOPE = '@deepseek-ai';
/** 本仓库补丁适配过的目标版本（搜索插件在该版本与本仓库基线字节相同）。 */
const TARGET_VERSION = '0.1.5-rc.2';
/** 本仓库补丁的基线版本。 */
const BASELINE_VERSION = '0.1.2-rc.1';
const BACKUP_ROOT = join(homedir(), '.dsh', 'dsh-upgrade-backup');
const HOST_PKG = 'dsh-web-search-deepseek';
const CLIENT_PKG = 'dsh-client-ui-settings-plugins';
/** 升级后需要重新打补丁的文件（相对 DSH 的 node_modules/@deepseek-ai）。 */
const PATCHED_FILES = [
	`${HOST_PKG}/lib/index.js`,
	`${HOST_PKG}/README.md`,
	`${HOST_PKG}/README.zh.md`,
	`${CLIENT_PKG}/lib/client.js`,
	`${CLIENT_PKG}/lib/types/client/web-search-card-controller.d.ts`,
	`${CLIENT_PKG}/lib/types/client/locales.d.ts`,
];

const C = process.stdout.isTTY && !process.env.NO_COLOR
	? { ok: '\u001b[32m', warn: '\u001b[33m', err: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', off: '\u001b[0m' }
	: { ok: '', warn: '', err: '', dim: '', bold: '', off: '' };
const ok = (t) => console.log(`  ${C.ok}✓${C.off} ${t}`);
const warn = (t) => console.log(`  ${C.warn}!${C.off} ${t}`);
const fail = (t) => console.log(`  ${C.err}x${C.off} ${t}`);
const dim = (t) => console.log(`  ${C.dim}${t}${C.off}`);
const step = (t) => console.log(`\n${C.bold}${t}${C.off}`);

/* ------------------------------------------------------------------ 参数 */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => (has(f) ? args[args.indexOf(f) + 1] : d);
const opts = {
	check: has('--check') || has('-n'),
	restore: has('--restore'),
	dsh: val('--dsh'),
	version: val('--version', TARGET_VERSION),
	skipInstall: has('--skip-install'),
};

/* ------------------------------------------------------------ 探测 DSH */

function tryExec(cmd, a) {
	try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function asDshDir(dir) {
	for (const c of [dir, join(dir, SCOPE, 'dsh'), join(dir, 'node_modules', SCOPE, 'dsh')]) {
		const pkg = join(c, 'package.json');
		if (!existsSync(pkg)) continue;
		try {
			const json = JSON.parse(readFileSync(pkg, 'utf8').replace(/^\uFEFF/, ''));
			if (json.name === '@deepseek-ai/dsh') return { dir: c, version: json.version };
		} catch { /* 继续 */ }
	}
	return null;
}

function locateDsh() {
	if (opts.dsh) {
		const found = asDshDir(resolve(opts.dsh));
		if (!found) { fail(`--dsh 指定的目录不是 DSH 包：${resolve(opts.dsh)}`); process.exit(1); }
		return found;
	}
	const tried = [];
	const exe = tryExec(process.platform === 'win32' ? 'where' : 'which', ['dsh']);
	if (exe) {
		for (const line of exe.split(/\r?\n/)) {
			let real = line.trim();
			if (!real) continue;
			try { real = realpathSync(real); } catch { /* 保持原样 */ }
			const marker = `${process.platform === 'win32' ? '\\' : '/'}${SCOPE}${process.platform === 'win32' ? '\\' : '/'}dsh`;
			const i = real.indexOf(marker);
			if (i >= 0) tried.push(real.slice(0, i + marker.length));
		}
	}
	const root = tryExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g']);
	if (root) tried.push(join(root, SCOPE, 'dsh'));
	const home = homedir();
	if (process.platform === 'win32') {
		tried.push(join(home, 'scoop', 'persist', 'nodejs', 'bin', 'node_modules', SCOPE, 'dsh'));
		tried.push(join(home, 'scoop', 'apps', 'nodejs', 'current', 'bin', 'node_modules', SCOPE, 'dsh'));
		if (process.env.APPDATA) tried.push(join(process.env.APPDATA, 'npm', 'node_modules', SCOPE, 'dsh'));
	} else {
		tried.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules');
		tried.push(join(home, '.npm-global', 'lib', 'node_modules', SCOPE, 'dsh'));
	}
	for (const d of tried) { const f = asDshDir(d); if (f) return f; }
	fail('没找到 DSH 安装目录，请用 --dsh 指定');
	dim(`已尝试：${tried.slice(0, 6).join(' , ')}`);
	process.exit(1);
}

/* ------------------------------------------------------- dsh web 是否在跑 */

async function portBusy(port) {
	return new Promise((res) => {
		const s = createConnection({ host: '127.0.0.1', port });
		s.setTimeout(600);
		s.on('connect', () => { s.destroy(); res(true); });
		s.on('timeout', () => { s.destroy(); res(false); });
		s.on('error', () => res(false));
	});
}

/* ------------------------------------------------------------------ 备份 */

function backup(dshDir, version) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = join(BACKUP_ROOT, stamp);
	const base = join(dshDir, 'node_modules', SCOPE);
	const manifest = { createdAt: new Date().toISOString(), dshDir, version, files: [] };
	for (const rel of PATCHED_FILES) {
		const src = join(base, rel);
		if (!existsSync(src)) { manifest.files.push({ rel, existed: false }); continue; }
		const dest = join(dir, 'files', rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
		manifest.files.push({ rel, existed: true });
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
	return dir;
}

function restore() {
	const dirs = existsSync(BACKUP_ROOT)
		? readdirSync(BACKUP_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(BACKUP_ROOT, e.name)).sort()
		: [];
	const dir = dirs.at(-1);
	if (!dir) { fail('找不到升级备份'); process.exit(1); }
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
	step(`从备份还原：${dir}`);
	dim(`备份于 ${manifest.createdAt}，当时 DSH ${manifest.version}`);
	const base = join(manifest.dshDir, 'node_modules', SCOPE);
	for (const f of manifest.files) {
		if (!f.existed) { warn(`备份时不存在，跳过：${f.rel}`); continue; }
		const src = join(dir, 'files', f.rel);
		const dst = join(base, f.rel);
		mkdirSync(dirname(dst), { recursive: true });
		copyFileSync(src, dst);
		ok(`已还原 ${f.rel}`);
	}
	console.log('\n还原完成。注意：这只还原被补丁的文件，不改 DSH 版本。');
}

/* ------------------------------------------------------------------ 主流程 */

const current = locateDsh();
const scopeBase = join(current.dir, 'node_modules', SCOPE);

console.log(`${C.bold}DSH 升级助手${C.off}`);
dim(`DSH 安装目录: ${current.dir}`);
dim(`当前版本: ${current.version}    目标版本: ${opts.version}`);

if (opts.restore) { restore(); process.exit(0); }

step('1. 环境检查');
const busy = await portBusy(3080);
if (busy) warn('检测到 3080 端口在监听——dsh web 可能还在运行。升级前请先停掉它（否则 npm 覆盖文件可能失败）');
else ok('3080 端口空闲（dsh web 似乎已停止）');
const hostSrc = join(HERE, 'payload', HOST_PKG);
if (!existsSync(hostSrc)) { fail(`找不到 payload：${hostSrc}`); process.exit(1); }
ok('找到补丁 payload');
if (current.version === opts.version) warn(`当前已经是 ${opts.version}，将只重打补丁（不会重复安装）`);

step('2. 备份将被替换的补丁文件');
if (opts.check) {
	dim(`[check] 将备份 ${PATCHED_FILES.length} 个文件到 ${BACKUP_ROOT}/<时间戳>/`);
} else {
	const dir = backup(current.dir, current.version);
	ok(`已备份到 ${dir}`);
	dim('还原：node upgrade.mjs --restore');
}

step('3. 安装新版本');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const installArgs = ['i', '-g', `@deepseek-ai/dsh@${opts.version}`, '--no-audit', '--no-fund'];
if (opts.check) {
	dim(`[check] 将执行：${npm} ${installArgs.join(' ')}`);
} else if (opts.skipInstall || current.version === opts.version) {
	warn('跳过安装步骤');
} else {
	dim(`${npm} ${installArgs.join(' ')}`);
	try {
		execFileSync(npm, installArgs, { stdio: 'inherit' });
		ok('安装完成');
	} catch (error) {
		fail(`安装失败：${error.message}`);
		dim('可以先用 node upgrade.mjs --restore 还原补丁文件');
		process.exit(1);
	}
}

step('4. 重新打补丁');
const after = asDshDir(current.dir) ?? current;
if (after.version !== opts.version && !opts.check) warn(`安装后读到的版本是 ${after.version}，与目标 ${opts.version} 不一致，请确认安装结果`);
if (opts.check) {
	dim('[check] 将执行：node install.mjs --dsh <目录> --no-settings');
} else {
	try {
		execFileSync(process.execPath, [join(HERE, 'install.mjs'), '--dsh', current.dir, '--no-settings'], { stdio: 'inherit' });
	} catch (error) {
		fail(`打补丁失败：${error.message}`);
		process.exit(1);
	}
}

step('5. 复验');
if (opts.check) {
	dim('[check] 将执行：node install.mjs --dsh <目录> --no-settings --check');
} else {
	try {
		execFileSync(process.execPath, [join(HERE, 'install.mjs'), '--dsh', current.dir, '--no-settings', '--check'], { stdio: 'inherit' });
	} catch {
		warn('复验未全部通过，请看上面的输出');
	}
}

console.log(`\n${C.bold}下一步${C.off}`);
console.log('  1. 启动 dsh web（如果刚才停了它）');
console.log('  2. 打开旧会话时，日志会自动从 v0 迁移到 v3（写成新的 session.v3.jsonl.zstd，原文件保留）');
console.log('  3. 若某个旧会话报 "failed to project session ... reading \'content\'"，那是上游 0.1.5-rc.2 仍未修的投影 bug（讨论 #6686）——');
console.log('     会话日志本身没坏，原 v0 文件也还在，等上游修或临时用 dsh-doctor 定位');
console.log(`\n版本说明：本仓库补丁的基线是 ${BASELINE_VERSION}；搜索插件在 ${TARGET_VERSION} 与本仓库基线字节相同，所以补丁可直接沿用。`);

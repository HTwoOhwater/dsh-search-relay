#!/usr/bin/env node
/**
 * install.mjs — 把「DSH 搜索中继改造」装到本机的 DSH 安装里。
 *
 * 做四件事：
 *   1. 覆盖 host 插件 @deepseek-ai/dsh-web-search-deepseek（relay 模式：中继不执行
 *      服务端搜索时，由插件自己抓取搜索结果）；
 *   2. 给客户端包 @deepseek-ai/dsh-client-ui-settings-plugins 打「模型」字段补丁；
 *   3. 在 ~/.dsh/settings.yaml 里补上 web-search-deepseek 配置段（若不存在）；
 *   4. 检查 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY。
 *
 * 所有被覆盖的文件都会先备份到 ~/.dsh/dsh-search-relay-backup/<时间戳>/，
 * 可以用 --restore 一键还原。
 *
 * 常用：
 *   node install.mjs                 # 安装（自动找 DSH）
 *   node install.mjs --check         # 只预览，不写任何文件
 *   node install.mjs --dsh /path/to/node_modules/@deepseek-ai/dsh
 *   node install.mjs --api-key sk-xxx
 *   node install.mjs --restore       # 还原最近一次备份
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { overlayClientUi, patchClientUi } from './payload/client-ui/patch-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_PKG = 'dsh-web-search-deepseek';
const CLIENT_PKG = 'dsh-client-ui-settings-plugins';
const SCOPE = '@deepseek-ai';
/** 本仓库改造所基于的 DSH 版本；版本不同会警告但仍然继续。 */
const BUILT_FOR = '0.1.2-rc.1';

const DSH_HOME = join(homedir(), '.dsh');
const SETTINGS_FILE = join(DSH_HOME, 'settings.yaml');
const CREDENTIALS_FILE = join(DSH_HOME, '.credentials.yaml');
const BACKUP_ROOT = join(DSH_HOME, 'dsh-search-relay-backup');
const KEY_NAME = 'DEEPSEEK_API_KEY';
const DEFAULT_BASE_URL = 'https://xplt.sdu.edu.cn:4000/v1';
const DEFAULT_MODEL = 'ByteDance-volcengine/DeepSeek-V4.1-Flash';

/* ------------------------------------------------------------------ 输出 */

const C = process.stdout.isTTY && !process.env.NO_COLOR
	? { ok: '\u001b[32m', warn: '\u001b[33m', err: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', off: '\u001b[0m' }
	: { ok: '', warn: '', err: '', dim: '', bold: '', off: '' };

const step = (n, total, text) => console.log(`\n${C.bold}[${n}/${total}] ${text}${C.off}`);
const ok = (t) => console.log(`  ${C.ok}✓${C.off} ${t}`);
const warn = (t) => console.log(`  ${C.warn}!${C.off} ${t}`);
const fail = (t) => console.log(`  ${C.err}x${C.off} ${t}`);
const dim = (t) => console.log(`  ${C.dim}${t}${C.off}`);

/* ------------------------------------------------------------ 参数解析 */

function parseArgs(argv) {
	const o = {
		dsh: null, check: false, restore: false, from: null, apiKey: null,
		client: true, settings: true, overlayClient: false, baseURL: null, model: null, help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) { console.error(`参数 ${a} 需要一个值`); process.exit(2); }
			return v;
		};
		switch (a) {
			case '--dsh': o.dsh = next(); break;
			case '--from': o.from = next(); break;
			case '--api-key': o.apiKey = next(); break;
			case '--base-url': o.baseURL = next(); break;
			case '--model': o.model = next(); break;
			case '--check': case '-n': case '--dry-run': o.check = true; break;
			case '--restore': o.restore = true; break;
			case '--no-client': o.client = false; break;
			case '--no-settings': o.settings = false; break;
			case '--overlay-client': o.overlayClient = true; break;
			case '-h': case '--help': o.help = true; break;
			default: console.error(`未知参数：${a}（用 --help 看用法）`); process.exit(2);
		}
	}
	return o;
}

const HELP = `
DSH 搜索中继改造 · 安装器

用法：
  node install.mjs [选项]

选项：
  --dsh <路径>       指定 DSH 安装目录（默认自动探测）
  --check, -n        只预览要做什么，不写任何文件
  --restore          还原最近一次备份
  --from <目录>      配合 --restore，指定要还原的备份目录
  --api-key <key>    写入 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY
  --base-url <url>   写入 settings.yaml 的接口地址（默认 ${DEFAULT_BASE_URL}）
  --model <name>     写入 settings.yaml 的模型名（默认 ${DEFAULT_MODEL}）
  --no-client        跳过客户端「模型」字段补丁
  --no-settings      不碰 ~/.dsh/settings.yaml
  --overlay-client   客户端整包覆盖（仅在 DSH 版本与本仓库完全一致时用）
  -h, --help         显示本帮助
`;

/* ------------------------------------------------------------ 探测 DSH */

function tryExec(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}

/** 从 dsh 可执行文件反推包目录（最可靠的信号）。 */
function dshFromExecutable() {
	const out = tryExec(process.platform === 'win32' ? 'where' : 'which', ['dsh']);
	if (!out) return null;
	for (const line of out.split(/\r?\n/)) {
		const raw = line.trim();
		if (!raw) continue;
		let real = raw;
		try { real = realpathSync(raw); } catch { /* 保持原样 */ }
		const marker = `/${SCOPE}/dsh/`.replace(/\//g, process.platform === 'win32' ? '\\' : '/');
		const idx = real.indexOf(marker);
		if (idx >= 0) return real.slice(0, idx + marker.length - 1);
	}
	return null;
}

function candidateDirs() {
	const home = homedir();
	const list = [];
	if (process.platform === 'win32') {
		list.push(join(home, 'scoop', 'persist', 'nodejs', 'bin', 'node_modules', SCOPE, 'dsh'));
		list.push(join(home, 'scoop', 'apps', 'nodejs', 'current', 'bin', 'node_modules', SCOPE, 'dsh'));
		if (process.env.APPDATA) list.push(join(process.env.APPDATA, 'npm', 'node_modules', SCOPE, 'dsh'));
	} else {
		list.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/local/share/npm/lib/node_modules');
		list.push(join(home, '.npm-global', 'lib', 'node_modules'));
		list.push(join(home, '.local', 'share', 'npm', 'lib', 'node_modules'));
	}
	const roots = list.map((r) => (r.endsWith(`${SCOPE}${process.platform === 'win32' ? '\\' : '/'}dsh`) ? r : join(r, SCOPE, 'dsh')));
	// nvm / fnm / volta 这类多版本管理器
	for (const base of [join(home, '.nvm', 'versions', 'node'), join(home, '.local', 'share', 'fnm', 'node-versions'), join(home, '.volta', 'tools', 'image', 'node')]) {
		if (!existsSync(base)) continue;
		let entries = [];
		try { entries = readdirSync(base); } catch { /* 忽略 */ }
		for (const entry of entries) {
			roots.push(join(base, entry, 'lib', 'node_modules', SCOPE, 'dsh'));
			roots.push(join(base, entry, 'installation', 'lib', 'node_modules', SCOPE, 'dsh'));
		}
	}
	return roots;
}

/** 校验一个目录确实是 DSH 包；返回 package.json 内容或 null。 */
function asDshDir(dir) {
	for (const candidate of [dir, join(dir, SCOPE, 'dsh'), join(dir, 'node_modules', SCOPE, 'dsh')]) {
		const pkg = join(candidate, 'package.json');
		if (!existsSync(pkg)) continue;
		try {
			const json = JSON.parse(readFileSync(pkg, 'utf8').replace(/^\uFEFF/, ''));
			if (json.name === '@deepseek-ai/dsh') return { dir: candidate, version: json.version };
		} catch { /* 继续找 */ }
	}
	return null;
}

function locateDsh(opts) {
	if (opts.dsh) {
		const found = asDshDir(resolve(opts.dsh));
		if (!found) {
			fail(`--dsh 指定的目录不是 DSH 包：${resolve(opts.dsh)}`);
			process.exit(1);
		}
		return found;
	}
	const tried = [];
	const fromExe = dshFromExecutable();
	if (fromExe) tried.push(fromExe);
	const npmRoot = tryExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g']);
	if (npmRoot) tried.push(join(npmRoot, SCOPE, 'dsh'));
	tried.push(...candidateDirs());

	for (const dir of tried) {
		const found = asDshDir(dir);
		if (found) return found;
	}
	fail('没找到 DSH 安装目录。请用 --dsh 指定，例如：');
	dim('node install.mjs --dsh /usr/lib/node_modules/@deepseek-ai/dsh');
	dim(`（已尝试：${tried.slice(0, 8).join(' , ')}${tried.length > 8 ? ' …' : ''}）`);
	process.exit(1);
}

/* ------------------------------------------------------------ 文件工具 */

function walk(dir, base = dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else if (entry.isFile()) out.push(relative(base, full));
	}
	return out;
}

const sanitize = (p) => p.replace(/[:\\/]/g, '__');

/** 备份给定文件，返回备份目录（含 manifest.json 供还原）。 */
function backup(files, ctx) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = join(BACKUP_ROOT, stamp);
	mkdirSync(dir, { recursive: true });
	const manifest = { createdAt: new Date().toISOString(), dshDir: ctx.dshDir, version: ctx.version, files: [] };
	for (const file of files) {
		if (!existsSync(file)) {
			manifest.files.push({ path: file, existed: false });
			continue;
		}
		// 备份保留相对目录结构（而不是把绝对路径压平），否则文件名在 Windows 上会超长。
		let rel = relative(ctx.base, file);
		if (rel.startsWith('..') || isAbsolute(rel)) rel = join('external', sanitize(file));
		const dest = join(dir, 'files', rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(file, dest);
		manifest.files.push({ path: file, existed: true, relative: rel, backup: dest });
	}
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
	return dir;
}

/* ------------------------------------------------------------ 还原流程 */

function latestBackup() {
	if (!existsSync(BACKUP_ROOT)) return null;
	const dirs = readdirSync(BACKUP_ROOT, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(BACKUP_ROOT, e.name))
		.sort();
	return dirs.length ? dirs[dirs.length - 1] : null;
}

function runRestore(opts) {
	console.log(`${C.bold}DSH 搜索中继改造 · 还原${C.off}`);
	const dir = opts.from ? resolve(opts.from) : latestBackup();
	if (!dir || !existsSync(join(dir, 'manifest.json'))) {
		fail('找不到可用的备份（~/.dsh/dsh-search-relay-backup/<时间戳>/manifest.json）');
		process.exit(1);
	}
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
	step(1, 1, `从备份还原：${dir}`);
	dim(`备份时间：${manifest.createdAt}，DSH ${manifest.version ?? '未知'}`);
	let restored = 0;
	for (const entry of manifest.files) {
		if (!entry.existed) {
			if (existsSync(entry.path) && !opts.check) rmSync(entry.path, { force: true });
			warn(`原本不存在，已删除：${entry.path}`);
			continue;
		}
		if (opts.check) { dim(`[check] 将还原 ${entry.path}`); continue; }
		mkdirSync(dirname(entry.path), { recursive: true });
		copyFileSync(entry.backup, entry.path);
		ok(`已还原 ${entry.path}`);
		restored++;
	}
	console.log(`\n${C.ok}还原完成${C.off}（${restored} 个文件）。记得重启 dsh web。`);
}

/* ------------------------------------------------------------ 主安装流程 */

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) { console.log(HELP); return; }
	if (opts.restore) return runRestore(opts);

	console.log(`${C.bold}DSH 搜索中继改造 · 安装器${C.off}`);
	if (opts.check) dim('（--check 预览模式：不会写入任何文件）');

	const total = 6;
	step(1, total, '定位 DSH 安装目录');
	const dsh = locateDsh(opts);
	ok(`DSH ${dsh.version}`);
	dim(dsh.dir);

	const scopeDir = join(dsh.dir, 'node_modules', SCOPE);
	const hostDir = join(scopeDir, HOST_PKG);
	const clientDir = join(scopeDir, CLIENT_PKG);

	step(2, total, '版本检查');
	if (dsh.version === BUILT_FOR) ok(`版本一致（${BUILT_FOR}）`);
	else warn(`本改造基于 DSH ${BUILT_FOR}，当前是 ${dsh.version}；若之后搜索或设置页异常，优先怀疑版本差异`);
	if (!existsSync(hostDir)) { fail(`找不到 host 插件目录：${hostDir}`); process.exit(1); }

	// 需要备份的文件清单
	const hostPayload = join(HERE, 'payload', HOST_PKG);
	const hostFiles = walk(hostPayload).filter((rel) => rel !== 'package.json');
	const clientFiles = [
		'lib/client.js',
		'lib/types/client/web-search-card-controller.d.ts',
		'lib/types/client/locales.d.ts',
	];
	const toBackup = [
		...hostFiles.map((rel) => join(hostDir, rel)),
		...(opts.client ? clientFiles.map((rel) => join(clientDir, rel)) : []),
	];

	step(3, total, '备份将被覆盖的文件');
	if (opts.check) {
		dim(`[check] 将备份 ${toBackup.filter(existsSync).length} 个已存在文件到 ${BACKUP_ROOT}/<时间戳>/`);
	} else {
		const dir = backup(toBackup, { dshDir: dsh.dir, version: dsh.version, base: scopeDir });
		ok(`已备份到 ${dir}`);
		dim(`还原命令：node install.mjs --restore`);
	}

	step(4, total, `覆盖 host 插件（${HOST_PKG}，relay 模式）`);
	let hostWritten = 0;
	for (const rel of hostFiles) {
		const src = join(hostPayload, rel);
		const dst = join(hostDir, rel);
		if (opts.check) { dim(`[check] 将覆盖 ${rel}`); continue; }
		mkdirSync(dirname(dst), { recursive: true });
		copyFileSync(src, dst);
		hostWritten++;
	}
	if (!opts.check) ok(`已覆盖 ${hostWritten} 个文件（lib/index.js 等，package.json 保持原样）`);

	step(5, total, `客户端「模型」字段补丁（${CLIENT_PKG}）`);
	if (!opts.client) {
		warn('已按 --no-client 跳过（GUI 里不会出现「模型」输入框，但仍可在 settings.yaml 里配置 model）');
	} else if (!existsSync(clientDir)) {
		warn(`找不到客户端包目录：${clientDir}（跳过；不影响搜索功能）`);
	} else {
		const report = patchClientUi(clientDir, {
			check: opts.check,
			log: (m) => dim(m),
		});
		for (const s of report.sites) {
			const tag = s.status === 'patched' ? '已打补丁' : s.status === 'already' ? '已存在' : '锚点缺失';
			(s.status === 'anchor-missing' ? warn : ok)(`${s.site}：${tag}${s.detail ? `（${s.detail}）` : ''}`);
		}
		for (const w of report.warnings) warn(w);
		for (const e of report.errors) fail(e);
		if (!report.ok && opts.overlayClient) {
			warn('锚点缺失，回退到整包覆盖（仅当 DSH 版本一致时才安全）');
			overlayClientUi(join(HERE, 'payload', 'client-ui'), clientDir, { check: opts.check, log: (m) => dim(m) });
		} else if (!report.ok) {
			warn('客户端补丁未打全：设置页可能看不到「模型」输入框（搜索功能不受影响）');
			dim('想强制整包覆盖可加 --overlay-client');
		}
	}

	step(6, total, '检查配置与密钥');
	if (!opts.settings) {
		warn('已按 --no-settings 跳过 settings.yaml');
	} else {
		ensureSettings(opts);
	}
	await checkCredentials(opts, dsh.dir);

	// 收尾
	console.log(`\n${C.bold}完成${C.off}${opts.check ? '（预览模式，未改动任何文件）' : ''}`);
	console.log('\n下一步：');
	console.log('  1. 重启 dsh web（host 插件改动必须重启才生效）');
	console.log('  2. 浏览器刷新页面 → 设置 → 插件 → 插件配置，应能看到「模型」输入框');
	console.log('  3. 让 agent 随便搜一下验证：搜一下今天的新闻');
	if (!opts.check) console.log(`\n回滚：node install.mjs --restore`);
}

/* -------------------------------------------------------- settings.yaml */

function settingsBlock(opts) {
	return [
		'web-search-deepseek:',
		`  baseURL: ${opts.baseURL ?? DEFAULT_BASE_URL}`,
		`  model: ${opts.model ?? DEFAULT_MODEL}`,
		'',
	].join('\n');
}

function ensureSettings(opts) {
	if (!existsSync(SETTINGS_FILE)) {
		if (opts.check) { dim(`[check] 将创建 ${SETTINGS_FILE}`); return; }
		mkdirSync(DSH_HOME, { recursive: true });
		writeFileSync(SETTINGS_FILE, settingsBlock(opts), 'utf8');
		ok(`已创建 ${SETTINGS_FILE}`);
		return;
	}
	const text = readFileSync(SETTINGS_FILE, 'utf8');
	if (/^web-search-deepseek:/m.test(text)) {
		ok(`${SETTINGS_FILE} 里已有 web-search-deepseek 段，未改动`);
		const section = text.split(/^web-search-deepseek:/m)[1]?.split(/^\S/m)[0] ?? '';
		const lines = section.split(/\r?\n/).filter((l) => l.trim()).map((l) => `web-search-deepseek:${l}`);
		for (const l of lines.slice(0, 6)) dim(l);
		if (!/^\s*model:/m.test(section)) {
			warn('该段里没有 model；如果搜索报「team not allowed to access model」，需要补一行 model');
			dim(`建议：web-search-deepseek: 下加  model: ${opts.model ?? DEFAULT_MODEL}`);
		}
		return;
	}
	if (opts.check) { dim(`[check] 将在 ${SETTINGS_FILE} 末尾追加 web-search-deepseek 段`); return; }
	const separator = text.endsWith('\n') ? '' : '\n';
	writeFileSync(SETTINGS_FILE, text + separator + settingsBlock(opts), 'utf8');
	ok(`已在 ${SETTINGS_FILE} 末尾追加 web-search-deepseek 段`);
}

/* ----------------------------------------------------- credentials.yaml */

/*
 * DSH 的凭据文件格式很严格（@deepseek-ai/dsh-credentials-local 的解析器
 * parseCredentialsDocument）：
 *   - 非空文件必须有 `version: 1`，否则报 "uses the pre-release flat layout"；
 *   - 顶层只允许 version / refs / records 三个键，多一个就抛错；
 *   - 密钥引用放在 `refs:` 下面，值必须是非空字符串。
 * 所以下面既不能写成扁平的 `DEEPSEEK_API_KEY: sk-x`，也不能随便加键——
 * 写坏了 DSH 会拒绝加载整个凭据文件。
 */

/** 判断凭据文件当前是哪种布局，以及是否已有我们的引用。 */
function inspectCredentials(text) {
	if (!text.trim()) return { layout: 'empty', value: null };
	const nested = new RegExp(`^[ \\t]+${KEY_NAME}[ \\t]*:[ \\t]*(\\S.*)$`, 'm').exec(text);
	const value = nested ? nested[1].trim() : null;
	if (!/^version[ \t]*:/m.test(text)) return { layout: 'flat', value };
	return { layout: 'v1', value };
}

/**
 * 生成写入密钥后的文件内容。
 * @returns 新内容，或在无法安全改写时返回 null（调用方负责提示用户手改）。
 */
function renderApiKeyWrite(text, key) {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const line = `${KEY_NAME}: ${key}`;
	const state = inspectCredentials(text);

	if (state.layout === 'empty') return `version: 1${eol}refs:${eol}  ${line}${eol}`;
	if (state.layout === 'flat') return null;

	// 已有同名的 refs 条目：只替换值
	const existing = new RegExp(`^([ \\t]+)${KEY_NAME}[ \\t]*:.*$`, 'm');
	if (existing.test(text)) {
		const out = text.replace(existing, (_, indent) => `${indent}${line}`);
		return out.endsWith('\n') ? out : out + eol;
	}

	// 有 refs: 段：插到段内第一行（沿用已有条目的缩进）
	const bare = /^refs[ \t]*:[ \t]*$/m.exec(text);
	if (bare) {
		const after = text.slice(bare.index + bare[0].length);
		const indent = /^\r?\n([ \t]+)\S/.exec(after)?.[1] ?? '  ';
		const at = bare.index + bare[0].length;
		return text.slice(0, at) + eol + indent + line + text.slice(at);
	}
	// refs 是内联形式（如 refs: {}）——不猜，交给用户手改，避免写出重复键
	if (/^refs[ \t]*:/m.test(text)) return null;

	// 只有 version / records：在 version 行之后补一个 refs 段
	const version = /^version[ \t]*:[^\r\n]*/m.exec(text);
	if (!version) return null;
	const at = version.index + version[0].length;
	return text.slice(0, at) + eol + `refs:${eol}  ${line}` + text.slice(at);
}

/**
 * 用 DSH 自带的解析器校验写入结果（这是唯一可信的校验方式）。
 * 注意区分两种情况：解析器「加载不起来」（环境原因，无害）与解析器「拒绝文档」（真问题）。
 */
async function validateWithDshParser(text, file, dshDir) {
	const modulePath = join(dshDir, 'node_modules', SCOPE, 'dsh-credentials-local', 'lib', 'index.js');
	if (!existsSync(modulePath)) return { skipped: 'DSH 里没有 dsh-credentials-local' };
	let mod;
	try {
		mod = await import(pathToFileURL(modulePath).href);
	} catch (error) {
		return { skipped: `解析器无法加载（${error instanceof Error ? error.message : String(error)}）` };
	}
	try {
		const parsed = mod.parseCredentialsDocument(text, file);
		return { ok: parsed.refs.has(KEY_NAME), value: parsed.refs.get(KEY_NAME) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function checkCredentials(opts, dshDir) {
	if (opts.apiKey) {
		const before = existsSync(CREDENTIALS_FILE) ? readFileSync(CREDENTIALS_FILE, 'utf8') : '';
		const next = renderApiKeyWrite(before, opts.apiKey);
		if (next === null) {
			fail(`凭据文件布局无法安全改写：${CREDENTIALS_FILE}`);
			dim('请手动把密钥加进 refs 段（见下），或直接删掉该文件后重跑本脚本：');
			dim(`  version: 1`);
			dim(`  refs:`);
			dim(`    ${KEY_NAME}: <你的密钥>`);
			return;
		}
		if (opts.check) { dim(`[check] 将写入 ${KEY_NAME} 到 ${CREDENTIALS_FILE}`); return; }
		mkdirSync(DSH_HOME, { recursive: true });
		writeFileSync(CREDENTIALS_FILE, next, 'utf8');
		try { chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* Windows 上没有意义 */ }

		const verdict = await validateWithDshParser(next, CREDENTIALS_FILE, dshDir);
		if (verdict.skipped) {
			ok(`已写入 ${KEY_NAME} 到 ${CREDENTIALS_FILE}（未找到 DSH 解析器，跳过校验）`);
		} else if (verdict.error) {
			warn(`已写入，但 DSH 解析器报错：${verdict.error}`);
			dim(`原内容已备份在 ${CREDENTIALS_FILE}.bak，可自行回退`);
			if (before) writeFileSync(`${CREDENTIALS_FILE}.bak`, before, 'utf8');
		} else if (verdict.ok) {
			ok(`已写入 ${KEY_NAME} 到 ${CREDENTIALS_FILE}，并用 DSH 自带解析器校验通过`);
		} else {
			warn('已写入，但解析结果里没有读到该引用，请检查');
		}
		return;
	}

	if (!existsSync(CREDENTIALS_FILE)) {
		warn(`没找到 ${CREDENTIALS_FILE}`);
	} else {
		const state = inspectCredentials(readFileSync(CREDENTIALS_FILE, 'utf8'));
		if (state.layout === 'flat') {
			fail(`${CREDENTIALS_FILE} 是旧版扁平布局，DSH 会拒绝加载整个文件`);
			dim('修法：在最上面加一行 `version: 1` 和一行 `refs:`，并把原有条目整体缩进两格。');
		} else if (state.value) {
			ok(`${CREDENTIALS_FILE} 里已有 ${KEY_NAME}`);
			return;
		} else {
			warn(`${CREDENTIALS_FILE} 里没有 ${KEY_NAME}`);
		}
	}
	dim('搜索需要中继密钥。三选一：');
	dim(`  a) node install.mjs --api-key sk-xxxx`);
	dim(`  b) 在 ${CREDENTIALS_FILE} 的 refs 段下加一行：${KEY_NAME}: sk-xxxx`);
	dim(`  c) 或设环境变量 ${KEY_NAME}（需要 dsh web 进程能看到）`);
	dim('注意文件必须是 version: 1 + refs: 的嵌套格式，扁平的会被 DSH 拒绝。');
}

main().catch((error) => {
	console.error(`\n安装器出错：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

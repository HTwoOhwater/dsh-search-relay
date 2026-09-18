#!/usr/bin/env node
/**
 * patch-client.mjs — 给 dsh-client-ui-settings-plugins 的客户端 bundle 补上
 * 「模型（Model）」输入框（英文 / 中文两套文案 + 类型声明）。
 *
 * 为什么用锚点补丁而不是整包覆盖：
 *   client.js 是 DSH 客户端的编译产物，和 DSH 版本强耦合。整包覆盖在版本不一致
 *   时会静默把客户端降级（甚至和 host 协议对不上而报错）。锚点补丁只做「在已知
 *   锚点后插入几行」，幂等、可重复执行；锚点找不到就明确报错并保持文件不动。
 *
 * 用法：
 *   node patch-client.mjs <dsh-client-ui-settings-plugins 目录>
 *   node patch-client.mjs <目录> --check      # 只检查是否需要打补丁，不写文件
 *   node patch-client.mjs <目录> --json       # 机器可读输出
 *
 * 作为模块：
 *   import { patchClientUi, overlayClientUi } from './patch-client.mjs';
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 中日韩文字检测：用来判断某个 locale 块是中文还是英文。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

const EN = {
	key: 'webSearchModel',
	label: 'Model',
	hintKey: 'webSearchModelHint',
	hint: 'Anthropic-format model name. Leave blank to use the provider default.',
};
const ZH = {
	key: 'webSearchModel',
	label: '模型',
	hintKey: 'webSearchModelHint',
	hint: 'Anthropic 格式的模型名称。留空则使用提供方默认模型。',
};

/* ------------------------------------------------------------------ 小工具 */

function detectEol(src) {
	return src.includes('\r\n') ? '\r\n' : '\n';
}

/** 取一行的前导空白（补丁沿用目标文件自己的缩进风格）。 */
function indentOf(line) {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0] : '';
}

/** 缩进「一级」的字符串：由外层/内层两行缩进相减得到，避免硬编码 tab/空格。 */
function indentUnit(outer, inner) {
	return inner.length > outer.length && inner.startsWith(outer) ? inner.slice(outer.length) : '\t';
}

/** 从后往前应用编辑，保证前面的下标不失效。 */
function applyEdits(src, edits) {
	const ordered = [...edits].sort((a, b) => b.index - a.index);
	let out = src;
	for (const e of ordered) {
		out = out.slice(0, e.index) + e.insert + out.slice(e.index + (e.remove ?? 0));
	}
	return out;
}

/* ------------------------------------------- client.js：渲染层 Model 输入框 */

/**
 * 在「单次请求最多搜索次数」那个 ValueField 之前插入 Model 的 ValueField。
 * 缩进全部从目标文件现读，所以 tab / 空格风格都能适配。
 */
function probeModelFieldBlock(src) {
	const site = 'client.js 渲染层：Model 输入框';
	if (src.includes('id: "plugin-config-web-search-model"')) return { site, status: 'already', edits: [] };

	const m = /^([ \t]*)\(0, react_jsx_runtime\.jsx\)\(ValueField, \{\r?\n([ \t]*)id: "plugin-config-web-search-max-uses",/m.exec(src);
	if (!m) return { site, status: 'anchor-missing', edits: [], detail: '未找到 plugin-config-web-search-max-uses 的 ValueField 锚点' };

	const jsxIndent = m[1];
	const fieldIndent = m[2];
	const inner = fieldIndent + indentUnit(jsxIndent, fieldIndent);
	const eol = detectEol(src);
	const block = [
		`${jsxIndent}(0, react_jsx_runtime.jsx)(ValueField, {`,
		`${fieldIndent}id: "plugin-config-web-search-model",`,
		`${fieldIndent}label: t("webSearchModel"),`,
		`${fieldIndent}hint: t("webSearchModelHint"),`,
		`${fieldIndent}overriddenLabel: t("overridden"),`,
		`${fieldIndent}resetLabel: t("reset"),`,
		`${fieldIndent}invalidLabel: t("invalidNumber"),`,
		`${fieldIndent}disabled,`,
		`${fieldIndent}...state.model,`,
		`${fieldIndent}onEdit: (text) => {`,
		`${inner}props.edit("model", text);`,
		`${fieldIndent}},`,
		`${fieldIndent}onReset: () => {`,
		`${inner}props.resetField("model");`,
		`${fieldIndent}}`,
		`${jsxIndent}}),`,
	].join(eol) + eol;

	return { site, status: 'patched', edits: [{ index: m.index, insert: block }] };
}

/* ------------------------------------------ client.js：控制器表单字段注册 */

/** 把 model 加进 CardForm 的字段列表（baseURL 与 maxUses 之间）。 */
function probeControllerForm(src) {
	const site = 'client.js 控制器：表单字段';
	if (/textField\("baseURL"\)[\s\S]{0,60}?textField\("model"\)/.test(src)) return { site, status: 'already', edits: [] };

	const m = /textField\("baseURL"\),/.exec(src);
	if (!m) return { site, status: 'anchor-missing', edits: [], detail: '未找到 textField("baseURL") 锚点' };

	return {
		site,
		status: 'patched',
		edits: [{ index: m.index, remove: m[0].length, insert: 'textField("baseURL"), textField("model"),' }],
	};
}

/* --------------------------------------------- client.js：控制器投影字段 */

/** 把 model 加进 projection() 返回给卡片的状态里。 */
function probeControllerProjection(src) {
	const site = 'client.js 控制器：投影字段';
	if (src.includes('this.form.field("model")')) return { site, status: 'already', edits: [] };

	const m = /^([ \t]*)baseURL: this\.form\.field\("baseURL"\),[ \t]*$/m.exec(src);
	if (!m) return { site, status: 'anchor-missing', edits: [], detail: '未找到 form.field("baseURL") 投影锚点' };

	const eol = detectEol(src);
	return {
		site,
		status: 'patched',
		edits: [{ index: m.index + m[0].length, insert: eol + `${m[1]}model: this.form.field("model"),` }],
	};
}

/* ---------------------------------------------------- client.js：多语言文案 */

/** 在每个 webSearchBaseUrlHint 之后补上 Model 的标题与提示（按语种自动选文案）。 */
function probeLocales(src) {
	const site = 'client.js 文案：en + zh';
	const eol = detectEol(src);
	const re = /^([ \t]*)webSearchBaseUrlHint:.*$/gm;
	const edits = [];
	const seen = [];
	let m;

	while ((m = re.exec(src)) !== null) {
		const line = m[0];
		const locale = CJK.test(line) ? 'zh' : 'en';
		const after = src.slice(m.index + line.length, m.index + line.length + 400);
		if (/webSearchModel:/.test(after)) {
			seen.push(`${locale}=已存在`);
			continue;
		}
		const table = locale === 'zh' ? ZH : EN;
		edits.push({
			index: m.index + line.length,
			insert:
				eol + `${m[1]}${table.key}: "${table.label}",` +
				eol + `${m[1]}${table.hintKey}: "${table.hint}",`,
		});
		seen.push(`${locale}=插入`);
	}

	if (seen.length === 0) return { site, status: 'anchor-missing', edits: [], detail: '未找到 webSearchBaseUrlHint 文案锚点' };
	return { site, status: edits.length > 0 ? 'patched' : 'already', edits, detail: seen.join(', ') };
}

/* ------------------------------------------------------------ 类型声明文件 */

/** web-search-card-controller.d.ts：WebSearchSettings.model / WebSearchCardState.model。 */
function probeControllerTypes(src) {
	const site = 'types/web-search-card-controller.d.ts';
	const eol = detectEol(src);
	const edits = [];

	const settings = /^([ \t]*)baseURL\?: string;[ \t]*$/m.exec(src);
	if (settings) {
		const window = src.slice(settings.index, settings.index + 240);
		if (!/model\?:/.test(window)) {
			edits.push({
				index: settings.index + settings[0].length,
				insert:
					eol + `${settings[1]}/** Anthropic-format model name; blank inherits the provider default. */` +
					eol + `${settings[1]}model?: string;`,
			});
		}
	}

	const state = /^([ \t]*)baseURL: CardFieldState;[ \t]*$/m.exec(src);
	if (state) {
		const window = src.slice(state.index, state.index + 240);
		if (!/model: CardFieldState;/.test(window)) {
			edits.push({
				index: state.index + state[0].length,
				insert:
					eol + `${state[1]}/** Anthropic-format model name. */` +
					eol + `${state[1]}model: CardFieldState;`,
			});
		}
	}

	if (!settings && !state) return { site, status: 'anchor-missing', edits: [], detail: '未找到 baseURL 类型锚点' };
	return { site, status: edits.length > 0 ? 'patched' : 'already', edits };
}

/** locales.d.ts：把两个新 key 加进 PluginsSettingsLocaleKey 联合类型。 */
function probeLocaleTypes(src) {
	const site = 'types/locales.d.ts';
	if (/'webSearchModel'/.test(src)) return { site, status: 'already', edits: [] };

	const m = /'webSearchBaseUrlHint' \|/.exec(src);
	if (!m) return { site, status: 'anchor-missing', edits: [], detail: '未找到 webSearchBaseUrlHint 类型锚点' };

	return {
		site,
		status: 'patched',
		edits: [{ index: m.index, remove: m[0].length, insert: `'webSearchBaseUrlHint' | 'webSearchModel' | 'webSearchModelHint' |` }],
	};
}

/* ------------------------------------------------------------------- 主流程 */

/**
 * 给一个 dsh-client-ui-settings-plugins 目录打补丁。
 * @param targetDir 目标包目录（含 lib/client.js）。
 * @param options.check 只检查不写入；options.log 日志回调。
 */
export function patchClientUi(targetDir, options = {}) {
	const log = options.log ?? (() => {});
	const bundlePath = join(targetDir, 'lib', 'client.js');
	const report = { target: targetDir, bundle: bundlePath, sites: [], changed: false, ok: true, errors: [], warnings: [] };

	if (!existsSync(bundlePath)) {
		report.ok = false;
		report.errors.push(`找不到客户端 bundle：${bundlePath}`);
		return report;
	}

	const source = readFileSync(bundlePath, 'utf8');
	const probes = [
		probeModelFieldBlock(source),
		probeControllerForm(source),
		probeControllerProjection(source),
		probeLocales(source),
	];

	const bundleEdits = [];
	for (const probe of probes) {
		report.sites.push({ site: probe.site, status: probe.status, detail: probe.detail });
		if (probe.status === 'anchor-missing') {
			report.ok = false;
			report.errors.push(`${probe.site}：${probe.detail ?? '锚点缺失'}`);
		}
		bundleEdits.push(...probe.edits);
	}

	if (bundleEdits.length > 0) {
		const patched = applyEdits(source, bundleEdits);
		report.changed = true;
		if (options.check) {
			log(`[check] 需要写入 lib/client.js（${bundleEdits.length} 处插入）`);
		} else {
			writeFileSync(bundlePath, patched, 'utf8');
			log(`已写入 ${bundlePath}（${bundleEdits.length} 处插入）`);
		}
	} else if (report.ok) {
		log('lib/client.js 已经是打过补丁的状态，跳过。');
	}

	// 类型声明：纯类型文件，缺失或结构不符只警告，不影响运行。
	const typeTargets = [
		['types/client/web-search-card-controller.d.ts', probeControllerTypes],
		['types/client/locales.d.ts', probeLocaleTypes],
	];
	for (const [relative, probe] of typeTargets) {
		const path = join(targetDir, 'lib', relative);
		if (!existsSync(path)) {
			report.warnings.push(`类型文件不存在，跳过：${relative}`);
			continue;
		}
		const src = readFileSync(path, 'utf8');
		const result = probe(src);
		report.sites.push({ site: result.site, status: result.status, detail: result.detail });
		if (result.status === 'anchor-missing') {
			report.warnings.push(`${result.site}：${result.detail ?? '锚点缺失'}（类型文件，已跳过）`);
			continue;
		}
		if (result.edits.length > 0) {
			report.changed = true;
			if (options.check) {
				log(`[check] 需要写入 lib/${relative}`);
			} else {
				writeFileSync(path, applyEdits(src, result.edits), 'utf8');
				log(`已写入 ${path}`);
			}
		}
	}

	return report;
}

/**
 * 兜底方案：整包覆盖（只有在目标 DSH 版本与本仓库完全一致时才安全）。
 * @param payloadDir 本仓库的 payload/client-ui 目录。
 */
export function overlayClientUi(payloadDir, targetDir, options = {}) {
	const log = options.log ?? (() => {});
	const files = [
		['lib/client.js', 'lib/client.js'],
		['lib/types/client/web-search-card-controller.d.ts', 'lib/types/client/web-search-card-controller.d.ts'],
		['lib/types/client/locales.d.ts', 'lib/types/client/locales.d.ts'],
	];
	const written = [];
	for (const [from, to] of files) {
		const src = join(payloadDir, from);
		const dst = join(targetDir, to);
		if (!existsSync(src)) continue;
		if (!options.check) {
			mkdirSync(dirname(dst), { recursive: true });
			copyFileSync(src, dst);
		}
		written.push(to);
		log(`${options.check ? '[check] 将覆盖' : '已覆盖'} ${dst}`);
	}
	return written;
}

/* --------------------------------------------------------------------- CLI */

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) {
	const args = process.argv.slice(2);
	const target = args.find((a) => !a.startsWith('--'));
	if (!target) {
		console.error('用法：node patch-client.mjs <dsh-client-ui-settings-plugins 目录> [--check] [--json]');
		process.exit(2);
	}
	const report = patchClientUi(target, { check: args.includes('--check'), log: args.includes('--json') ? () => {} : (m) => console.log(m) });
	if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
	else {
		console.log('\n补丁点状态：');
		for (const s of report.sites) console.log(`  - [${s.status}] ${s.site}${s.detail ? ` (${s.detail})` : ''}`);
		for (const w of report.warnings) console.log(`  ! ${w}`);
		for (const e of report.errors) console.error(`  x ${e}`);
	}
	process.exit(report.ok ? 0 : 1);
}

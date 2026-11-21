import path from 'node:path';
import { color } from './utils.js';
const EXT_LANG = {
    txt: 'text', text: 'text', log: 'log', md: 'markdown', markdown: 'markdown',
    json: 'json', jsonl: 'json', ipynb: 'json',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', pyw: 'python',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', env: 'shell',
    c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', java: 'c',
    go: 'go', rs: 'rust', rb: 'python', pl: 'python', lua: 'python',
    html: 'html', htm: 'html', xml: 'html', svg: 'html',
    css: 'css', scss: 'css', less: 'css',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'toml', conf: 'toml',
    sql: 'sql', diff: 'diff', patch: 'diff',
};
const KEYWORDS = {
    javascript: new Set('await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async get set'.split(' ')),
    typescript: new Set('abstract any as asserts async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of override private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case'.split(' ')),
    shell: new Set('if then else elif fi for while in do done case esac function return export local readonly declare unset shift source alias set trap true false'.split(' ')),
    c: new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected namespace template typename using new delete nullptr true false'.split(' ')),
    go: new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'.split(' ')),
    rust: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
    css: new Set('important media supports keyframes import font-face'.split(' ')),
    sql: new Set('select from where insert into update delete create table drop alter add index view join inner left right outer on as and or not null order by group having limit offset values set union all distinct case when then else end'.split(' ')),
};
export function languageFromPath(filePath) {
    const name = path.basename(filePath).toLowerCase();
    if (name === 'dockerfile' || name === 'makefile')
        return 'shell';
    if (name.startsWith('.env'))
        return 'shell';
    if (name.endsWith('rc'))
        return 'shell';
    const ext = path.extname(name).replace('.', '');
    return EXT_LANG[ext] ?? 'text';
}
function paint(text, palette, opts) {
    if (text === '')
        return '';
    return color(text, {
        fg: opts.fg ?? palette.fg,
        bold: opts.bold,
        dim: opts.dim,
        italic: opts.italic,
        underline: opts.underline,
    });
}
function highlightMarkdown(line, palette) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
        return paint(heading[1] + ' ' + heading[2], palette, { fg: palette.cyan, bold: true });
    }
    if (/^\s*```/.test(line))
        return paint(line, palette, { fg: palette.purple });
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        return line.replace(/^(\s*)([-*+]|\d+\.)(\s+)/, (_m, space, bullet, after) => paint(space, palette, {}) + paint(bullet, palette, { fg: palette.green, bold: true }) + paint(after, palette, {})).replace(/`([^`]+)`/g, (_m, code) => paint(code, palette, { fg: palette.yellow }));
    }
    if (/^\s*>/.test(line))
        return paint(line, palette, { fg: palette.muted, italic: true });
    return line
        .replace(/`([^`]+)`/g, (_m, code) => paint(code, palette, { fg: palette.yellow }))
        .replace(/\*\*([^*]+)\*\*/g, (_m, text) => paint(text, palette, { fg: palette.fg, bold: true }))
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => paint(text, palette, { fg: palette.accent, underline: true }) + paint(` (${url})`, palette, { fg: palette.dim }));
}
function highlightJson(line, palette) {
    return line.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (match, str, colon, literal) => {
        if (str !== undefined) {
            if (colon !== undefined) {
                return paint(str, palette, { fg: palette.cyan }) + paint(colon, palette, { fg: palette.dim });
            }
            return paint(str, palette, { fg: palette.green });
        }
        if (literal !== undefined)
            return paint(match, palette, { fg: palette.purple, bold: true });
        return paint(match, palette, { fg: palette.orange });
    });
}
function highlightDiff(line, palette) {
    if (line.startsWith('+++') || line.startsWith('---'))
        return paint(line, palette, { fg: palette.muted, bold: true });
    if (line.startsWith('@@'))
        return paint(line, palette, { fg: palette.cyan });
    if (line.startsWith('+'))
        return paint(line, palette, { fg: palette.green });
    if (line.startsWith('-'))
        return paint(line, palette, { fg: palette.red });
    return paint(line, palette, {});
}
function highlightCode(line, language, palette) {
    const keywords = KEYWORDS[language] ?? KEYWORDS.javascript;
    const commentMarkers = [];
    if (language === 'javascript' || language === 'typescript' || language === 'c' || language === 'go' || language === 'rust') {
        commentMarkers.push('//');
    }
    if (language === 'python' || language === 'shell' || language === 'yaml' || language === 'toml' || language === 'sql') {
        commentMarkers.push('#');
    }
    if (language === 'c' || language === 'go' || language === 'rust') {
        commentMarkers.push('/*');
    }
    let out = '';
    let index = 0;
    while (index < line.length) {
        const rest = line.slice(index);
        const comment = commentMarkers.find((marker) => rest.startsWith(marker));
        if (comment) {
            out += paint(rest, palette, { fg: palette.dim, italic: true });
            break;
        }
        const char = line[index] ?? '';
        if (char === '"' || char === "'" || char === '`') {
            let end = index + 1;
            while (end < line.length) {
                if (line[end] === '\\') {
                    end += 2;
                    continue;
                }
                if (line[end] === char) {
                    end += 1;
                    break;
                }
                end += 1;
            }
            out += paint(line.slice(index, end), palette, { fg: palette.green });
            index = end;
            continue;
        }
        if (/[0-9]/.test(char)) {
            const match = /^0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
            if (match) {
                out += paint(match[0], palette, { fg: palette.orange });
                index += match[0].length;
                continue;
            }
        }
        if (/[A-Za-z_$]/.test(char)) {
            const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
            if (match) {
                const word = match[0];
                const after = rest.slice(word.length).trimStart();
                const isFunction = after.startsWith('(');
                if (keywords.has(word.toLowerCase())) {
                    out += paint(word, palette, { fg: palette.purple, bold: true });
                }
                else if (isFunction) {
                    out += paint(word, palette, { fg: palette.accent, bold: true });
                }
                else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) {
                    out += paint(word, palette, { fg: palette.cyan });
                }
                else {
                    out += paint(word, palette, {});
                }
                index += word.length;
                continue;
            }
        }
        if (/[\s]/.test(char)) {
            let end = index + 1;
            while (end < line.length && /\s/.test(line[end] ?? ''))
                end += 1;
            out += line.slice(index, end);
            index = end;
            continue;
        }
        if ('{}[]()'.includes(char)) {
            out += paint(char, palette, { fg: palette.yellow });
            index += 1;
        }
        else if ('=+-*/%<>!&|:;,.?'.includes(char)) {
            out += paint(char, palette, { fg: palette.muted });
            index += 1;
        }
        else {
            const codePoint = line.codePointAt(index) ?? 0;
            const glyph = String.fromCodePoint(codePoint);
            out += paint(glyph, palette, {});
            index += glyph.length;
        }
    }
    return out;
}
export function highlightLine(line, language, palette) {
    const clean = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    switch (language) {
        case 'markdown':
            return highlightMarkdown(clean, palette);
        case 'json':
            return highlightJson(clean, palette);
        case 'diff':
            return highlightDiff(clean, palette);
        case 'yaml':
        case 'toml':
            return clean.replace(/^(\s*[\w."'-]+)(\s*[:=]\s*)(.*)$/, (_m, key, sep, value) => paint(key, palette, { fg: palette.cyan }) + paint(sep, palette, { fg: palette.dim }) + paint(value, palette, { fg: palette.fg }));
        case 'html':
            return clean
                .replace(/(&lt;\/?)([\w:-]+)/g, (_m, open, tag) => paint(open, palette, { fg: palette.dim }) + paint(tag, palette, { fg: palette.cyan }))
                .replace(/([\w:-]+)=(&quot;.*?&quot;|".*?")/g, (_m, attr, value) => paint(attr, palette, { fg: palette.yellow }) + '=' + paint(value, palette, { fg: palette.green }));
        case 'log':
            if (/\b(error|fail|fatal|panic)\b/i.test(clean))
                return paint(clean, palette, { fg: palette.red });
            if (/\b(warn|warning)\b/i.test(clean))
                return paint(clean, palette, { fg: palette.yellow });
            if (/\b(info|debug|ok|success)\b/i.test(clean))
                return paint(clean, palette, { fg: palette.green });
            return paint(clean, palette, {});
        case 'text':
            return paint(clean, palette, {});
        default:
            return highlightCode(clean, language, palette);
    }
}

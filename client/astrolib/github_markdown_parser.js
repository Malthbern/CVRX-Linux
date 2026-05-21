// Markdown parser tuned for GitHub release notes.
//
// Aims to be close enough to GitHub-flavored Markdown that the updater
// modal renders releases the same way the GitHub releases page does.
// Handles: HTML comment stripping, fenced code blocks, ATX headers, lists
// (with nesting + task-list checkboxes), blockquotes, horizontal rules,
// paragraphs (multi-line joined into one), inline code (protected from
// other transforms), bold / italic / strikethrough, images, links, bare
// URL autolinking, `#NNN` issue/PR references, and `@user` mentions.

const DEFAULT_REPO = 'AstroDogeDX/CVRX';

export function parseMarkdown(text, options = {}) {
    if (!text) return '';

    const repo = options.repo || DEFAULT_REPO;
    const repoUrl = `https://github.com/${repo}`;

    // 1. Normalize newlines and strip HTML comments (the kind that
    //    Release Drafter / contributors leave in release bodies).
    let src = text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');

    const blocks = parseBlocks(src);
    return blocks.map(b => renderBlock(b, { repoUrl })).join('\n');
}

// ---------- Block parsing ----------

function parseBlocks(src) {
    const lines = src.split('\n');
    const blocks = [];
    let i = 0;

    const isListLine = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
    const isBlankLine = (l) => l.trim() === '';
    const isIndentedContinuation = (l) => /^\s+\S/.test(l);

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Blank line — block separator.
        if (!trimmed) { i++; continue; }

        // Fenced code block: ```lang ... ```
        const fence = trimmed.match(/^```(.*)$/);
        if (fence) {
            const lang = fence[1].trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            if (i < lines.length) i++; // consume closing fence
            blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
            continue;
        }

        // Horizontal rule.
        if (/^[-*_]{3,}\s*$/.test(trimmed)) {
            blocks.push({ type: 'hr' });
            i++;
            continue;
        }

        // ATX header (# ... ######), trailing #s optional.
        const header = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (header) {
            blocks.push({ type: 'header', level: header[1].length, content: header[2] });
            i++;
            continue;
        }

        // List (ordered or unordered). Collect until a non-list, non-indented
        // line that isn't a blank-followed-by-continuation pattern.
        if (isListLine(line)) {
            const listLines = [];
            while (i < lines.length) {
                const l = lines[i];
                if (isBlankLine(l)) {
                    // Blank line is part of the list iff the NEXT line is a
                    // list item or an indented continuation.
                    const next = lines[i + 1];
                    if (next !== undefined && (isListLine(next) || isIndentedContinuation(next))) {
                        listLines.push(l);
                        i++;
                        continue;
                    }
                    break;
                }
                if (isListLine(l) || isIndentedContinuation(l)) {
                    listLines.push(l);
                    i++;
                } else {
                    break;
                }
            }
            blocks.push({ type: 'list', lines: listLines });
            continue;
        }

        // Blockquote — consecutive '>'-prefixed lines.
        if (trimmed.startsWith('>')) {
            const quoteLines = [];
            while (i < lines.length && lines[i].trim().startsWith('>')) {
                quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
                i++;
            }
            blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
            continue;
        }

        // Paragraph — gather consecutive non-blank, non-special lines.
        const paraLines = [];
        while (i < lines.length) {
            const l = lines[i];
            const t = l.trim();
            if (!t) break;
            if (/^#{1,6}\s+/.test(t)) break;
            if (/^```/.test(t)) break;
            if (/^[-*_]{3,}\s*$/.test(t)) break;
            if (isListLine(l)) break;
            if (t.startsWith('>')) break;
            paraLines.push(t);
            i++;
        }
        blocks.push({ type: 'paragraph', content: paraLines.join(' ') });
    }

    return blocks;
}

// ---------- Block rendering ----------

function renderBlock(block, ctx) {
    switch (block.type) {
        case 'code': {
            const langClass = block.lang ? ` class="language-${escapeAttr(block.lang)}"` : '';
            return `<pre><code${langClass}>${escapeHtml(block.content)}</code></pre>`;
        }
        case 'hr':
            return '<hr>';
        case 'header':
            return `<h${block.level}>${processInline(block.content, ctx)}</h${block.level}>`;
        case 'paragraph':
            return `<p>${processInline(block.content, ctx)}</p>`;
        case 'blockquote':
            return `<blockquote>${processInline(block.content, ctx)}</blockquote>`;
        case 'list':
            return renderList(block.lines, ctx);
        default:
            return '';
    }
}

// ---------- Lists (with nesting) ----------

function renderList(listLines, ctx) {
    // Step 1: turn raw lines into a flat sequence of items, attaching any
    // continuation lines to the preceding item.
    const items = [];
    let current = null;
    let minIndent = Infinity;

    for (const raw of listLines) {
        const m = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (m) {
            const indent = m[1].length;
            minIndent = Math.min(minIndent, indent);
            current = {
                indent,
                ordered: /^\d+\.$/.test(m[2]),
                content: m[3],
                children: [],
            };
            items.push(current);
        } else if (current && raw.trim()) {
            current.content += ' ' + raw.trim();
        }
    }

    if (!items.length) return '';

    // Normalize indent so the shallowest items sit at 0.
    for (const it of items) it.indent -= minIndent;

    // Step 2: build a tree from the indent levels.
    const root = { indent: -1, children: [] };
    const stack = [root];
    for (const it of items) {
        while (stack.length > 1 && stack[stack.length - 1].indent >= it.indent) {
            stack.pop();
        }
        stack[stack.length - 1].children.push(it);
        stack.push(it);
    }

    // Step 3: render. List type is determined by the first child at each level.
    return renderListNode(root.children, ctx);
}

function renderListNode(children, ctx) {
    if (!children.length) return '';
    const tag = children[0].ordered ? 'ol' : 'ul';
    const items = children.map(c => {
        const taskMatch = c.content.match(/^\[([ xX])\]\s+(.*)$/);
        const childrenHtml = renderListNode(c.children, ctx);
        if (taskMatch) {
            const checked = taskMatch[1].toLowerCase() === 'x' ? ' checked' : '';
            return `<li class="task-list-item"><input type="checkbox"${checked} disabled> ${processInline(taskMatch[2], ctx)}${childrenHtml}</li>`;
        }
        return `<li>${processInline(c.content, ctx)}${childrenHtml}</li>`;
    }).join('');
    return `<${tag}>${items}</${tag}>`;
}

// ---------- Inline rendering ----------

function processInline(str, ctx) {
    // 1. Extract inline code spans so other inline transforms ignore them.
    //    They get re-injected at the very end, already HTML-escaped.
    const codeSpans = [];
    let s = str.replace(/`+([^`\n]+?)`+/g, (_m, code) => {
        codeSpans.push(escapeHtml(code));
        return ` CODE${codeSpans.length - 1} `;
    });

    // 2. Pull out [text](url) and ![alt](url) BEFORE escaping so URLs aren't
    //    mangled by escapeHtml. Stash the rendered HTML in a placeholder.
    const tokens = [];
    const stash = (html) => {
        tokens.push(html);
        return ` TOK${tokens.length - 1} `;
    };

    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) =>
        stash(`<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}">`)
    );

    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text, url) =>
        stash(`<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`)
    );

    // 3. Bare-URL autolink — wrap before HTML-escaping so the URL stays clean.
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, (_m, p, url) =>
        `${p}${stash(`<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)}`
    );

    // 4. Escape everything else.
    s = escapeHtml(s);

    // 5. Bold / italic / strikethrough. Asterisk variants are word-boundary
    //    safe (the regex requires no surrounding word char), so `snake_case`
    //    and `2*3*4` are left alone.
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w_])__([^_\n]+?)__(?=[^\w_]|$)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

    // 6. GitHub-style references: #123 (issue/PR) and @user (profile).
    s = s.replace(/(^|[^\w&])#(\d+)\b/g, (_m, p, n) =>
        `${p}<a href="${ctx.repoUrl}/issues/${n}" target="_blank" rel="noopener noreferrer">#${n}</a>`
    );
    s = s.replace(/(^|[^\w@])@([a-zA-Z0-9][a-zA-Z0-9-]*)\b/g, (_m, p, u) =>
        `${p}<a href="https://github.com/${u}" target="_blank" rel="noopener noreferrer">@${u}</a>`
    );

    // 7. Restore link/image tokens, then inline code.
    s = s.replace(/ TOK(\d+) /g, (_m, idx) => tokens[Number(idx)]);
    s = s.replace(/ CODE(\d+) /g, (_m, idx) => `<code>${codeSpans[Number(idx)]}</code>`);

    return s;
}

// ---------- Escaping helpers ----------

function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

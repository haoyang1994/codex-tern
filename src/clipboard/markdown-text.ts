interface ListItem {
  index: number;
  depth: number;
  ordered: boolean;
  start?: number;
  checked?: boolean;
}

type Block = (children: string) => string;
interface PlainRenderCallbacks {
  heading: Block;
  paragraph: Block;
  code: Block;
  html: Block;
  hr: Block;
  list: (children: string, list: { depth: number }) => string;
  listItem: (children: string, item: ListItem) => string;
  table: Block;
  tr: Block;
  th: Block;
  td: Block;
}

const { Bun } = globalThis as typeof globalThis & {
  Bun: { markdown: { render(source: string, callbacks: PlainRenderCallbacks): string } };
};

const block = (children: string) => children + '\n\n';
const cell = (children: string) => children + '\t';

/** Render the Markdown already passed to Tern, including resolved file citations. */
export function markdownText(source: string): string {
  const text = Bun.markdown.render(source, {
    heading: block,
    paragraph: block,
    code: block,
    html: block,
    hr: () => '',
    list: (children, { depth }) => depth ? '\n' + children.slice(0, -1) : children + '\n',
    listItem: (children, { index, depth, ordered, start, checked }) => {
      const marker = ordered ? `${(start ?? 1) + index}.` : '•';
      const task = checked === undefined ? '' : checked ? '☑ ' : '☐ ';
      const indent = '   '.repeat(depth);
      return `${indent}${marker} ${task}${children.replace(/\n\n$/, '')}\n`;
    },
    table: children => children + '\n',
    tr: children => children.slice(0, -1) + '\n',
    th: cell,
    td: cell,
  });
  // Remove the renderer's final separator without trimming code whitespace.
  return text.replace(/\n\n$/, '');
}

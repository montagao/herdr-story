import MarkdownIt from 'markdown-it';

// Saved agent output is untrusted text. Never enable embedded HTML.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.validateLink = url => /^(https?:\/\/|mailto:)/i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// Keep referenced images available without loading remote media into the journal.
markdown.renderer.rules.image = (tokens, index, _options, _env, renderer) => {
  const token = tokens[index];
  const label = renderer.renderInlineAsText(token.children ?? [], _options, _env) || 'Open image';
  return `<a href="${markdown.utils.escapeHtml(String(token.attrGet('src') ?? ''))}" target="_blank" rel="noopener noreferrer">${markdown.utils.escapeHtml(label)}</a>`;
};

export function renderMarkdown(text: string): string { return markdown.render(text); }

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerDraft } from '../../../src/web/components/Composer';
import { ModeBadge } from '../../../src/web/components/RoomHeader';
import { SafeMarkdown } from '../../../src/web/components/SafeMarkdown';
import { message, snapshot, turn } from './fixtures';

describe('SafeMarkdown', () => {
  it('drops raw HTML, neutralises javascript: links and never loads images', () => {
    const { container } = render(
      <SafeMarkdown
        text={'<script>bad()</script>\n\nText <b onclick="x">bold</b> [go](javascript:alert(1)) ![alt](https://x.invalid/a.png) **ok** [docs](https://example.com)'}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container).not.toHaveTextContent('bad()');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('[image: alt]')).toBeInTheDocument();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByText('go')).toHaveClass('md-unsafe-link');
    expect(screen.getByText('ok').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });
});

describe('ModeBadge', () => {
  it('labels demo rooms as simulated', () => {
    render(<ModeBadge mode="demo" />);
    expect(screen.getByTestId('mode-badge')).toHaveTextContent('Simulated');
  });
});

describe('Composer', () => {
  function setup(draft: ComposerDraft, view = snapshot()) {
    const onDraftChange = vi.fn();
    render(<Composer snapshot={view} draft={draft} onDraftChange={onDraftChange} onSent={vi.fn()} focusToken={0} />);
    return { onDraftChange };
  }

  it('says when a message starts work versus adds context', () => {
    setup({ body: '@claude go', recipient: null, replyTo: null });
    expect(screen.getByTestId('composer-hint')).toHaveTextContent('Starts work: queues a turn for Claude');
  });

  it('does not claim mid-turn steering while an agent is running', () => {
    setup(
      { body: 'note', recipient: null, replyTo: null },
      snapshot({ turns: [turn({ agent: 'codex', status: 'running' })] }),
    );
    expect(screen.getByTestId('composer-hint')).toHaveTextContent('delivered on a later turn, not injected into the current one');
  });

  it('locks the recipient while answering a question', () => {
    const question = message({ author: 'codex', kind: 'question', body: 'Which Node?' });
    setup({ body: '24', recipient: null, replyTo: question }, snapshot({ messages: [question] }));
    expect(screen.getByLabelText('Recipient')).toBeDisabled();
    expect(screen.getByTestId('composer-hint')).toHaveTextContent("Answers Codex's question");
  });

  it('disables send for ambiguous mentions', async () => {
    const { onDraftChange } = setup({ body: '@claude @codex', recipient: null, replyTo: null });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Message'), '!');
    expect(onDraftChange).toHaveBeenCalled();
  });
});
